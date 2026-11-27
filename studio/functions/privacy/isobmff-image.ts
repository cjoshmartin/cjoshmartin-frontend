/**
 * AVIF and other HEIF (ISO base media) images: removes the metadata items (Exif, XMP and any other
 * `mime` item, `uri ` items), unknown boxes in `meta`, top-level `uuid` and unknown boxes, `udta`
 * and `meta` boxes inside `moov` (image sequences), the creation times of image sequences and any
 * data left in `free` boxes. The orientation of these formats is the `irot`/`imir` item properties,
 * kept with every other property (colour `colr`, ICC, size, HDR) byte for byte.
 *
 * Nothing that the image data is located by moves: the rebuilt `meta` box is followed by a `free`
 * box that pads it to its old size, removed boxes elsewhere become `free` boxes of the same size,
 * and the bytes of removed items are overwritten with zeros. So every `iloc` offset and every
 * sample offset stays valid and the coded image is untouched.
 */
import {concat, ImageStripError, summarizeExif} from './exif'
import type {ImageAnalysis, ImageFormat, RemovedItem} from './image-format'

interface Box {
  type: string
  start: number
  end: number
  /** Header length (8, 16 with a 64-bit size, plus 16 for a `uuid` user type). */
  headerSize: number
  payloadStart: number
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIF_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'mif2', 'miaf'])

/** Children of `meta` that describe or hold the image. Anything else is removed. */
const KEPT_META_BOXES = new Set(['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat', 'dinf', 'grpl', 'ipro'])

/** Item types that are metadata, not image data. */
const METADATA_ITEM_TYPES = new Set(['Exif', 'mime', 'uri '])

/** Track handlers an image sequence may have (images, alpha/depth auxiliaries, audio). */
const SEQUENCE_HANDLERS = new Set(['pict', 'vide', 'auxv', 'soun'])

class Reader {
  readonly view: DataView
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  need(offset: number, length: number, end: number): void {
    if (offset < 0 || offset + length > end) throw new ImageStripError(`HEIF structure is truncated at byte ${offset}`)
  }
  u8(o: number): number {
    this.need(o, 1, this.bytes.length)
    return this.bytes[o]
  }
  u16(o: number): number {
    this.need(o, 2, this.bytes.length)
    return this.view.getUint16(o)
  }
  u32(o: number): number {
    this.need(o, 4, this.bytes.length)
    return this.view.getUint32(o)
  }
  u64(o: number): number {
    this.need(o, 8, this.bytes.length)
    const value = this.view.getBigUint64(o)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ImageStripError('HEIF offset is too large')
    return Number(value)
  }
  /** Unsigned integer of 0, 4 or 8 bytes (iloc field sizes). */
  uN(o: number, size: number): number {
    if (size === 0) return 0
    if (size === 4) return this.u32(o)
    if (size === 8) return this.u64(o)
    throw new ImageStripError(`HEIF iloc field size ${size} is not 0, 4 or 8`)
  }
  fourcc(o: number): string {
    this.need(o, 4, this.bytes.length)
    return String.fromCharCode(...this.bytes.subarray(o, o + 4))
  }
  /** A NUL-terminated string starting at `o` (before `end`): its text and the offset after the NUL. */
  cstring(o: number, end: number): {text: string; next: number} {
    let p = o
    while (p < end && this.bytes[p] !== 0) p++
    const text = new TextDecoder().decode(this.bytes.subarray(o, p))
    return {text, next: Math.min(p + 1, end)}
  }
  boxes(start: number, end: number): Box[] {
    const boxes: Box[] = []
    let pos = start
    while (pos < end) {
      this.need(pos, 8, end)
      let size = this.u32(pos)
      const type = this.fourcc(pos + 4)
      let headerSize = 8
      if (size === 1) {
        this.need(pos, 16, end)
        size = this.u64(pos + 8)
        headerSize = 16
      } else if (size === 0) {
        size = end - pos
      }
      if (type === 'uuid') headerSize += 16
      if (size < headerSize || pos + size > end) {
        throw new ImageStripError(`HEIF box ${JSON.stringify(type)} at byte ${pos} has an invalid size`)
      }
      boxes.push({type, start: pos, end: pos + size, headerSize, payloadStart: pos + headerSize})
      pos += size
    }
    return boxes
  }
}

interface Extent {
  offset: number
  length: number
}

interface Item {
  id: number
  type: string
  name: string
  contentType?: string
  /** Bytes of the item's iloc entry, copied as they are when the item is kept. */
  ilocEntry?: {start: number; end: number}
  constructionMethod: number
  /** Absolute ranges in the file (construction method 0) or in the idat payload (method 1). */
  extents: Extent[]
}

function boxBytes(type: string, payload: Uint8Array, fullBoxHeader?: Uint8Array): Uint8Array {
  const body = fullBoxHeader ? concat([fullBoxHeader, payload]) : payload
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(body, 8)
  return out
}

function freeBox(size: number): Uint8Array {
  if (size === 0) return new Uint8Array(0)
  if (size < 8) throw new ImageStripError(`cannot pad the rebuilt meta box by ${size} bytes`)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  out.set(new TextEncoder().encode('free'), 4)
  return out
}

export function analyzeIsobmffImage(bytes: Uint8Array): ImageAnalysis {
  const r = new Reader(bytes)
  const top = r.boxes(0, bytes.length)
  const ftyp = top[0]
  if (ftyp?.type !== 'ftyp') throw new ImageStripError('not an ISO base media file (no ftyp)')
  const brands = [r.fourcc(ftyp.payloadStart)]
  for (let p = ftyp.payloadStart + 8; p + 4 <= ftyp.end; p += 4) brands.push(r.fourcc(p))
  if (!brands.some((b) => HEIF_BRANDS.has(b))) {
    throw new ImageStripError(`not an AVIF or HEIF image (brands ${brands.join(', ')})`)
  }
  const format: ImageFormat = brands.some((b) => AVIF_BRANDS.has(b)) ? 'avif' : 'heif'
  const metas = top.filter((b) => b.type === 'meta')
  if (metas.length !== 1) throw new ImageStripError(`HEIF file has ${metas.length} top-level meta boxes, not 1`)
  const meta = metas[0]
  const metaChildren = r.boxes(meta.payloadStart + 4, meta.end)
  const child = (type: string) => metaChildren.find((b) => b.type === type)
  const removed: RemovedItem[] = []

  // --- iinf: the items and their types.
  const iinf = child('iinf')
  if (!iinf) throw new ImageStripError('HEIF meta has no iinf box')
  const iinfVersion = r.u8(iinf.payloadStart)
  const infeStart = iinf.payloadStart + 4 + (iinfVersion === 0 ? 2 : 4)
  const infes = r.boxes(infeStart, iinf.end).filter((b) => b.type === 'infe')
  const items = new Map<number, Item>()
  const infeById = new Map<number, Box>()
  for (const infe of infes) {
    const version = r.u8(infe.payloadStart)
    if (version < 2) throw new ImageStripError(`HEIF infe version ${version} is not supported`)
    let p = infe.payloadStart + 4
    const id = version === 2 ? r.u16(p) : r.u32(p)
    p += version === 2 ? 2 : 4
    p += 2 // item_protection_index
    const type = r.fourcc(p)
    p += 4
    const name = r.cstring(p, infe.end)
    let contentType: string | undefined
    if (type === 'mime') contentType = r.cstring(name.next, infe.end).text
    items.set(id, {id, type, name: name.text, contentType, constructionMethod: 0, extents: []})
    infeById.set(id, infe)
  }

  // --- iloc: where each item's data is.
  const iloc = child('iloc')
  if (!iloc) throw new ImageStripError('HEIF meta has no iloc box')
  const ilocVersion = r.u8(iloc.payloadStart)
  if (ilocVersion > 2) throw new ImageStripError(`HEIF iloc version ${ilocVersion} is not supported`)
  let p = iloc.payloadStart + 4
  const sizes1 = r.u8(p)
  const sizes2 = r.u8(p + 1)
  const offsetSize = sizes1 >> 4
  const lengthSize = sizes1 & 15
  const baseOffsetSize = sizes2 >> 4
  const indexSize = ilocVersion === 1 || ilocVersion === 2 ? sizes2 & 15 : 0
  p += 2
  const ilocCount = ilocVersion < 2 ? r.u16(p) : r.u32(p)
  p += ilocVersion < 2 ? 2 : 4
  const idat = child('idat')
  for (let i = 0; i < ilocCount; i++) {
    const entryStart = p
    const id = ilocVersion < 2 ? r.u16(p) : r.u32(p)
    p += ilocVersion < 2 ? 2 : 4
    let constructionMethod = 0
    if (ilocVersion === 1 || ilocVersion === 2) {
      constructionMethod = r.u16(p) & 15
      p += 2
    }
    const dataReferenceIndex = r.u16(p)
    p += 2
    const baseOffset = r.uN(p, baseOffsetSize)
    p += baseOffsetSize
    const extentCount = r.u16(p)
    p += 2
    const extents: Extent[] = []
    for (let e = 0; e < extentCount; e++) {
      p += indexSize
      const offset = r.uN(p, offsetSize)
      p += offsetSize
      const length = r.uN(p, lengthSize)
      p += lengthSize
      extents.push({offset: baseOffset + offset, length})
    }
    if (p > iloc.end) throw new ImageStripError('HEIF iloc box is truncated')
    const item = items.get(id)
    if (!item) throw new ImageStripError(`HEIF iloc names item ${id}, which iinf does not list`)
    if (dataReferenceIndex !== 0) throw new ImageStripError(`HEIF item ${id} is stored in another file`)
    if (constructionMethod === 2) throw new ImageStripError(`HEIF item ${id} uses construction method 2, not supported`)
    if (constructionMethod === 1 && !idat) throw new ImageStripError(`HEIF item ${id} is in idat, but there is none`)
    const regionEnd = constructionMethod === 1 ? idat!.end - idat!.payloadStart : bytes.length
    item.constructionMethod = constructionMethod
    item.extents = extents.map((x) => {
      const length = x.length === 0 && extentCount === 1 ? regionEnd - x.offset : x.length
      if (x.offset + length > regionEnd) throw new ImageStripError(`HEIF item ${id} data runs past its region`)
      return {offset: x.offset, length}
    })
    item.ilocEntry = {start: entryStart, end: p}
  }

  const itemData = (item: Item): Uint8Array => {
    const base = item.constructionMethod === 1 ? idat!.payloadStart : 0
    return concat(item.extents.map((x) => bytes.subarray(base + x.offset, base + x.offset + x.length)))
  }

  // --- Which items are metadata.
  const removedIds = new Set<number>()
  for (const item of items.values()) {
    if (!METADATA_ITEM_TYPES.has(item.type)) continue
    removedIds.add(item.id)
    if (item.type === 'Exif') {
      const data = itemData(item)
      if (data.length < 4) throw new ImageStripError(`HEIF Exif item ${item.id} is truncated`)
      const tiffOffset = 4 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0)
      const summary = summarizeExif(data.subarray(tiffOffset))
      removed.push(
        summary.personal.length > 0
          ? {what: `EXIF: ${summary.personal.join(', ')}`, personal: true}
          : {what: 'EXIF (technical tags only)', personal: false},
      )
    } else if (item.type === 'mime') {
      const xmp = /xmp|rdf\+xml/i.test(item.contentType ?? '')
      removed.push({what: xmp ? 'XMP' : `metadata item (${item.contentType || 'mime'})`, personal: true})
    } else {
      removed.push({what: 'URI metadata item', personal: true})
    }
  }
  const pitm = child('pitm')
  if (pitm) {
    const version = r.u8(pitm.payloadStart)
    const primary = version === 0 ? r.u16(pitm.payloadStart + 4) : r.u32(pitm.payloadStart + 4)
    if (removedIds.has(primary)) throw new ImageStripError('HEIF primary item is a metadata item')
  }

  // --- Rebuilt boxes without the removed items.
  const fullHeader = (box: Box) => bytes.subarray(box.payloadStart, box.payloadStart + 4)
  const rebuildIinf = (): Uint8Array => {
    const kept = infes.filter((infe) => {
      for (const [id, box] of infeById) if (box === infe) return !removedIds.has(id)
      return true
    })
    const count = new Uint8Array(iinfVersion === 0 ? 2 : 4)
    if (iinfVersion === 0) new DataView(count.buffer).setUint16(0, kept.length)
    else new DataView(count.buffer).setUint32(0, kept.length)
    return boxBytes('iinf', concat([count, ...kept.map((b) => bytes.subarray(b.start, b.end))]), fullHeader(iinf))
  }
  const rebuildIloc = (): Uint8Array => {
    const kept = [...items.values()].filter((item) => item.ilocEntry && !removedIds.has(item.id))
    kept.sort((a, b) => a.ilocEntry!.start - b.ilocEntry!.start)
    const count = new Uint8Array(ilocVersion < 2 ? 2 : 4)
    if (ilocVersion < 2) new DataView(count.buffer).setUint16(0, kept.length)
    else new DataView(count.buffer).setUint32(0, kept.length)
    return boxBytes(
      'iloc',
      concat([
        bytes.subarray(iloc.payloadStart + 4, iloc.payloadStart + 6),
        count,
        ...kept.map((item) => bytes.subarray(item.ilocEntry!.start, item.ilocEntry!.end)),
      ]),
      fullHeader(iloc),
    )
  }
  const iref = child('iref')
  const rebuildIref = (): Uint8Array | null => {
    if (!iref) return null
    const version = r.u8(iref.payloadStart)
    const idSize = version === 0 ? 2 : 4
    const readId = (o: number) => (idSize === 2 ? r.u16(o) : r.u32(o))
    const refs: Uint8Array[] = []
    for (const ref of r.boxes(iref.payloadStart + 4, iref.end)) {
      let q = ref.payloadStart
      const from = readId(q)
      q += idSize
      const count = r.u16(q)
      q += 2
      const to: number[] = []
      for (let i = 0; i < count; i++, q += idSize) to.push(readId(q))
      if (removedIds.has(from)) continue
      const keptTo = to.filter((id) => !removedIds.has(id))
      if (keptTo.length === 0) continue
      if (keptTo.length === to.length) {
        refs.push(bytes.subarray(ref.start, ref.end))
        continue
      }
      const payload = new Uint8Array(idSize + 2 + keptTo.length * idSize)
      const view = new DataView(payload.buffer)
      const writeId = (o: number, id: number) => (idSize === 2 ? view.setUint16(o, id) : view.setUint32(o, id))
      writeId(0, from)
      view.setUint16(idSize, keptTo.length)
      keptTo.forEach((id, i) => writeId(idSize + 2 + i * idSize, id))
      refs.push(boxBytes(ref.type, payload))
    }
    if (refs.length === 0) return new Uint8Array(0)
    return boxBytes('iref', concat(refs), fullHeader(iref))
  }
  const iprp = child('iprp')
  let ipco: Uint8Array | undefined
  const rebuildIprp = (): Uint8Array | null => {
    if (!iprp) return null
    const parts: Uint8Array[] = []
    for (const box of r.boxes(iprp.payloadStart, iprp.end)) {
      if (box.type !== 'ipma') {
        parts.push(bytes.subarray(box.start, box.end))
        continue
      }
      const version = r.u8(box.payloadStart)
      const flags = r.u32(box.payloadStart) & 0xffffff
      let q = box.payloadStart + 4
      const entryCount = r.u32(q)
      q += 4
      const entries: Uint8Array[] = []
      for (let i = 0; i < entryCount; i++) {
        const start = q
        const id = version < 1 ? r.u16(q) : r.u32(q)
        q += version < 1 ? 2 : 4
        const associations = r.u8(q)
        q += 1 + associations * (flags & 1 ? 2 : 1)
        if (q > box.end) throw new ImageStripError('HEIF ipma box is truncated')
        if (!removedIds.has(id)) entries.push(bytes.subarray(start, q))
      }
      const count = new Uint8Array(4)
      new DataView(count.buffer).setUint32(0, entries.length)
      parts.push(boxBytes('ipma', concat([count, ...entries]), fullHeader(box)))
    }
    return boxBytes('iprp', concat(parts))
  }
  if (iprp) {
    const box = r.boxes(iprp.payloadStart, iprp.end).find((b) => b.type === 'ipco')
    if (box) ipco = bytes.subarray(box.start, box.end)
  }

  // The removed items' data, zeroed in the output (except bytes a kept item also uses).
  const zeroRanges: Extent[] = []
  const keptRanges: Extent[] = []
  for (const item of items.values()) {
    const base = item.constructionMethod === 1 ? idat!.payloadStart : 0
    for (const x of item.extents) {
      ;(removedIds.has(item.id) ? zeroRanges : keptRanges).push({offset: base + x.offset, length: x.length})
    }
  }

  // --- Other boxes of meta.
  for (const box of metaChildren) {
    if (!KEPT_META_BOXES.has(box.type)) removed.push({what: `meta box ${JSON.stringify(box.type)}`, personal: true})
  }

  // --- Top-level boxes other than ftyp, meta and mdat; and moov of image sequences.
  /** Boxes that become `free` with a zeroed payload. */
  const freed: Box[] = []
  /** Creation and modification time fields (offset, length) to zero. */
  const times: Extent[] = []
  const walkMoov = (start: number, end: number) => {
    for (const box of r.boxes(start, end)) {
      if (box.type === 'udta' || box.type === 'meta' || box.type === 'uuid') {
        freed.push(box)
        removed.push({what: `sequence ${box.type} box`, personal: true})
      } else if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
        const version = r.u8(box.payloadStart)
        const size = version === 1 ? 8 : 4
        const field = {offset: box.payloadStart + 4, length: size * 2}
        if (bytes.subarray(field.offset, field.offset + field.length).some((b) => b !== 0)) {
          times.push(field)
          removed.push({what: `creation time (${box.type})`, personal: true})
        }
      } else if (box.type === 'trak') {
        const hdlr = r.boxes(box.payloadStart, box.end).find((b) => b.type === 'mdia')
        const handler = hdlr && r.boxes(hdlr.payloadStart, hdlr.end).find((b) => b.type === 'hdlr')
        const handlerType = handler ? r.fourcc(handler.payloadStart + 8) : ''
        if (!SEQUENCE_HANDLERS.has(handlerType)) {
          throw new ImageStripError(`image sequence has a ${JSON.stringify(handlerType)} track, which cannot be removed`)
        }
        walkMoov(box.payloadStart, box.end)
      } else if (box.type === 'mdia' || box.type === 'minf') {
        walkMoov(box.payloadStart, box.end)
      }
    }
  }
  const zeroFree: Box[] = []
  for (const box of top) {
    if (box === ftyp || box === meta || box.type === 'mdat') continue
    if (box.type === 'moov') {
      walkMoov(box.payloadStart, box.end)
    } else if (box.type === 'free' || box.type === 'skip') {
      if (bytes.subarray(box.payloadStart, box.end).some((b) => b !== 0)) {
        zeroFree.push(box)
        removed.push({what: `data left in a ${box.type} box`, personal: true})
      }
    } else {
      freed.push(box)
      removed.push({what: `top-level ${JSON.stringify(box.type)} box`, personal: true})
    }
  }

  const zeroOutside = (out: Uint8Array, range: Extent) => {
    for (let i = range.offset; i < range.offset + range.length; i++) {
      if (!keptRanges.some((k) => i >= k.offset && i < k.offset + k.length)) out[i] = 0
    }
  }
  const newMeta = (): Uint8Array => {
    const parts: Uint8Array[] = []
    for (const box of metaChildren) {
      if (!KEPT_META_BOXES.has(box.type)) continue
      if (box.type === 'iinf') parts.push(rebuildIinf())
      else if (box.type === 'iloc') parts.push(rebuildIloc())
      else if (box.type === 'iref') parts.push(rebuildIref() ?? new Uint8Array(0))
      else if (box.type === 'iprp') parts.push(rebuildIprp() ?? new Uint8Array(0))
      else if (box.type === 'idat') {
        const copy = bytes.slice(box.start, box.end)
        for (const item of items.values()) {
          if (!removedIds.has(item.id) || item.constructionMethod !== 1) continue
          for (const x of item.extents) {
            const start = box.payloadStart - box.start + x.offset
            for (let i = start; i < start + x.length; i++) {
              const absolute = box.start + i
              if (!keptRanges.some((k) => absolute >= k.offset && absolute < k.offset + k.length)) copy[i] = 0
            }
          }
        }
        parts.push(copy)
      } else parts.push(bytes.subarray(box.start, box.end))
    }
    const rebuilt = boxBytes('meta', concat(parts), fullHeader(meta))
    const oldSize = meta.end - meta.start
    if (rebuilt.length > oldSize) throw new ImageStripError('rebuilt HEIF meta box is larger than the original')
    return concat([rebuilt, freeBox(oldSize - rebuilt.length)])
  }

  /** Applies every change in place on a copy (all sizes stay the same). */
  const build = (): Uint8Array => {
    const out = bytes.slice()
    out.set(newMeta(), meta.start)
    for (const range of zeroRanges) if (range.offset >= meta.end || range.offset + range.length <= meta.start) zeroOutside(out, range)
    for (const box of freed) {
      const typeOffset = box.start + 4
      out.set(new TextEncoder().encode('free'), typeOffset)
      const payloadFrom = box.start + (box.headerSize - (box.type === 'uuid' ? 16 : 0))
      out.fill(0, payloadFrom, box.end)
    }
    for (const box of zeroFree) out.fill(0, box.payloadStart, box.end)
    for (const field of times) out.fill(0, field.offset, field.offset + field.length)
    return out
  }

  const keptItems = [...items.values()].filter((item) => !removedIds.has(item.id)).sort((a, b) => a.id - b.id)
  const imageData: Uint8Array[] = []
  if (ipco) imageData.push(ipco)
  if (pitm) imageData.push(bytes.subarray(pitm.start, pitm.end))
  const irefBytes = rebuildIref()
  if (irefBytes && irefBytes.length > 0) imageData.push(irefBytes)
  for (const item of keptItems) {
    imageData.push(new TextEncoder().encode(`${item.id}:${item.type}`), itemData(item))
  }
  // The media data and the sequence's movie box, each from this file's own bytes (never from the
  // built output, or the check would compare the output with itself): mdat with only the removed
  // items' bytes set to zero, and moov without its metadata boxes and with its creation times
  // zeroed. Stripping must leave exactly that, so an image sequence's samples or sample tables
  // touched by mistake, or a removed item's bytes left behind, make the digests differ.
  const maskedMdat = (box: Box): Uint8Array => {
    const copy = bytes.slice(box.start, box.end)
    for (const range of zeroRanges) {
      const from = Math.max(range.offset, box.start)
      const to = Math.min(range.offset + range.length, box.end)
      for (let i = from; i < to; i++) {
        if (!keptRanges.some((k) => i >= k.offset && i < k.offset + k.length)) copy[i - box.start] = 0
      }
    }
    return copy
  }
  const moovParts = (start: number, end: number, parts: Uint8Array[]) => {
    for (const box of r.boxes(start, end)) {
      if (box.type === 'udta' || box.type === 'meta' || box.type === 'uuid' || box.type === 'free' || box.type === 'skip') continue
      if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
        const copy = bytes.slice(box.start, box.end)
        const length = r.u8(box.payloadStart) === 1 ? 16 : 8
        copy.fill(0, box.payloadStart - box.start + 4, box.payloadStart - box.start + 4 + length)
        parts.push(copy)
      } else if (box.type === 'trak' || box.type === 'mdia' || box.type === 'minf') {
        parts.push(new TextEncoder().encode(`${box.type}:`))
        moovParts(box.payloadStart, box.end, parts)
      } else {
        parts.push(bytes.subarray(box.start, box.end))
      }
    }
  }
  for (const box of top) {
    if (box.type === 'mdat') imageData.push(maskedMdat(box))
    if (box.type === 'moov') {
      const parts: Uint8Array[] = []
      moovParts(box.payloadStart, box.end, parts)
      imageData.push(concat(parts))
    }
  }

  return {
    format,
    removed,
    orientation: undefined,
    icc: ipco,
    imageData,
    strip: build,
  }
}
