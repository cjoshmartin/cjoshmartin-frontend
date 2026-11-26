/**
 * TIFF: rebuilds the file with only the tags that describe how to decode and show each image
 * (size, compression, colour, strips or tiles, orientation, resolution, ICC profile...). Every
 * other tag goes: EXIF and GPS sub-IFDs, XMP, IPTC, Photoshop resources, maker notes, make, model,
 * software, dates, names, descriptions, GeoTIFF tags, private tags and sub-IFDs (preview images).
 * The pixel data (every strip or tile) is copied byte for byte; only its position in the file
 * changes, and the offsets are rewritten. Data no kept tag points to is not copied at all, so
 * nothing removed is left behind in the file. Every page (IFD) is kept.
 */
import {concat, ImageStripError, meaningfulOrientation, TAG, tagName, TiffReader, type TiffEntry} from './exif'
import type {ImageAnalysis, RemovedItem} from './image-format'

/** Tags kept byte for byte (TIFF 6.0 baseline and extension tags about the image itself). */
const KEPT_TAGS = new Set<number>([
  254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278, 279, 280, 281, 282,
  283, 284, 286, 287, 290, 291, 292, 293, 296, 297, 301, 317, 318, 319, 320, 321, 322, 323, 324,
  325, 332, 333, 334, 336, 338, 339, 340, 341, 342, 347, 529, 530, 531, 532, TAG.ICCProfile,
])

/** Dropped tags that only describe free space in the file; not personal on their own. */
const TECHNICAL_DROPS = new Set<number>([288, 289]) // FreeOffsets, FreeByteCounts

const MAX_IFDS = 10_000

interface Page {
  entries: TiffEntry[]
  /** Offsets entry (StripOffsets or TileOffsets) and its byte counts. */
  offsetsTag: number
  blocks: {offset: number; length: number}[]
}

function align(n: number): number {
  return n + (n % 2)
}

export function analyzeTiff(bytes: Uint8Array): ImageAnalysis {
  const reader = new TiffReader(bytes)
  const removed: RemovedItem[] = []
  const pages: Page[] = []
  const seen = new Set<number>()
  let orientation: number | undefined
  let icc: Uint8Array | undefined
  let next = reader.firstIfdOffset
  while (next !== 0) {
    if (seen.has(next)) throw new ImageStripError('TIFF IFD chain loops')
    if (pages.length >= MAX_IFDS) throw new ImageStripError('TIFF has too many IFDs')
    seen.add(next)
    const ifd = reader.ifd(next)
    const kept: TiffEntry[] = []
    const dropped = new Set<string>()
    for (const entry of ifd.entries) {
      if (KEPT_TAGS.has(entry.tag) && entry.byteLength > 0) {
        kept.push(entry)
        continue
      }
      if (TECHNICAL_DROPS.has(entry.tag)) {
        removed.push({what: `TIFF ${tagName(entry.tag)}`, personal: false})
      } else {
        dropped.add(entry.tag === TAG.SubIFDs ? 'SubIFDs (preview images)' : tagName(entry.tag))
      }
    }
    if (dropped.size > 0) {
      removed.push({what: `TIFF${pages.length > 0 ? ` page ${pages.length + 1}` : ''}: ${[...dropped].join(', ')}`, personal: true})
    }
    const byTag = new Map(kept.map((e) => [e.tag, e]))
    const compression = byTag.get(TAG.Compression)
    if (compression && reader.integers(compression)[0] === 6) {
      throw new ImageStripError('old-style JPEG compression in TIFF (compression 6) is not supported')
    }
    const tiled = byTag.has(TAG.TileOffsets)
    const offsetsTag = tiled ? TAG.TileOffsets : TAG.StripOffsets
    const countsTag = tiled ? TAG.TileByteCounts : TAG.StripByteCounts
    // A tiled image's strip tags (or the reverse) would point at data that is not copied.
    for (const unused of tiled ? [TAG.StripOffsets, TAG.StripByteCounts] : [TAG.TileOffsets, TAG.TileByteCounts]) {
      const index = kept.findIndex((e) => e.tag === unused)
      if (index !== -1) {
        kept.splice(index, 1)
        removed.push({what: `TIFF ${unused} (unused offsets)`, personal: false})
      }
    }
    const offsetsEntry = byTag.get(offsetsTag)
    const countsEntry = byTag.get(countsTag)
    if (!offsetsEntry || !countsEntry) throw new ImageStripError('TIFF IFD has no strip or tile offsets')
    const offsets = reader.integers(offsetsEntry)
    const counts = reader.integers(countsEntry)
    if (offsets.length !== counts.length) throw new ImageStripError('TIFF strip offsets and byte counts differ in number')
    const blocks = offsets.map((offset, i) => {
      if (offset + counts[i] > bytes.length) throw new ImageStripError('TIFF image data runs past the end of the file')
      return {offset, length: counts[i]}
    })
    if (pages.length === 0) {
      const o = byTag.get(TAG.Orientation)
      orientation = o ? meaningfulOrientation(reader.integers(o)[0]) : undefined
      const profile = byTag.get(TAG.ICCProfile)
      icc = profile ? reader.value(profile) : undefined
    }
    kept.sort((a, b) => a.tag - b.tag)
    pages.push({entries: kept, offsetsTag, blocks})
    next = ifd.next
  }
  if (pages.length === 0) throw new ImageStripError('TIFF has no image')

  const le = reader.littleEndian
  const imageData: Uint8Array[] = []
  for (const page of pages) {
    for (const entry of page.entries) {
      if (entry.tag === page.offsetsTag) continue
      const head = new Uint8Array(8)
      const view = new DataView(head.buffer)
      view.setUint16(0, entry.tag, le)
      view.setUint16(2, entry.type, le)
      view.setUint32(4, entry.count, le)
      imageData.push(head, reader.value(entry))
    }
    for (const block of page.blocks) imageData.push(bytes.subarray(block.offset, block.offset + block.length))
  }

  return {
    format: 'tiff',
    removed,
    orientation,
    icc,
    imageData,
    strip() {
      const chunks: Uint8Array[] = []
      let size = 8
      const header = new Uint8Array(8)
      const hv = new DataView(header.buffer)
      header.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0)
      hv.setUint16(2, 42, le)
      chunks.push(header)
      /** Offset fields of the previous IFD's "next IFD" pointer, patched when the next IFD is placed. */
      let previousNext: {chunk: Uint8Array; at: number} = {chunk: header, at: 4}
      for (const page of pages) {
        size = align(size)
        if (size !== chunks.reduce((n, c) => n + c.length, 0)) chunks.push(new Uint8Array(1))
        const ifdOffset = size
        new DataView(previousNext.chunk.buffer, previousNext.chunk.byteOffset).setUint32(previousNext.at, ifdOffset, le)
        const entries = page.entries
        const ifdBytes = new Uint8Array(2 + entries.length * 12 + 4)
        const iv = new DataView(ifdBytes.buffer)
        iv.setUint16(0, entries.length, le)
        let valueCursor = align(ifdOffset + ifdBytes.length)
        const values: {at: number; data: Uint8Array}[] = []
        /** Offsets entries need their own value bytes, written once the blocks are placed. */
        let offsetsValue: {at: number; inline: boolean; entryIndex: number} | undefined
        entries.forEach((entry, index) => {
          const at = 2 + index * 12
          iv.setUint16(at, entry.tag, le)
          if (entry.tag === page.offsetsTag) {
            // Always LONG: the new offsets may not fit a SHORT.
            iv.setUint16(at + 2, 4, le)
            iv.setUint32(at + 4, entry.count, le)
            const length = entry.count * 4
            if (length <= 4) offsetsValue = {at: at + 8, inline: true, entryIndex: index}
            else {
              iv.setUint32(at + 8, valueCursor, le)
              offsetsValue = {at: valueCursor, inline: false, entryIndex: index}
              values.push({at: valueCursor, data: new Uint8Array(length)})
              valueCursor = align(valueCursor + length)
            }
            return
          }
          iv.setUint16(at + 2, entry.type, le)
          iv.setUint32(at + 4, entry.count, le)
          const data = reader.value(entry)
          if (data.length <= 4) {
            ifdBytes.set(data, at + 8)
          } else {
            iv.setUint32(at + 8, valueCursor, le)
            values.push({at: valueCursor, data})
            valueCursor = align(valueCursor + data.length)
          }
        })
        // Image blocks after the values; identical blocks are stored once.
        let blockCursor = valueCursor
        const placed = new Map<string, number>()
        const newOffsets = page.blocks.map((block) => {
          const key = `${block.offset}:${block.length}`
          const existing = placed.get(key)
          if (existing !== undefined) return existing
          const at = blockCursor
          placed.set(key, at)
          values.push({at, data: bytes.subarray(block.offset, block.offset + block.length)})
          blockCursor = align(blockCursor + block.length)
          return at
        })
        if (!offsetsValue) throw new ImageStripError('TIFF offsets entry is missing')
        const offsetsBytes = new Uint8Array(newOffsets.length * 4)
        newOffsets.forEach((o, i) => new DataView(offsetsBytes.buffer).setUint32(i * 4, o, le))
        if (offsetsValue.inline) ifdBytes.set(offsetsBytes, offsetsValue.at)
        else values.find((v) => v.at === offsetsValue!.at)!.data = offsetsBytes
        if (blockCursor > 0xffffffff) throw new ImageStripError('stripped TIFF would be larger than 4 GB')

        chunks.push(ifdBytes)
        size = ifdOffset + ifdBytes.length
        values.sort((a, b) => a.at - b.at)
        for (const value of values) {
          if (value.at > size) chunks.push(new Uint8Array(value.at - size))
          chunks.push(value.data)
          size = value.at + value.data.length
        }
        previousNext = {chunk: ifdBytes, at: 2 + entries.length * 12}
      }
      return concat(chunks)
    },
  }
}
