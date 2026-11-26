/**
 * In-place removal of location and personal metadata from a QuickTime / MP4 (ISO base media) video,
 * used for every video original: by the video-to-mp4 Function (studio uploads) and by the Wagtail
 * migration's privacy step (migration/wagtail-to-sanity/src/privacy/video.ts). Pure (no network,
 * no binaries); reads through a ByteReader so a Function can plan from a file on /tmp without
 * holding the video in memory.
 *
 * Why in place and not `ffmpeg -c copy`: a remux keeps the packets but rewrites the container. With
 * ffmpeg 9.0.1 and 7.0.2 it dropped the Dolby Vision configuration record of an iPhone HLG video
 * written as QuickTime, changed the edit lists of an iPhone screen recording (the AAC priming packet
 * and the last video frame were no longer trimmed), changed a track duration and moved the time
 * stamps of packets whose decode time stamps repeat. Editing the boxes in place keeps everything
 * the player uses exactly as it was: sample descriptions (codec configuration, colour, Dolby Vision,
 * ambient viewing environment), track headers (the display matrix that rotates the picture), edit
 * lists, sample tables and every sample byte. No size or chunk offset in the file changes.
 *
 * What it removes:
 * - `moov/udta` and `moov/meta` (QuickTime user data, Keys and item lists: location, make, model,
 *   software, author, copyright, creation date, ...), `udta`/`meta` inside every kept track and its
 *   media, top-level `meta` and XMP `uuid` boxes: each becomes a `free` box of the same size with
 *   zero content;
 * - every track that is not video (`vide`) or audio (`soun`): timed metadata (`mebx`: location,
 *   motion, camera details), timecode, text and anything else: the track becomes a `free` box and
 *   its samples are overwritten with zeros;
 * - the creation and modification times of the movie (`mvhd`), its tracks (`tkhd`) and their media
 *   (`mdhd`): set to zero;
 * - every byte of `mdat` that no kept track's sample tables reference: set to zero. iOS leaves a
 *   draft movie header (`hoov`, with the location, make, model and creation date) and `moof`
 *   fragment headers inside `mdat`; no player reads them and exiftool and ffprobe do not see them,
 *   but they are in the file;
 * - the content of `free`/`skip` padding boxes (zeroed: it can hold stale metadata).
 *
 * Anything it does not know (another top-level box, a fragmented file, an unknown box in `moov`, a
 * track, its media or sample table, a track whose samples live in another file) is refused with
 * IsobmffUnsupportedError rather than kept unexamined; the Function then falls back to an ffmpeg
 * stream copy (video-strip.ts) and says so.
 *
 * A file is left as it is when nothing personal is found (planIsobmffStrip: `personal` false):
 * no metadata box with content, no data track, zero creation times and no non-zero unreferenced
 * bytes.
 */
import type {FileHandle} from 'node:fs/promises'

export class IsobmffUnsupportedError extends Error {
  override name = 'IsobmffUnsupportedError'
}

/** Random access to the bytes of a file. */
export interface ByteReader {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function bufferReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    async read(offset, length) {
      if (offset < 0 || offset + length > bytes.length) throw new RangeError(`read [${offset}, ${offset + length}) outside ${bytes.length} bytes`)
      return bytes.subarray(offset, offset + length)
    },
  }
}

export async function fileHandleReader(handle: FileHandle): Promise<ByteReader> {
  const {size} = await handle.stat()
  return {
    size,
    async read(offset, length) {
      if (offset < 0 || offset + length > size) throw new RangeError(`read [${offset}, ${offset + length}) outside ${size} bytes`)
      const buffer = new Uint8Array(length)
      let done = 0
      while (done < length) {
        const {bytesRead} = await handle.read(buffer, done, length - done, offset + done)
        if (bytesRead === 0) throw new Error(`the file ended at ${offset + done} while reading [${offset}, ${offset + length})`)
        done += bytesRead
      }
      return buffer
    },
  }
}

/** A box (atom). Offsets are absolute byte positions in the file. */
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
const METADATA_BOXES = new Set(['udta', 'meta'])
const MOOV_KEPT = new Set(['mvhd', 'trak', 'iods'])
/**
 * Track children that describe how the track plays: the header (with the display matrix), the
 * edit list, the media, track references, the track aperture (Apple clean/production aperture) and
 * the QuickTime load, input map, alternate exclude, clipping and matte settings.
 */
const TRAK_KEPT = new Set(['tkhd', 'edts', 'mdia', 'tref', 'tapt', 'load', 'imap', 'txas', 'clip', 'matt'])
/** Media children: header, handler, extended language, information. */
const MDIA_KEPT = new Set(['mdhd', 'hdlr', 'elng', 'minf'])
/** Media information children: media headers, the data handler, data information, sample table. */
const MINF_KEPT = new Set(['vmhd', 'smhd', 'gmhd', 'nmhd', 'hdlr', 'dinf', 'stbl'])
/** Sample table children (ISO/IEC 14496-12 and QuickTime). */
const STBL_KEPT = new Set([
  'stsd', 'stts', 'ctts', 'cslg', 'stss', 'stps', 'stsh', 'sdtp', 'stsc', 'stsz', 'stz2', 'stco', 'co64',
  'sgpd', 'sbgp', 'subs', 'saiz', 'saio', 'padb', 'stdp',
])

const decoder = new TextDecoder('latin1')

function fourcc(bytes: Uint8Array, at: number): string {
  return decoder.decode(bytes.subarray(at, at + 4))
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parses the boxes in `bytes` between `start` and `end` (one level). `base` is the absolute file
 * offset of `bytes[0]`, so the boxes carry absolute offsets.
 */
export function parseBoxes(bytes: Uint8Array, start: number, end: number, base = 0): Box[] {
  const v = view(bytes)
  const boxes: Box[] = []
  let at = start
  while (at < end) {
    if (end - at < 8) throw new IsobmffUnsupportedError(`${end - at} stray bytes at ${base + at}, too short for a box header`)
    let size = v.getUint32(at)
    const type = fourcc(bytes, at + 4)
    let headerSize = 8
    if (size === 1) {
      if (end - at < 16) throw new IsobmffUnsupportedError(`box ${type} at ${base + at} has a 64-bit size but the data ends`)
      const large = v.getBigUint64(at + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new IsobmffUnsupportedError(`box ${type} at ${base + at} is too large`)
      size = Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = end - at
    }
    let uuid: string | undefined
    if (type === 'uuid') {
      if (size < headerSize + 16 || at + headerSize + 16 > end) throw new IsobmffUnsupportedError(`uuid box at ${base + at} is too short`)
      uuid = hex(bytes.subarray(at + headerSize, at + headerSize + 16))
      headerSize += 16
    }
    if (size < headerSize || at + size > end) {
      throw new IsobmffUnsupportedError(`box ${JSON.stringify(type)} at ${base + at} has size ${size}, which does not fit (parent ends at ${base + end})`)
    }
    boxes.push({type, start: base + at, headerSize, end: base + at + size, ...(uuid ? {uuid} : {})})
    at += size
  }
  return boxes
}

/** The top-level boxes, read header by header (mdat is never read). */
export async function topLevelBoxes(reader: ByteReader): Promise<Box[]> {
  const boxes: Box[] = []
  let at = 0
  while (at < reader.size) {
    const length = Math.min(32, reader.size - at)
    const head = await reader.read(at, length)
    // Parse only this header: pretend the box ends where its size says, or at the end of the file.
    if (length < 8) throw new IsobmffUnsupportedError(`${length} stray bytes at ${at}, too short for a box header`)
    const v = view(head)
    let size = v.getUint32(0)
    const type = fourcc(head, 4)
    let headerSize = 8
    if (size === 1) {
      if (length < 16) throw new IsobmffUnsupportedError(`box ${type} at ${at} has a 64-bit size but the file ends`)
      const large = v.getBigUint64(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new IsobmffUnsupportedError(`box ${type} at ${at} is too large`)
      size = Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = reader.size - at
    }
    let uuid: string | undefined
    if (type === 'uuid') {
      if (length < headerSize + 16) throw new IsobmffUnsupportedError(`uuid box at ${at} is too short`)
      uuid = hex(head.subarray(headerSize, headerSize + 16))
      headerSize += 16
    }
    if (size < headerSize || at + size > reader.size) {
      throw new IsobmffUnsupportedError(`box ${JSON.stringify(type)} at ${at} has size ${size}, which does not fit in the file (${reader.size} bytes)`)
    }
    boxes.push({type, start: at, headerSize, end: at + size, ...(uuid ? {uuid} : {})})
    at += size
  }
  return boxes
}

/** Whether the first bytes look like an ISO base media / QuickTime file. */
export function looksLikeIsobmff(head: Uint8Array): boolean {
  return head.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(fourcc(head, 4))
}

/** The boxes of a box held in memory (`moov` and below), with absolute offsets. */
class BoxTree {
  constructor(
    readonly bytes: Uint8Array,
    /** Absolute offset of bytes[0]. */
    readonly base: number,
  ) {}

  children(box: Box): Box[] {
    return parseBoxes(this.bytes, box.start - this.base + box.headerSize, box.end - this.base, this.base)
  }

  only(boxes: Box[], type: string, where: string): Box {
    const found = boxes.filter((b) => b.type === type)
    if (found.length !== 1) throw new IsobmffUnsupportedError(`${where}: expected one ${type} box, found ${found.length}`)
    return found[0]
  }

  optional(boxes: Box[], type: string, where: string): Box | undefined {
    const found = boxes.filter((b) => b.type === type)
    if (found.length > 1) throw new IsobmffUnsupportedError(`${where}: expected at most one ${type} box, found ${found.length}`)
    return found[0]
  }

  /** Offset in `bytes` of an absolute position. */
  local(position: number): number {
    return position - this.base
  }

  u8(position: number): number {
    return this.bytes[this.local(position)]
  }

  u32(position: number): number {
    if (this.local(position) + 4 > this.bytes.length) throw new IsobmffUnsupportedError(`a table at ${position} runs past its box`)
    return view(this.bytes).getUint32(this.local(position))
  }

  u64(position: number): number {
    if (this.local(position) + 8 > this.bytes.length) throw new IsobmffUnsupportedError(`a table at ${position} runs past its box`)
    const value = view(this.bytes).getBigUint64(this.local(position))
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new IsobmffUnsupportedError(`a 64-bit value at ${position} is too large`)
    return Number(value)
  }

  type4(position: number): string {
    return fourcc(this.bytes, this.local(position))
  }
}

interface TrackInfo {
  index: number
  id: number
  handler: string
  sampleEntry: string
}

function trackParts(tree: BoxTree, trak: Box) {
  const kids = tree.children(trak)
  const tkhd = tree.only(kids, 'tkhd', 'trak')
  const mdia = tree.only(kids, 'mdia', 'trak')
  const mdiaKids = tree.children(mdia)
  const hdlr = tree.only(mdiaKids, 'hdlr', 'trak/mdia')
  const mdhd = tree.only(mdiaKids, 'mdhd', 'trak/mdia')
  const minf = tree.only(mdiaKids, 'minf', 'trak/mdia')
  const minfKids = tree.children(minf)
  const stbl = tree.only(minfKids, 'stbl', 'trak/mdia/minf')
  return {kids, tkhd, mdia, mdiaKids, hdlr, mdhd, minf, minfKids, stbl}
}

function trackInfo(tree: BoxTree, trak: Box, index: number): TrackInfo {
  const {tkhd, hdlr, stbl} = trackParts(tree, trak)
  // FullBox: version+flags (4), pre_defined / QuickTime component type (4), handler_type (4).
  if (hdlr.end - hdlr.start < hdlr.headerSize + 12) throw new IsobmffUnsupportedError('hdlr box is too short')
  const handler = tree.type4(hdlr.start + hdlr.headerSize + 8)
  const version = tree.u8(tkhd.start + tkhd.headerSize)
  // version 1: creation (8) + modification (8); version 0: 4 + 4; then track_ID.
  const id = tree.u32(tkhd.start + tkhd.headerSize + 4 + (version === 1 ? 16 : 8))
  const stsd = tree.only(tree.children(stbl), 'stsd', 'trak/mdia/minf/stbl')
  const count = tree.u32(stsd.start + stsd.headerSize + 4)
  const sampleEntry = count === 0 ? '(none)' : tree.type4(stsd.start + stsd.headerSize + 8 + 4)
  return {index, id, handler, sampleEntry}
}

/** Byte ranges [start, end) of every chunk of a track, from its sample tables. */
function trackChunkRanges(tree: BoxTree, stbl: Box): [number, number][] {
  const tables = tree.children(stbl)
  const where = 'trak/mdia/minf/stbl'
  const stco = tree.optional(tables, 'stco', where)
  const co64 = tree.optional(tables, 'co64', where)
  if (!stco === !co64) throw new IsobmffUnsupportedError(`${where}: expected exactly one of stco and co64`)
  const offsetsBox = (stco ?? co64)!
  const offsetsAt = offsetsBox.start + offsetsBox.headerSize + 4
  const chunkCount = tree.u32(offsetsAt)
  const offsets = new Array<number>(chunkCount)
  for (let i = 0; i < chunkCount; i++) offsets[i] = stco ? tree.u32(offsetsAt + 4 + i * 4) : tree.u64(offsetsAt + 4 + i * 8)

  const stscBox = tree.only(tables, 'stsc', where)
  const stscAt = stscBox.start + stscBox.headerSize + 4
  const runCount = tree.u32(stscAt)
  const runs: {firstChunk: number; samplesPerChunk: number}[] = []
  for (let i = 0; i < runCount; i++) {
    const run = {firstChunk: tree.u32(stscAt + 4 + i * 12), samplesPerChunk: tree.u32(stscAt + 8 + i * 12)}
    if (run.firstChunk < 1 || (runs.length > 0 && run.firstChunk <= runs[runs.length - 1].firstChunk)) {
      throw new IsobmffUnsupportedError(`${where}: stsc entries are not in increasing chunk order`)
    }
    runs.push(run)
  }

  const stsz = tree.optional(tables, 'stsz', where)
  const stz2 = tree.optional(tables, 'stz2', where)
  if (!stsz === !stz2) throw new IsobmffUnsupportedError(`${where}: expected exactly one of stsz and stz2`)
  let sampleCount: number
  let sizeOf: (sample: number) => number
  if (stsz) {
    const at = stsz.start + stsz.headerSize + 4
    const constant = tree.u32(at)
    sampleCount = tree.u32(at + 4)
    sizeOf = constant !== 0 ? () => constant : (i) => tree.u32(at + 8 + i * 4)
  } else {
    const at = stz2!.start + stz2!.headerSize + 4
    const fieldSize = tree.u8(at + 3)
    sampleCount = tree.u32(at + 4)
    if (fieldSize === 16) sizeOf = (i) => (tree.u8(at + 8 + i * 2) << 8) | tree.u8(at + 9 + i * 2)
    else if (fieldSize === 8) sizeOf = (i) => tree.u8(at + 8 + i)
    else if (fieldSize === 4) sizeOf = (i) => (i % 2 === 0 ? tree.u8(at + 8 + (i >> 1)) >> 4 : tree.u8(at + 8 + (i >> 1)) & 0x0f)
    else throw new IsobmffUnsupportedError(`stz2 field size ${fieldSize}`)
  }

  const ranges: [number, number][] = []
  let sample = 0
  let runIndex = 0
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    while (runIndex + 1 < runs.length && runs[runIndex + 1].firstChunk <= chunk) runIndex++
    const run = runs[runIndex]
    if (!run || run.firstChunk > chunk) throw new IsobmffUnsupportedError(`${where}: chunk ${chunk} is before the first stsc entry`)
    let length = 0
    for (let i = 0; i < run.samplesPerChunk; i++) {
      if (sample >= sampleCount) throw new IsobmffUnsupportedError(`${where}: the chunks hold more samples than the size table lists (${sampleCount})`)
      length += sizeOf(sample++)
    }
    if (length > 0) ranges.push([offsets[chunk - 1], offsets[chunk - 1] + length])
  }
  if (sample !== sampleCount) throw new IsobmffUnsupportedError(`${where}: the chunks hold ${sample} samples, the size table lists ${sampleCount}`)
  return ranges
}

/** Every data reference of a kept track must be in this file (flag 1), or its offsets mean another file. */
function requireSelfContained(tree: BoxTree, minfKids: Box[], where: string): void {
  const dinf = tree.only(minfKids, 'dinf', `${where}/minf`)
  const dref = tree.only(tree.children(dinf), 'dref', `${where}/minf/dinf`)
  // FullBox (4) + entry_count (4), then the entries.
  const entries = parseBoxes(tree.bytes, tree.local(dref.start + dref.headerSize + 8), tree.local(dref.end), tree.base)
  const count = tree.u32(dref.start + dref.headerSize + 4)
  if (entries.length !== count) throw new IsobmffUnsupportedError(`${where}: dref lists ${count} entries but holds ${entries.length}`)
  for (const entry of entries) {
    const flags = tree.u32(entry.start + entry.headerSize) & 0xffffff
    if ((flags & 1) !== 1) throw new IsobmffUnsupportedError(`${where}: the track's samples are in another file (data reference ${JSON.stringify(entry.type)})`)
  }
}

/** Sorted, merged union of ranges. */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges.filter(([s, e]) => e > s).map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  return merged
}

/** `outer` minus the union of `holes` (both [start, end) ranges). */
export function subtractRanges(outer: readonly [number, number][], holes: readonly [number, number][]): [number, number][] {
  const cut = mergeRanges(holes)
  const result: [number, number][] = []
  for (const [start, end] of mergeRanges(outer)) {
    let at = start
    for (const [hs, he] of cut) {
      if (he <= at) continue
      if (hs >= end) break
      if (hs > at) result.push([at, hs])
      at = Math.max(at, he)
      if (at >= end) break
    }
    if (at < end) result.push([at, end])
  }
  return result
}

/** One change the stripper makes, for the report (box paths and track descriptions, never values). */
export interface VideoRemoval {
  /** e.g. "moov/udta", "track 3 (meta, mebx)", "creation times", "unreferenced bytes in mdat". */
  what: string
  bytes: number
  /** False for changes that remove nothing personal (an empty box, a reference to a removed track). */
  personal: boolean
}

export interface IsobmffVideoPlan {
  size: number
  removals: VideoRemoval[]
  /** Whether anything personal is removed. False: the file is left as it is. */
  personal: boolean
  keptTracks: TrackInfo[]
  removedTracks: TrackInfo[]
  /** New bytes for ranges of the file (the edited `moov` parts, blanked top-level boxes). */
  writes: {offset: number; data: Uint8Array}[]
  /** Ranges set to zero: removed tracks' samples, unreferenced `mdat` bytes, padding content. */
  zeroRanges: [number, number][]
  /** Every range the plan writes to (sorted, merged). Every other byte of the file is unchanged. */
  changedRanges: [number, number][]
  /** The kept tracks' samples (sorted, merged): never written. */
  keptSampleRanges: [number, number][]
  /** `mdat` bytes no kept track references, and how many of them are not zero. */
  unreferenced: {bytes: number; nonZeroBytes: number}
}

/** Blanks a box in `moov` (held in `out`, at absolute offset `base`): a `free` box of the same size with zero content. */
function blankInPlace(out: Uint8Array, base: number, box: Box): void {
  const at = box.start - base
  const size = box.end - box.start
  out.fill(0, at, box.end - base)
  const v = view(out)
  if (size <= 0xffffffff) {
    v.setUint32(at, size)
  } else {
    v.setUint32(at, 1)
    v.setBigUint64(at + 8, BigInt(size))
  }
  out.set([0x66, 0x72, 0x65, 0x65], at + 4) // "free"
}

function blankBytes(box: Box): Uint8Array {
  const out = new Uint8Array(box.end - box.start)
  blankInPlace(out, box.start, box)
  return out
}

function nonZero(bytes: Uint8Array): number {
  let count = 0
  for (const b of bytes) if (b !== 0) count++
  return count
}

/** Whether a metadata box holds nothing: no children, or only empty containers and a handler. */
function isEmptyMetadata(tree: BoxTree, box: Box): boolean {
  if (box.end - box.start === box.headerSize) return true
  let kids: Box[]
  try {
    // `meta` is a FullBox in MP4 (4 bytes of version and flags first) and a plain box in QuickTime.
    const at = box.start + box.headerSize
    const fullBox = box.type === 'meta' && box.end - at >= 12 && tree.u32(at) === 0 && tree.type4(at + 8) === 'hdlr'
    kids = parseBoxes(tree.bytes, tree.local(at + (fullBox ? 4 : 0)), tree.local(box.end), tree.base)
  } catch (error) {
    // Not a plain box list: it holds content of some kind, so it counts as not empty.
    if (error instanceof IsobmffUnsupportedError) return false
    throw error
  }
  return kids.every((kid) => kid.type === 'hdlr' || ((kid.type === 'ilst' || kid.type === 'keys' || kid.type === 'udta') && kid.end - kid.start <= kid.headerSize + (kid.type === 'keys' ? 8 : 0)))
}

const MAX_MOOV_BYTES = 512 * 1024 * 1024
const READ_CHUNK = 4 * 1024 * 1024

/**
 * Plans the strip of the file behind `reader` (see the top of this file). Reads the top-level box
 * headers, the whole `moov` box and the unreferenced `mdat` ranges; never the kept samples. Throws
 * IsobmffUnsupportedError for files it cannot strip with certainty.
 */
export async function planIsobmffStrip(reader: ByteReader): Promise<IsobmffVideoPlan> {
  const top = await topLevelBoxes(reader)
  const removals: VideoRemoval[] = []
  const writes: {offset: number; data: Uint8Array}[] = []
  const zeroRanges: [number, number][] = []
  const changed: [number, number][] = []
  /** Payloads of top-level free/skip boxes; zeroed when they hold anything. */
  const topPadding: [number, number][] = []

  const moovs = top.filter((b) => b.type === 'moov')
  if (moovs.length !== 1) throw new IsobmffUnsupportedError(`file: expected one moov box, found ${moovs.length}`)
  const moov = moovs[0]
  const mdats = top.filter((b) => b.type === 'mdat')
  if (mdats.length === 0) throw new IsobmffUnsupportedError('file: no mdat box')

  for (const box of top) {
    if (TOP_LEVEL_KEPT.has(box.type)) continue
    if (PADDING.has(box.type)) {
      topPadding.push([box.start + box.headerSize, box.end])
    } else if (box.type === 'meta' || (box.type === 'uuid' && box.uuid === XMP_UUID)) {
      const bytes = await reader.read(box.start, box.end - box.start)
      const tree = new BoxTree(bytes, box.start)
      const empty = box.type === 'meta' && isEmptyMetadata(tree, box)
      writes.push({offset: box.start, data: blankBytes(box)})
      changed.push([box.start, box.end])
      removals.push({what: box.type === 'meta' ? 'meta (top level)' : 'XMP (top level)', bytes: box.end - box.start, personal: !empty})
    } else {
      const fragmented = ['moof', 'mfra', 'sidx', 'styp', 'emsg'].includes(box.type)
      throw new IsobmffUnsupportedError(
        `file: ${fragmented ? 'fragmented files are not supported' : 'unknown top-level box'} ${JSON.stringify(box.type)}${box.uuid ? ` (${box.uuid})` : ''}`,
      )
    }
  }

  if (moov.end - moov.start > MAX_MOOV_BYTES) throw new IsobmffUnsupportedError(`moov is ${moov.end - moov.start} bytes, more than this stripper reads`)
  const original = await reader.read(moov.start, moov.end - moov.start)
  const tree = new BoxTree(original, moov.start)
  const out = Uint8Array.from(original)
  const moovChanged: [number, number][] = []
  const blank = (box: Box) => {
    blankInPlace(out, moov.start, box)
    moovChanged.push([box.start, box.end])
  }
  const zeroPayload = (box: Box) => {
    out.fill(0, box.start - moov.start + box.headerSize, box.end - moov.start)
    moovChanged.push([box.start + box.headerSize, box.end])
  }
  /** Zeroes the creation and modification times of an mvhd/tkhd/mdhd box; returns whether they were set. */
  const zeroTimes = (box: Box): boolean => {
    const at = box.start + box.headerSize
    const length = tree.u8(at) === 1 ? 16 : 8
    if (box.end - at < 4 + length) throw new IsobmffUnsupportedError(`${box.type} box is too short`)
    const times = original.subarray(tree.local(at + 4), tree.local(at + 4 + length))
    if (nonZero(times) === 0) return false
    out.fill(0, tree.local(at + 4), tree.local(at + 4 + length))
    moovChanged.push([at + 4, at + 4 + length])
    return true
  }
  let timesZeroed = 0
  /** Blanks a metadata box (udta/meta) at `where`. */
  const removeMetadata = (box: Box, where: string) => {
    const empty = isEmptyMetadata(tree, box)
    blank(box)
    removals.push({what: `${where}/${box.type}`, bytes: box.end - box.start, personal: !empty})
  }
  const zeroPadding = (box: Box, where: string) => {
    const payload = original.subarray(tree.local(box.start + box.headerSize), tree.local(box.end))
    const count = nonZero(payload)
    if (count > 0) {
      zeroPayload(box)
      removals.push({what: `${where}/${box.type} padding`, bytes: payload.length, personal: true})
    }
  }

  const keptTracks: TrackInfo[] = []
  const removedTracks: TrackInfo[] = []
  const keptSamples: [number, number][] = []
  const removedSamples: [number, number][] = []
  const traks: {box: Box; info: TrackInfo}[] = []
  let trackIndex = 0
  for (const box of tree.children(moov)) {
    if (box.type === 'trak') {
      trackIndex++
      traks.push({box, info: trackInfo(tree, box, trackIndex)})
    } else if (box.type === 'mvhd') {
      if (zeroTimes(box)) timesZeroed++
    } else if (MOOV_KEPT.has(box.type)) {
      continue
    } else if (METADATA_BOXES.has(box.type)) {
      removeMetadata(box, 'moov')
    } else if (box.type === 'uuid' && box.uuid === XMP_UUID) {
      blank(box)
      removals.push({what: 'moov/XMP', bytes: box.end - box.start, personal: true})
    } else if (PADDING.has(box.type)) {
      zeroPadding(box, 'moov')
    } else {
      throw new IsobmffUnsupportedError(`moov: unknown box ${JSON.stringify(box.type)}${box.type === 'mvex' ? ' (fragmented files are not supported)' : ''}`)
    }
  }

  for (const {box, info} of traks) {
    const where = `track ${info.index} (${info.handler})`
    const parts = trackParts(tree, box)
    if (!KEPT_HANDLERS.has(info.handler)) {
      removedTracks.push(info)
      removedSamples.push(...trackChunkRanges(tree, parts.stbl))
      blank(box)
      removals.push({what: `track ${info.index} (${info.handler}, ${info.sampleEntry})`, bytes: box.end - box.start, personal: true})
      continue
    }
    keptTracks.push(info)
    requireSelfContained(tree, parts.minfKids, where)
    keptSamples.push(...trackChunkRanges(tree, parts.stbl))
    if (zeroTimes(parts.tkhd)) timesZeroed++
    if (zeroTimes(parts.mdhd)) timesZeroed++
    for (const [kids, allowed, path] of [
      [parts.kids, TRAK_KEPT, where],
      [parts.mdiaKids, MDIA_KEPT, `${where}/mdia`],
      [parts.minfKids, MINF_KEPT, `${where}/mdia/minf`],
      [tree.children(parts.stbl), STBL_KEPT, `${where}/mdia/minf/stbl`],
    ] as const) {
      for (const child of kids) {
        if (allowed.has(child.type)) continue
        if (METADATA_BOXES.has(child.type)) removeMetadata(child, path)
        else if (PADDING.has(child.type)) zeroPadding(child, path)
        else throw new IsobmffUnsupportedError(`${path}: unknown box ${JSON.stringify(child.type)}`)
      }
    }
  }
  if (keptTracks.length === 0) throw new IsobmffUnsupportedError('file: no video or audio track')
  if (timesZeroed > 0) removals.push({what: `creation and modification times (${timesZeroed} headers)`, bytes: 0, personal: true})

  // References from kept tracks to removed ones would dangle. A kept track's `tref` that only
  // points at removed tracks (a video track's link to its timecode track, for example) goes with
  // them; one that also points at kept tracks cannot be split safely and is refused.
  const removedIds = new Set(removedTracks.map((t) => t.id))
  for (const {box, info} of traks) {
    if (!KEPT_HANDLERS.has(info.handler)) continue
    const tref = tree.optional(tree.children(box), 'tref', 'trak')
    if (!tref) continue
    const targets: number[] = []
    for (const reference of tree.children(tref)) {
      for (let at = reference.start + reference.headerSize; at + 4 <= reference.end; at += 4) targets.push(tree.u32(at))
    }
    const toRemoved = targets.filter((target) => removedIds.has(target))
    if (toRemoved.length === 0) continue
    if (toRemoved.length !== targets.length) {
      throw new IsobmffUnsupportedError(`track ${info.id} references the removed track(s) ${toRemoved.join(', ')} and kept ones in the same tref`)
    }
    blank(tref)
    removals.push({what: `track ${info.index} (${info.handler})/tref to removed tracks`, bytes: tref.end - tref.start, personal: false})
  }

  // Samples: inside an mdat; removed tracks' samples never overlap kept ones.
  const payloads = mdats.map((m) => [m.start + m.headerSize, m.end] as [number, number])
  const inMdat = ([s, e]: [number, number]) => payloads.some(([ps, pe]) => s >= ps && e <= pe)
  const kept = mergeRanges(keptSamples)
  for (const range of kept) {
    if (!inMdat(range)) throw new IsobmffUnsupportedError(`kept track data [${range[0]}, ${range[1]}) is not inside an mdat box`)
  }
  let removedSampleBytes = 0
  for (const range of mergeRanges(removedSamples)) {
    if (!inMdat(range)) throw new IsobmffUnsupportedError(`removed track data [${range[0]}, ${range[1]}) is not inside an mdat box`)
    if (subtractRanges([range], kept).reduce((sum, [s, e]) => sum + e - s, 0) !== range[1] - range[0]) {
      throw new IsobmffUnsupportedError(`removed track data [${range[0]}, ${range[1]}) overlaps a kept track's data`)
    }
    removedSampleBytes += range[1] - range[0]
  }

  // Every mdat byte no kept sample uses (removed tracks' samples included) is set to zero.
  const unreferenced = subtractRanges(payloads, kept)
  let unreferencedBytes = 0
  let unreferencedNonZero = 0
  const removedMerged = mergeRanges(removedSamples)
  let leftoverNonZero = 0
  for (const [start, end] of unreferenced) {
    unreferencedBytes += end - start
    for (let at = start; at < end; at += READ_CHUNK) {
      const length = Math.min(READ_CHUNK, end - at)
      const bytes = await reader.read(at, length)
      const count = nonZero(bytes)
      if (count === 0) continue
      unreferencedNonZero += count
      // Count what is not a removed track's sample separately: leftovers no track describes.
      const leftovers = subtractRanges([[at, at + length]], removedMerged)
      for (const [ls, le] of leftovers) leftoverNonZero += nonZero(bytes.subarray(ls - at, le - at))
    }
    zeroRanges.push([start, end])
  }
  if (removedSampleBytes > 0) removals.push({what: 'samples of the removed tracks (zeroed in mdat)', bytes: removedSampleBytes, personal: true})
  if (leftoverNonZero > 0) {
    removals.push({what: 'mdat bytes no track uses (zeroed; e.g. an iOS draft movie header)', bytes: leftoverNonZero, personal: true})
  }

  // The moov edits as writes of the changed spans only.
  for (const [start, end] of mergeRanges(moovChanged)) {
    writes.push({offset: start, data: out.slice(start - moov.start, end - moov.start)})
    changed.push([start, end])
  }
  // Padding of top-level boxes: zeroed only when it has content.
  for (const range of topPadding) {
    let count = 0
    for (let at = range[0]; at < range[1]; at += READ_CHUNK) count += nonZero(await reader.read(at, Math.min(READ_CHUNK, range[1] - at)))
    if (count > 0) {
      zeroRanges.push(range)
      removals.push({what: 'free padding (top level)', bytes: range[1] - range[0], personal: true})
    }
  }
  changed.push(...zeroRanges)

  return {
    size: reader.size,
    removals,
    personal: removals.some((r) => r.personal) || unreferencedNonZero > 0,
    keptTracks,
    removedTracks,
    writes: writes.sort((a, b) => a.offset - b.offset),
    zeroRanges: mergeRanges(zeroRanges),
    changedRanges: mergeRanges(changed),
    keptSampleRanges: kept,
    unreferenced: {bytes: unreferencedBytes, nonZeroBytes: unreferencedNonZero},
  }
}

/** Applies a plan to a copy of `input` (the migration: files that fit in memory). */
export function applyIsobmffPlan(input: Uint8Array, plan: IsobmffVideoPlan): Uint8Array {
  if (input.length !== plan.size) throw new RangeError(`the plan is for ${plan.size} bytes, the input has ${input.length}`)
  const out = Uint8Array.from(input)
  for (const [start, end] of plan.zeroRanges) out.fill(0, start, end)
  for (const write of plan.writes) out.set(write.data, write.offset)
  return out
}

/** Applies a plan to a file in place (the Function: the copy on /tmp). */
export async function applyIsobmffPlanToFile(handle: FileHandle, plan: IsobmffVideoPlan): Promise<void> {
  const {size} = await handle.stat()
  if (size !== plan.size) throw new RangeError(`the plan is for ${plan.size} bytes, the file has ${size}`)
  const zeros = new Uint8Array(READ_CHUNK)
  for (const [start, end] of plan.zeroRanges) {
    for (let at = start; at < end; at += READ_CHUNK) {
      const length = Math.min(READ_CHUNK, end - at)
      await writeAll(handle, zeros.subarray(0, length), at)
    }
  }
  for (const write of plan.writes) await writeAll(handle, write.data, write.offset)
  await handle.sync()
}

async function writeAll(handle: FileHandle, data: Uint8Array, position: number): Promise<void> {
  let done = 0
  while (done < data.length) {
    const {bytesWritten} = await handle.write(data, done, data.length - done, position + done)
    if (bytesWritten === 0) throw new Error(`could not write at ${position + done}`)
    done += bytesWritten
  }
}

/**
 * Signatures of location and device metadata, searched for in every byte of a stripped file that is
 * not a kept sample: ISO 6709 coordinates as Apple and others write them ("+12.3456-012.3456/"),
 * QuickTime location keys and user data atoms, XMP GPS and the timed-metadata sample entry. Names
 * only are returned, never the bytes found.
 */
const SIGNATURES: readonly {name: string; pattern: RegExp}[] = [
  {name: 'ISO 6709 coordinates', pattern: /[+-]\d{2,6}\.\d{2,}[+-]\d{3,7}\.\d{2,}/},
  {name: 'com.apple.quicktime.location', pattern: /com\.apple\.quicktime\.location/},
  {name: 'QuickTime key of the camera or device', pattern: /com\.apple\.quicktime\.(?:make|model|software|creationdate|camera|author|artist|detected-face)/},
  {name: '©xyz location atom', pattern: /\xa9xyz/},
  {name: 'XMP GPS', pattern: /exif:GPS|GPSLatitude|GPSLongitude/},
  {name: 'timed metadata sample entry (mebx)', pattern: /mebx/},
]

export function findMetadataSignatures(bytes: Uint8Array): string[] {
  const text = decoder.decode(bytes)
  return SIGNATURES.filter((s) => s.pattern.test(text)).map((s) => s.name)
}

/**
 * Problems with a stripped file, read through `reader`: it must plan to nothing personal (no
 * metadata box with content, no data track, zero times, no non-zero unreferenced mdat byte, no
 * padding with content) and no byte outside the kept samples may hold a location or device
 * signature (findMetadataSignatures). Empty when the file is clean.
 */
export async function checkStrippedIsobmff(reader: ByteReader): Promise<string[]> {
  const problems: string[] = []
  let plan: IsobmffVideoPlan
  try {
    plan = await planIsobmffStrip(reader)
  } catch (error) {
    return [`the stripped file cannot be read: ${(error as Error).message}`]
  }
  for (const removal of plan.removals.filter((r) => r.personal)) problems.push(`still has ${removal.what}`)
  if (plan.unreferenced.nonZeroBytes > 0) problems.push(`${plan.unreferenced.nonZeroBytes} non-zero mdat bytes no track uses`)
  const outside = subtractRanges([[0, reader.size]], plan.keptSampleRanges)
  const overlap = 64
  const found = new Set<string>()
  for (const [start, end] of outside) {
    for (let at = start; at < end; at += READ_CHUNK) {
      const from = Math.max(start, at - overlap)
      const to = Math.min(end, at + READ_CHUNK)
      for (const name of findMetadataSignatures(await reader.read(from, to - from))) found.add(name)
    }
  }
  for (const name of found) problems.push(`${name} found outside the samples`)
  return problems
}

/** The track list of a file (position, id, handler, first sample entry), for scans. */
export async function listTracks(reader: ByteReader): Promise<TrackInfo[]> {
  const top = await topLevelBoxes(reader)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new IsobmffUnsupportedError('file: no moov box')
  const tree = new BoxTree(await reader.read(moov.start, moov.end - moov.start), moov.start)
  let index = 0
  return tree
    .children(moov)
    .filter((b) => b.type === 'trak')
    .map((trak) => trackInfo(tree, trak, ++index))
}

/** The box tree as indented lines ("moov 1234"), for inspection and tests. */
export function describeBoxes(bytes: Uint8Array): string[] {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'tref', 'tapt'])
  const lines: string[] = []
  const visit = (boxes: Box[], depth: number) => {
    for (const box of boxes) {
      lines.push(`${'  '.repeat(depth)}${box.type}${box.uuid ? `:${box.uuid}` : ''} ${box.end - box.start}`)
      if (containers.has(box.type)) visit(parseBoxes(bytes, box.start + box.headerSize, box.end), depth + 1)
    }
  }
  visit(parseBoxes(bytes, 0, bytes.length), 0)
  return lines
}
