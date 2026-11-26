/**
 * Removes personal metadata from a QuickTime / MP4 (ISO base media) file without touching a byte of
 * its audio or video: the "stream copy" of the privacy step (src/steps/privacy.ts).
 *
 * Why not `ffmpeg -c copy`: a remux keeps the packets but rewrites the container. With ffmpeg 9.0.1
 * it dropped the Dolby Vision configuration record (dvcC/dvvC) of an iPhone HLG video and changed
 * the edit lists of an iPhone screen recording (the AAC priming packet and the last video frame were
 * no longer trimmed). Editing the boxes in place keeps everything the player uses exactly as it was:
 * sample descriptions (codec configuration, colr, Dolby Vision, ambient viewing environment), track
 * headers (the display matrix that rotates the picture), edit lists, sample tables and mdat.
 *
 * What it removes, each replaced by a `free` box of the same size whose content is zero, so no
 * size or chunk offset in the file changes:
 * - `moov/udta` and `moov/meta` (QuickTime user data, Keys and item lists: location, make, model,
 *   software, author, copyright, ...), and `udta`/`meta` inside every kept track;
 * - every track that is not video (`vide`) or audio (`soun`): timed metadata (`mebx`: location,
 *   motion, camera details), timecode, text and anything else. Their sample data in `mdat` is
 *   overwritten with zeros, so the bytes are gone, not just unreferenced;
 * - top-level `meta` and XMP `uuid` boxes;
 * - the content of existing `free`/`skip` padding boxes (zeroed; it can hold stale metadata).
 *
 * Anything it does not know (another top-level box, a fragmented file, an unknown box in `moov` or
 * in a track) is refused rather than kept, so nothing unexpected survives unexamined.
 */

/** A box (atom) of the file. Offsets are absolute byte positions. */
export interface Box {
  type: string
  start: number
  /** Header length: 8, 16 with a 64-bit size, plus 16 for a `uuid` box's extended type. */
  headerSize: number
  end: number
  /** For `uuid` boxes: the extended type as 32 hex digits. */
  uuid?: string
}

/** The XMP packet box (ISO 16684-1): uuid be7acfcb-97a9-42e8-9c71-999491e3afac. */
export const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac'

/** Track handlers that are kept: the picture and the sound. */
export const KEPT_HANDLERS: ReadonlySet<string> = new Set(['vide', 'soun'])

const TOP_LEVEL_KEPT = new Set(['ftyp', 'wide', 'mdat', 'moov'])
const PADDING = new Set(['free', 'skip'])
const MOOV_KEPT = new Set(['mvhd', 'trak', 'iods'])
const METADATA_BOXES = new Set(['udta', 'meta'])
/**
 * Track children that describe how the track plays: the header (with the display matrix), the
 * edit list, the media, track references, the track aperture (Apple clean/production aperture) and
 * the QuickTime load, input map, alternate exclude, clipping and matte settings.
 */
const TRAK_KEPT = new Set(['tkhd', 'edts', 'mdia', 'tref', 'tapt', 'load', 'imap', 'txas', 'clip', 'matt'])

export class UnsupportedFileError extends Error {}

function fourcc(buf: Buffer, at: number): string {
  return buf.toString('latin1', at, at + 4)
}

/** Parses the boxes between `start` and `end` (one level only). */
export function parseBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let at = start
  while (at < end) {
    if (end - at < 8) throw new UnsupportedFileError(`${end - at} stray bytes at ${at}, too short for a box header`)
    let size = buf.readUInt32BE(at)
    const type = fourcc(buf, at + 4)
    let headerSize = 8
    if (size === 1) {
      if (end - at < 16) throw new UnsupportedFileError(`box ${type} at ${at} has a 64-bit size but the data ends`)
      const large = buf.readBigUInt64BE(at + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnsupportedFileError(`box ${type} at ${at} is too large`)
      size = Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = end - at
    }
    let uuid: string | undefined
    if (type === 'uuid') {
      if (size < headerSize + 16) throw new UnsupportedFileError(`uuid box at ${at} is too short`)
      uuid = buf.toString('hex', at + headerSize, at + headerSize + 16)
      headerSize += 16
    }
    if (size < headerSize || at + size > end) {
      throw new UnsupportedFileError(`box ${JSON.stringify(type)} at ${at} has size ${size}, which does not fit (parent ends at ${end})`)
    }
    boxes.push({type, start: at, headerSize, end: at + size, ...(uuid ? {uuid} : {})})
    at += size
  }
  return boxes
}

function children(buf: Buffer, box: Box): Box[] {
  return parseBoxes(buf, box.start + box.headerSize, box.end)
}

function only(boxes: Box[], type: string, where: string): Box {
  const found = boxes.filter((b) => b.type === type)
  if (found.length !== 1) throw new UnsupportedFileError(`${where}: expected one ${type} box, found ${found.length}`)
  return found[0]!
}

function optional(boxes: Box[], type: string, where: string): Box | undefined {
  const found = boxes.filter((b) => b.type === type)
  if (found.length > 1) throw new UnsupportedFileError(`${where}: expected at most one ${type} box, found ${found.length}`)
  return found[0]
}

/** The handler type of a track (`mdia/hdlr`), e.g. "vide", "soun", "meta", "tmcd". */
export function trackHandler(buf: Buffer, trak: Box): string {
  const mdia = only(children(buf, trak), 'mdia', 'trak')
  const hdlr = only(children(buf, mdia), 'hdlr', 'trak/mdia')
  // FullBox: version+flags (4), pre_defined / QuickTime component type (4), handler_type (4).
  if (hdlr.end - hdlr.start < hdlr.headerSize + 12) throw new UnsupportedFileError('hdlr box is too short')
  return fourcc(buf, hdlr.start + hdlr.headerSize + 8)
}

/** The track_ID from `tkhd`. */
export function trackId(buf: Buffer, trak: Box): number {
  const tkhd = only(children(buf, trak), 'tkhd', 'trak')
  const version = buf.readUInt8(tkhd.start + tkhd.headerSize)
  // version 1: creation (8) + modification (8); version 0: 4 + 4; then track_ID.
  return buf.readUInt32BE(tkhd.start + tkhd.headerSize + 4 + (version === 1 ? 16 : 8))
}

/** Byte ranges [start, end) of every chunk of a track, from its sample tables. */
export function trackChunkRanges(buf: Buffer, trak: Box): [number, number][] {
  const mdia = only(children(buf, trak), 'mdia', 'trak')
  const minf = only(children(buf, mdia), 'minf', 'trak/mdia')
  const stbl = only(children(buf, minf), 'stbl', 'trak/mdia/minf')
  const tables = children(buf, stbl)
  const where = 'trak/mdia/minf/stbl'

  const stco = optional(tables, 'stco', where)
  const co64 = optional(tables, 'co64', where)
  if (!stco === !co64) throw new UnsupportedFileError(`${where}: expected exactly one of stco and co64`)
  const offsetsBox = (stco ?? co64)!
  const offsetsAt = offsetsBox.start + offsetsBox.headerSize + 4
  const chunkCount = buf.readUInt32BE(offsetsAt)
  const offsets: number[] = []
  for (let i = 0; i < chunkCount; i++) {
    if (stco) offsets.push(buf.readUInt32BE(offsetsAt + 4 + i * 4))
    else {
      const value = buf.readBigUInt64BE(offsetsAt + 4 + i * 8)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnsupportedFileError('chunk offset too large')
      offsets.push(Number(value))
    }
  }

  const stscBox = only(tables, 'stsc', where)
  const stscAt = stscBox.start + stscBox.headerSize + 4
  const runs: {firstChunk: number; samplesPerChunk: number}[] = []
  const runCount = buf.readUInt32BE(stscAt)
  for (let i = 0; i < runCount; i++) {
    runs.push({firstChunk: buf.readUInt32BE(stscAt + 4 + i * 12), samplesPerChunk: buf.readUInt32BE(stscAt + 8 + i * 12)})
  }

  const sizes: number[] = []
  const stsz = optional(tables, 'stsz', where)
  const stz2 = optional(tables, 'stz2', where)
  if (!stsz === !stz2) throw new UnsupportedFileError(`${where}: expected exactly one of stsz and stz2`)
  let sampleCount: number
  if (stsz) {
    const at = stsz.start + stsz.headerSize + 4
    const constant = buf.readUInt32BE(at)
    sampleCount = buf.readUInt32BE(at + 4)
    for (let i = 0; i < sampleCount; i++) sizes.push(constant !== 0 ? constant : buf.readUInt32BE(at + 8 + i * 4))
  } else {
    const at = stz2!.start + stz2!.headerSize + 4
    const fieldSize = buf.readUInt8(at + 3)
    sampleCount = buf.readUInt32BE(at + 4)
    for (let i = 0; i < sampleCount; i++) {
      if (fieldSize === 16) sizes.push(buf.readUInt16BE(at + 8 + i * 2))
      else if (fieldSize === 8) sizes.push(buf.readUInt8(at + 8 + i))
      else if (fieldSize === 4) {
        const byte = buf.readUInt8(at + 8 + (i >> 1))
        sizes.push(i % 2 === 0 ? byte >> 4 : byte & 0x0f)
      } else throw new UnsupportedFileError(`stz2 field size ${fieldSize}`)
    }
  }

  const ranges: [number, number][] = []
  let sample = 0
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    let run: {firstChunk: number; samplesPerChunk: number} | undefined
    for (const r of runs) if (r.firstChunk <= chunk) run = r
    if (!run) throw new UnsupportedFileError(`${where}: chunk ${chunk} is before the first stsc entry`)
    let length = 0
    for (let i = 0; i < run.samplesPerChunk; i++) {
      if (sample >= sampleCount) throw new UnsupportedFileError(`${where}: the chunks hold more samples than stsz lists (${sampleCount})`)
      length += sizes[sample++]!
    }
    if (length > 0) ranges.push([offsets[chunk - 1]!, offsets[chunk - 1]! + length])
  }
  if (sample !== sampleCount) throw new UnsupportedFileError(`${where}: the chunks hold ${sample} samples, stsz lists ${sampleCount}`)
  return ranges
}

/** One change the stripper made, for the report (box paths and track descriptions, no values). */
export interface IsobmffRemoval {
  /** e.g. "moov/udta", "moov/trak[3] (meta, mebx)", "moov/trak[1]/meta", "free padding". */
  what: string
  bytes: number
}

export interface IsobmffStripResult {
  output: Buffer
  removals: IsobmffRemoval[]
  /** Handlers of the tracks kept, in file order. */
  keptTracks: {id: number; handler: string}[]
  /** Handlers of the tracks removed, in file order. */
  removedTracks: {id: number; handler: string; sampleEntry: string}[]
  /** Bytes of sample data overwritten with zeros (the removed tracks' chunks). */
  zeroedSampleBytes: number
  /** Every byte range [start, end) the stripper wrote to; the rest of the file is unchanged. */
  changedRanges: [number, number][]
}

/** The first sample entry type of a track (`stsd`), e.g. "hvc1", "mp4a", "mebx". */
function sampleEntryType(buf: Buffer, trak: Box): string {
  const mdia = only(children(buf, trak), 'mdia', 'trak')
  const minf = only(children(buf, mdia), 'minf', 'trak/mdia')
  const stbl = only(children(buf, minf), 'stbl', 'trak/mdia/minf')
  const stsd = only(children(buf, stbl), 'stsd', 'trak/mdia/minf/stbl')
  const count = buf.readUInt32BE(stsd.start + stsd.headerSize + 4)
  if (count === 0) return '(none)'
  return fourcc(buf, stsd.start + stsd.headerSize + 8 + 4)
}

/** Writes a `free` box of exactly the box's size over it, with zero content. */
function blank(out: Buffer, box: Box, changed: [number, number][]): void {
  changed.push([box.start, box.end])
  const size = box.end - box.start
  out.fill(0, box.start, box.end)
  if (size <= 0xffffffff) {
    out.writeUInt32BE(size, box.start)
    out.write('free', box.start + 4, 'latin1')
  } else {
    out.writeUInt32BE(1, box.start)
    out.write('free', box.start + 4, 'latin1')
    out.writeBigUInt64BE(BigInt(size), box.start + 8)
  }
}

function zeroPayload(out: Buffer, box: Box, changed: [number, number][]): number {
  changed.push([box.start + box.headerSize, box.end])
  out.fill(0, box.start + box.headerSize, box.end)
  return box.end - box.start - box.headerSize
}

/**
 * Strips `input` as described at the top of this file. Throws UnsupportedFileError for files it
 * cannot strip with certainty; the input is never changed.
 */
export function stripIsobmff(input: Buffer): IsobmffStripResult {
  const out = Buffer.from(input)
  const removals: IsobmffRemoval[] = []
  const changed: [number, number][] = []
  const top = parseBoxes(input, 0, input.length)
  const moov = only(top, 'moov', 'file')
  if (!top.some((b) => b.type === 'mdat')) throw new UnsupportedFileError('file: no mdat box')
  const mdats = top.filter((b) => b.type === 'mdat')

  for (const box of top) {
    if (TOP_LEVEL_KEPT.has(box.type)) continue
    if (PADDING.has(box.type)) {
      const bytes = zeroPayload(out, box, changed)
      if (bytes > 0) removals.push({what: `${box.type} padding (top level)`, bytes})
    } else if (box.type === 'meta' || (box.type === 'uuid' && box.uuid === XMP_UUID)) {
      blank(out, box, changed)
      removals.push({what: box.type === 'meta' ? 'meta (top level)' : 'XMP uuid (top level)', bytes: box.end - box.start})
    } else {
      throw new UnsupportedFileError(`file: unknown top-level box ${JSON.stringify(box.type)}${box.uuid ? ` (${box.uuid})` : ''}`)
    }
  }

  const keptTracks: IsobmffStripResult['keptTracks'] = []
  const removedTracks: IsobmffStripResult['removedTracks'] = []
  const keptRanges: [number, number][] = []
  const removedRanges: [number, number][] = []
  let trackIndex = 0
  for (const box of children(input, moov)) {
    if (box.type === 'trak') {
      trackIndex++
      const handler = trackHandler(input, box)
      const id = trackId(input, box)
      if (KEPT_HANDLERS.has(handler)) {
        keptTracks.push({id, handler})
        keptRanges.push(...trackChunkRanges(input, box))
        for (const child of children(input, box)) {
          if (TRAK_KEPT.has(child.type)) continue
          if (METADATA_BOXES.has(child.type)) {
            blank(out, child, changed)
            removals.push({what: `moov/trak[${trackIndex}] (${handler})/${child.type}`, bytes: child.end - child.start})
          } else if (PADDING.has(child.type)) {
            const bytes = zeroPayload(out, child, changed)
            if (bytes > 0) removals.push({what: `moov/trak[${trackIndex}] (${handler})/${child.type} padding`, bytes})
          } else {
            throw new UnsupportedFileError(`moov/trak[${trackIndex}] (${handler}): unknown box ${JSON.stringify(child.type)}`)
          }
        }
      } else {
        const entry = sampleEntryType(input, box)
        removedTracks.push({id, handler, sampleEntry: entry})
        removedRanges.push(...trackChunkRanges(input, box))
        blank(out, box, changed)
        removals.push({what: `moov/trak[${trackIndex}] (${handler}, ${entry})`, bytes: box.end - box.start})
      }
    } else if (MOOV_KEPT.has(box.type)) {
      continue
    } else if (METADATA_BOXES.has(box.type) || (box.type === 'uuid' && box.uuid === XMP_UUID)) {
      blank(out, box, changed)
      removals.push({what: `moov/${box.type === 'uuid' ? 'XMP uuid' : box.type}`, bytes: box.end - box.start})
    } else if (PADDING.has(box.type)) {
      const bytes = zeroPayload(out, box, changed)
      if (bytes > 0) removals.push({what: `moov/${box.type} padding`, bytes})
    } else {
      throw new UnsupportedFileError(`moov: unknown box ${JSON.stringify(box.type)}${box.type === 'mvex' ? ' (fragmented files are not supported)' : ''}`)
    }
  }
  if (keptTracks.length === 0) throw new UnsupportedFileError('file: no video or audio track')

  // References from kept tracks to removed ones would dangle. A kept track's `tref` that only
  // points at removed tracks (a video track's link to its timecode track, for example) goes with
  // them; one that also points at kept tracks cannot be split safely and is refused.
  const removedIds = new Set(removedTracks.map((t) => t.id))
  let keptIndex = 0
  for (const box of children(input, moov).filter((b) => b.type === 'trak')) {
    keptIndex++
    const handler = trackHandler(input, box)
    if (!KEPT_HANDLERS.has(handler)) continue
    const tref = optional(children(input, box), 'tref', 'trak')
    if (!tref) continue
    const targets: number[] = []
    for (const reference of children(input, tref)) {
      for (let at = reference.start + reference.headerSize; at + 4 <= reference.end; at += 4) targets.push(input.readUInt32BE(at))
    }
    const toRemoved = targets.filter((target) => removedIds.has(target))
    if (toRemoved.length === 0) continue
    if (toRemoved.length !== targets.length) {
      throw new UnsupportedFileError(`track ${trackId(input, box)} references the removed track(s) ${toRemoved.join(', ')} and kept ones in the same tref`)
    }
    blank(out, tref, changed)
    removals.push({what: `moov/trak[${keptIndex}] (${handler})/tref (to removed tracks ${toRemoved.join(', ')})`, bytes: tref.end - tref.start})
  }

  // The removed tracks' samples: inside an mdat, never shared with a kept track.
  const inMdat = ([s, e]: [number, number]) => mdats.some((m) => s >= m.start + m.headerSize && e <= m.end)
  let zeroedSampleBytes = 0
  for (const range of removedRanges) {
    if (!inMdat(range)) throw new UnsupportedFileError(`removed track data [${range[0]}, ${range[1]}) is not inside an mdat box`)
    if (keptRanges.some(([s, e]) => range[0] < e && s < range[1])) {
      throw new UnsupportedFileError(`removed track data [${range[0]}, ${range[1]}) overlaps a kept track's data`)
    }
    out.fill(0, range[0], range[1])
    changed.push([range[0], range[1]])
    zeroedSampleBytes += range[1] - range[0]
  }
  for (const range of keptRanges) {
    if (!inMdat(range)) throw new UnsupportedFileError(`kept track data [${range[0]}, ${range[1]}) is not inside an mdat box`)
  }
  if (zeroedSampleBytes > 0) removals.push({what: 'sample data of the removed tracks (zeroed in mdat)', bytes: zeroedSampleBytes})

  return {output: out, removals, keptTracks, removedTracks, zeroedSampleBytes, changedRanges: changed.sort((a, b) => a[0] - b[0])}
}

/** The box tree as indented lines ("moov 1234"), for inspection and tests. */
export function describeBoxes(buf: Buffer): string[] {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'tref', 'tapt'])
  const lines: string[] = []
  const visit = (boxes: Box[], depth: number) => {
    for (const box of boxes) {
      lines.push(`${'  '.repeat(depth)}${box.type}${box.uuid ? `:${box.uuid}` : ''} ${box.end - box.start}`)
      if (containers.has(box.type)) visit(children(buf, box), depth + 1)
    }
  }
  visit(parseBoxes(buf, 0, buf.length), 0)
  return lines
}

/** Whether the bytes start like an ISO base media / QuickTime file (an ftyp, moov, mdat, wide, free or skip box). */
export function looksLikeIsobmff(buf: Buffer): boolean {
  return buf.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(fourcc(buf, 4))
}

/** Every track of the file in order: its position (1-based), id, handler and first sample entry. */
export function listTracks(buf: Buffer): {index: number; id: number; handler: string; sampleEntry: string}[] {
  const moov = only(parseBoxes(buf, 0, buf.length), 'moov', 'file')
  return children(buf, moov)
    .filter((box) => box.type === 'trak')
    .map((trak, i) => ({index: i + 1, id: trackId(buf, trak), handler: trackHandler(buf, trak), sampleEntry: sampleEntryType(buf, trak)}))
}
