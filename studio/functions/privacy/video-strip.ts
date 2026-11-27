/**
 * Video stripper used by the video-to-mp4 Function (and its upload sweep) for the original it
 * keeps.
 *
 * QuickTime/MP4 (ISO BMFF) files are stripped in place (stripIsobmffInPlace, with
 * isobmff-video.ts): the metadata boxes, data tracks, creation times and unused mdat bytes are
 * removed without moving a byte, so the container, the edit lists, the time stamps and every
 * sample stay exactly as they were. Measured with the Function's ffmpeg 7.0.2 on the Wagtail
 * videos, a stream copy instead rewrote the edit lists (an iPhone screen recording lost its
 * audio's initial empty edit and the discard flag of an AAC priming packet), changed the track time
 * scales and durations, moved repeated time stamps of macOS screen recordings and turned a Dolby
 * Vision QuickTime file into MP4. The in-place result is checked with ffmpeg: the same streams
 * with the same codec, picture, sound and side data (rotation, HDR, Dolby Vision), only technical
 * stream metadata left, and every packet identical (framemd5: size, MD5, time stamps and duration;
 * streamhash: sha256 per stream); and byte by byte: every byte outside the stripped ranges
 * unchanged, nothing personal left (checkStrippedIsobmff).
 *
 * Other containers (Matroska/WebM and anything ffmpeg reads) and ISO BMFF files the in-place
 * stripper refuses (fragmented files, unknown boxes) fall back to a stream copy with ffmpeg
 * (stripVideo below), which rewrites the container and says so in its notes: no re-encoding. It
 * keeps every video and audio stream and nothing else. Removed: global
 * and per-stream metadata (QuickTime keys and user data such as com.apple.quicktime.location.ISO6709,
 * ©xyz, make, model, software, creation dates), timed-metadata and other data tracks (iPhone `mebx`
 * location and Live Photo tracks, GoPro GPMF), subtitles, attachments, cover art, chapters, and the
 * creation times of the movie and its tracks. Kept: the video and audio packets byte for byte, the
 * rotation (display matrix), the colour description (`colr`), HDR side data and, by writing MP4
 * instead of QuickTime when needed, the Dolby Vision configuration (ffmpeg 7.0's QuickTime muxer
 * cannot write `dvvC`).
 *
 * The stream copy is checked with the same ffmpeg before it is used: the stream list, the metadata left
 * (only the container's own brand and handler fields), the boxes of an MP4/QuickTime file, and every
 * packet of every kept stream compared with the input (framemd5: size and MD5 of each packet, its
 * time stamps and duration; streamhash: sha256 of each stream). ffmpeg's muxer must make decode
 * time stamps strictly increasing, so packets whose input time stamps were not (screen recordings
 * have runs of equal ones) are moved by a few ticks; those moves, and a different duration of a
 * stream's last packet, are allowed within MAX_TIMESTAMP_ADJUSTMENT_SECONDS and reported. No
 * network here: the input is a local path or the range proxy's 127.0.0.1 URL.
 */
import {createHash} from 'node:crypto'
import {open, readFile} from 'node:fs/promises'
import path from 'node:path'

import {
  applyIsobmffPlanToFile,
  checkStrippedIsobmff,
  fileHandleReader,
  planIsobmffStrip,
  subtractRanges,
  type ByteReader,
  type IsobmffVideoPlan,
} from './isobmff-video'

/** ffmpeg run by the caller (the Function's verified binary, or a local one in tests). */
export type FfmpegRunner = (args: string[]) => Promise<{code: number | null; stderr: string; killedAtDeadline: boolean}>

export class VideoStripError extends Error {
  override name = 'VideoStripError'
}

/** Raised when ffmpeg was stopped at the deadline: not the video's fault, retried later. */
export class VideoStripTimeoutError extends Error {
  override name = 'VideoStripTimeoutError'
}

/** Largest allowed change of a packet's time stamps or of a stream's last packet duration. */
export const MAX_TIMESTAMP_ADJUSTMENT_SECONDS = 0.05

export type StreamKind = 'video' | 'audio' | 'data' | 'subtitle' | 'attachment'

export interface ContainerStream {
  /** Index in the file (`Stream #0:<index>`). */
  index: number
  kind: StreamKind
  codec: string
  attachedPicture: boolean
  dolbyVision: boolean
  metadataKeys: string[]
  /**
   * What playback depends on, as ffmpeg prints it: for video the pixel format with the colour
   * description and the frame size, for audio the sample rate, channel layout and sample format.
   */
  details: string[]
  /** Side data lines (rotation, HDR, ambient viewing, Dolby Vision). Technical, never personal. */
  sideData: string[]
}

export interface ContainerDescription {
  /** ffmpeg's demuxer names, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  demuxer: string
  majorBrand: string | undefined
  globalMetadataKeys: string[]
  chapters: number
  streams: ContainerStream[]
}

const INPUT_LINE = /^Input #0, ([^ ]+), from /
const STREAM_LINE = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Data|Subtitle|Attachment): (.*)$/
/**
 * A stream group (printed by newer ffmpeg, e.g. 9.1, not 7.0.2; for QuickTime/MP4 a "Track Reference", e.g. an iPhone's
 * video track and the timed-metadata track that refers to it). The group lists its streams again,
 * indented; a stream that belongs to a group may appear only there, not at the top level.
 */
const STREAM_GROUP_LINE = /^\s*Stream group #0:\d+/
const META_LINE = /^(\s*)([^:]+?)\s*: ?(.*)$/

/** Splits ffmpeg's comma-separated stream description at the top level (not inside parentheses). */
function splitFields(text: string): string[] {
  const fields: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[') depth += 1
    if (c === ')' || c === ']') depth -= 1
    if (c === ',' && depth === 0 && text[i + 1] === ' ') {
      fields.push(current.trim())
      current = ''
      i += 1
      continue
    }
    current += c
  }
  if (current.trim() !== '') fields.push(current.trim())
  return fields
}

/**
 * Parses `ffmpeg -hide_banner -i <file>` (stderr). Metadata values are never kept, only the keys:
 * they may be coordinates.
 *
 * Each stream is described once, in index order, wherever ffmpeg prints it first: at the top level
 * or inside a stream group (STREAM_GROUP_LINE). A stream printed again in another group, with its
 * metadata and side data, is the same stream and is skipped. A group's own metadata counts as file
 * metadata, so a check of the output reports it.
 */
export function describeContainer(text: string): ContainerDescription {
  const lines = text.split(/\r?\n/)
  const inputIndex = lines.findIndex((line) => INPUT_LINE.test(line))
  if (inputIndex === -1) throw new VideoStripError('ffmpeg could not read the file as a video')
  const demuxer = INPUT_LINE.exec(lines[inputIndex])![1]
  const result: ContainerDescription = {demuxer, majorBrand: undefined, globalMetadataKeys: [], chapters: 0, streams: []}
  /** Where metadata lines currently go: global, a stream, or nowhere (side data, chapters). */
  let target: string[] | null = null
  let current: ContainerStream | null = null
  /** True after a stream that was already described (printed again in a stream group). */
  let repeated = false
  for (const line of lines.slice(inputIndex + 1)) {
    if (/^(Input|Output) #\d+/.test(line) || line.startsWith('At least one output')) break
    if (STREAM_GROUP_LINE.test(line)) {
      current = null
      repeated = false
      target = null
      continue
    }
    const stream = STREAM_LINE.exec(line)
    if (stream) {
      const [, index, kind, rest] = stream
      if (result.streams.some((s) => s.index === Number(index))) {
        current = null
        repeated = true
        target = null
        continue
      }
      repeated = false
      const streamKind = kind.toLowerCase() as StreamKind
      const fields = splitFields(rest.replace(/\s*\((?:default|attached pic|forced|dependent)\)/g, ''))
      const codec = rest.split(/[ ,(]/)[0]
      // Data streams print `none (mebx / 0x...)`: the tag says more than "none".
      const tag = /\((\w{4}) \/ 0x[0-9A-Fa-f]+\)/.exec(fields[0] ?? '')?.[1]
      current = {
        index: Number(index),
        kind: streamKind,
        codec: codec === 'none' && tag ? tag : codec,
        attachedPicture: /\(attached pic\)/.test(rest),
        dolbyVision: false,
        metadataKeys: [],
        details: streamKind === 'video' ? fields.slice(1, 3) : streamKind === 'audio' ? fields.slice(1, 4) : [],
        sideData: [],
      }
      result.streams.push(current)
      target = null
      continue
    }
    const trimmed = line.trim()
    if (/^Chapter #\d+:\d+/.test(trimmed)) {
      result.chapters += 1
      current = null
      repeated = false
      target = null
      continue
    }
    if (repeated) continue
    if (trimmed === 'Metadata:') {
      // Global metadata comes before the chapters and streams; a chapter's title is not stored.
      target = current ? current.metadataKeys : result.chapters === 0 ? result.globalMetadataKeys : null
      continue
    }
    if (trimmed === 'Side data:') {
      target = current ? current.sideData : null
      continue
    }
    if (trimmed === 'Chapters:' || /^Duration:/.test(trimmed)) {
      target = null
      continue
    }
    if (current && target === current.sideData) {
      if (/DOVI configuration record/.test(trimmed)) current.dolbyVision = true
      current.sideData.push(trimmed)
      continue
    }
    if (target) {
      const meta = META_LINE.exec(line)
      if (meta) {
        const key = meta[2].trim()
        // A value's continuation lines have an empty key.
        if (key === '') continue
        if (target === result.globalMetadataKeys && key === 'major_brand') result.majorBrand = meta[3].trim()
        if (!target.includes(key)) target.push(key)
      }
    }
  }
  result.streams.sort((a, b) => a.index - b.index)
  return result
}

export type Muxer = 'mov' | 'mp4' | 'matroska' | 'webm'

export const MUXER_FILES: Record<Muxer, {extension: string; mimeType: string}> = {
  mov: {extension: 'mov', mimeType: 'video/quicktime'},
  mp4: {extension: 'mp4', mimeType: 'video/mp4'},
  matroska: {extension: 'mkv', mimeType: 'video/x-matroska'},
  webm: {extension: 'webm', mimeType: 'video/webm'},
}

const WEBM_CODECS = new Set(['vp8', 'vp9', 'av1', 'opus', 'vorbis'])

export interface StripPlan {
  muxer: Muxer
  extension: string
  mimeType: string
  /** Input stream indices that are kept, in file order (output stream i is kept[i]). */
  kept: ContainerStream[]
  /** What is removed (names only, never values). */
  removed: string[]
  /** Changes worth telling the editor, e.g. a different container. */
  notes: string[]
}

/**
 * The major brand of an ISO base media file from its first bytes (`ftyp`), e.g. `qt` for QuickTime,
 * or undefined. ffmpeg prints it as metadata, but not reliably when a file has duplicate metadata
 * keys, so the caller passes the file's first bytes.
 */
export function majorBrand(head: Uint8Array): string | undefined {
  if (head.length < 12) return undefined
  const type = String.fromCharCode(...head.subarray(4, 8))
  if (type !== 'ftyp') return undefined
  return String.fromCharCode(...head.subarray(8, 12)).trim()
}

export function planStrip(input: ContainerDescription): StripPlan {
  const kept = input.streams.filter(
    (s) => (s.kind === 'video' && !s.attachedPicture) || s.kind === 'audio',
  )
  if (!kept.some((s) => s.kind === 'video')) throw new VideoStripError('the file has no video stream')
  const removed: string[] = []
  if (input.globalMetadataKeys.length > 0) {
    removed.push(`file metadata: ${input.globalMetadataKeys.filter((k) => !['major_brand', 'minor_version', 'compatible_brands'].includes(k)).join(', ')}`)
  }
  for (const s of input.streams) {
    if (kept.includes(s)) {
      const keys = s.metadataKeys.filter((k) => k !== 'handler_name' && k !== 'vendor_id')
      if (keys.length > 0) removed.push(`stream ${s.index} metadata: ${keys.join(', ')}`)
    } else {
      removed.push(`${s.attachedPicture ? 'cover art' : `${s.kind} stream`} ${s.index} (${s.codec})`)
    }
  }
  if (input.chapters > 0) removed.push(`${input.chapters} chapters`)
  removed.push('creation times')

  const notes: string[] = []
  let muxer: Muxer
  if (input.demuxer.startsWith('mov,mp4')) {
    const quickTime = input.majorBrand === 'qt'
    const dolbyVision = kept.some((s) => s.dolbyVision)
    const pcm = kept.some((s) => s.codec.startsWith('pcm_'))
    if (dolbyVision && !pcm) {
      muxer = 'mp4'
      if (quickTime) notes.push('written as MP4 instead of QuickTime to keep the Dolby Vision configuration')
    } else {
      muxer = quickTime ? 'mov' : 'mp4'
      if (dolbyVision) notes.push('the Dolby Vision configuration (dvvC) could not be kept: the PCM audio needs QuickTime, whose muxer cannot write it; the HDR base layer and its colour tags are kept')
    }
  } else if (input.demuxer.startsWith('matroska')) {
    muxer = kept.every((s) => WEBM_CODECS.has(s.codec)) ? 'webm' : 'matroska'
  } else {
    muxer = 'matroska'
    notes.push(`written as Matroska: ffmpeg cannot write a stream copy back to ${input.demuxer.split(',')[0]} without its metadata`)
  }
  return {muxer, ...MUXER_FILES[muxer], kept, removed, notes}
}

export function stripArgs(plan: StripPlan, input: string, output: string): string[] {
  if (output.startsWith('-')) throw new RangeError('output must not start with -')
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    ...plan.kept.flatMap((s) => ['-map', `0:${s.index}`]),
    '-c',
    'copy',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-fflags',
    '+bitexact',
    // Lets the MP4 muxer write the Dolby Vision configuration (dvcC/dvvC).
    '-strict',
    'unofficial',
    '-f',
    plan.muxer,
    output,
  ]
}

/** Metadata keys the muxers write themselves; anything else in the output is a problem. */
const ALLOWED_GLOBAL_KEYS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'ENCODER'])
const ALLOWED_STREAM_KEYS = new Set(['handler_name', 'vendor_id', 'ENCODER', 'DURATION'])

/** Problems with the stripped file's stream list and metadata, as ffmpeg reads them. */
export function checkStrippedDescription(plan: StripPlan, output: ContainerDescription): string[] {
  const problems: string[] = []
  if (output.streams.length !== plan.kept.length) {
    problems.push(`${output.streams.length} streams instead of ${plan.kept.length}`)
  }
  output.streams.forEach((s, i) => {
    const expected = plan.kept[i]
    if (!expected || s.kind !== expected.kind || s.codec !== expected.codec) {
      problems.push(`stream ${i} is ${s.kind} ${s.codec}, expected ${expected?.kind} ${expected?.codec}`)
    }
    const extra = s.metadataKeys.filter((k) => !ALLOWED_STREAM_KEYS.has(k))
    if (extra.length > 0) problems.push(`stream ${i} still has metadata: ${extra.join(', ')}`)
    if (expected && s.details.join(', ') !== expected.details.join(', ')) {
      problems.push(`stream ${i} changed from "${expected.details.join(', ')}" to "${s.details.join(', ')}"`)
    }
    if (expected) {
      // Every side data entry (rotation, HDR, Dolby Vision) must still be there, unless the plan
      // says the Dolby Vision configuration cannot be kept.
      const dropped = plan.notes.some((n) => n.includes('Dolby Vision configuration (dvvC) could not be kept'))
      const wanted = expected.sideData.filter((d) => !(dropped && /DOVI configuration record/.test(d)))
      const missing = wanted.filter((d) => !s.sideData.includes(d))
      if (missing.length > 0) problems.push(`stream ${i} lost side data: ${missing.join('; ')}`)
    }
  })
  const extra = output.globalMetadataKeys.filter((k) => !ALLOWED_GLOBAL_KEYS.has(k))
  if (extra.length > 0) problems.push(`file metadata left: ${extra.join(', ')}`)
  if (output.chapters > 0) problems.push(`${output.chapters} chapters left`)
  return problems
}

// ---------------------------------------------------------------------------------------------
// Box check of an MP4/QuickTime output.

interface FileBox {
  type: string
  start: number
  end: number
  payloadStart: number
}

function readBoxList(data: Uint8Array, start: number, end: number, base: number): FileBox[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const boxes: FileBox[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = view.getUint32(pos)
    const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8))
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8))
      header = 16
    } else if (size === 0) size = end - pos
    if (size < header || pos + size > end) throw new VideoStripError(`box ${type} at ${base + pos} has an invalid size`)
    boxes.push({type, start: pos, end: pos + size, payloadStart: pos + header})
    pos += size
  }
  return boxes
}

/**
 * Problems in the boxes of a stripped MP4 or QuickTime file: any `uuid` or metadata box other than
 * the empty `udta/meta/ilst` the MP4 muxer writes, any track that is not video or audio, and any
 * non-zero creation or modification time. With `allowEncoderTag`, the `ilst` may hold ffmpeg's
 * `©too` (encoder name and version), as in the converted MP4s, whose settings do not use bitexact.
 */
export async function checkIsobmffBoxes(file: string, options: {allowEncoderTag?: boolean} = {}): Promise<string[]> {
  const handle = await open(file, 'r')
  try {
    const {size} = await handle.stat()
    const header = Buffer.alloc(16)
    const problems: string[] = []
    let pos = 0
    let moov: Uint8Array | undefined
    while (pos < size) {
      await handle.read(header, 0, 16, pos)
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8))
      else if (boxSize === 0) boxSize = size - pos
      if (boxSize < 8 || pos + boxSize > size) throw new VideoStripError(`top-level box ${type} has an invalid size`)
      if (type === 'moov') {
        moov = Buffer.alloc(boxSize)
        await handle.read(moov, 0, boxSize, pos)
      } else if (!['ftyp', 'mdat', 'free', 'wide', 'skip'].includes(type)) {
        problems.push(`unexpected top-level box ${JSON.stringify(type)}`)
      }
      pos += boxSize
    }
    if (!moov) return [...problems, 'no moov box']
    const walk = (start: number, end: number, trail: string) => {
      for (const box of readBoxList(moov!, start, end, 0)) {
        const at = `${trail}/${box.type}`
        if (box.type === 'uuid') problems.push(`${at} box left`)
        if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
          const version = moov![box.payloadStart]
          const length = version === 1 ? 16 : 8
          if (moov!.subarray(box.payloadStart + 4, box.payloadStart + 4 + length).some((b) => b !== 0)) {
            problems.push(`${at} has a creation or modification time`)
          }
        }
        if (box.type === 'hdlr' && trail.endsWith('/mdia')) {
          const handler = String.fromCharCode(...moov!.subarray(box.payloadStart + 8, box.payloadStart + 12))
          if (handler !== 'vide' && handler !== 'soun') problems.push(`${trail} is a ${JSON.stringify(handler)} track`)
        }
        if (box.type === 'udta') {
          for (const childBox of readBoxList(moov!, box.payloadStart, box.end, 0)) {
            if (childBox.type !== 'meta') {
              problems.push(`${at}/${childBox.type} left`)
              continue
            }
            for (const metaChild of readBoxList(moov!, childBox.payloadStart + 4, childBox.end, 0)) {
              if (metaChild.type === 'hdlr') continue
              if (metaChild.type === 'ilst') {
                const items = readBoxList(moov!, metaChild.payloadStart, metaChild.end, 0)
                const extra = items.filter((item) => !(options.allowEncoderTag && item.type === '\u00a9too'))
                for (const item of extra) problems.push(`${at}/meta/ilst/${item.type} left`)
                continue
              }
              problems.push(`${at}/meta/${metaChild.type} left`)
            }
          }
          continue
        }
        if (box.type === 'meta') {
          problems.push(`${at} box left`)
          continue
        }
        if (['moov', 'trak', 'mdia', 'minf', 'edts', 'dinf', 'mvex'].includes(box.type)) {
          walk(box.payloadStart, box.end, at)
        }
      }
    }
    walk(8, moov.length, 'moov')
    return problems
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------------------------
// Packet comparison.

interface Rational {
  num: bigint
  den: bigint
}

interface Packet {
  dts: Rational
  pts: Rational
  duration: Rational
  size: number
  md5: string
}

export interface FrameMd5 {
  codecs: string[]
  streams: Packet[][]
}

function rationalSeconds(value: string, tb: Rational): Rational {
  return {num: BigInt(value) * tb.num, den: tb.den}
}

function compare(a: Rational, b: Rational): number {
  const left = a.num * b.den
  const right = b.num * a.den
  return left === right ? 0 : left < right ? -1 : 1
}

function seconds(r: Rational): number {
  return Number(r.num) / Number(r.den)
}

/** Parses ffmpeg's framemd5 muxer output (version 2). */
export function parseFrameMd5(text: string): FrameMd5 {
  const tbs: Rational[] = []
  const codecs: string[] = []
  const streams: Packet[][] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#tb ')) {
      const [index, tb] = line.slice(4).split(':')
      const [num, den] = tb.trim().split('/')
      tbs[Number(index)] = {num: BigInt(num), den: BigInt(den)}
      continue
    }
    if (line.startsWith('#codec_id ')) {
      const [index, codec] = line.slice(10).split(':')
      codecs[Number(index)] = codec.trim()
      continue
    }
    if (line.startsWith('#')) continue
    const parts = line.split(',').map((p) => p.trim())
    const index = Number(parts[0])
    const tb = tbs[index]
    if (!tb || parts.length < 6) throw new VideoStripError(`unreadable framemd5 line: ${line.slice(0, 80)}`)
    ;(streams[index] ??= []).push({
      dts: rationalSeconds(parts[1], tb),
      pts: rationalSeconds(parts[2], tb),
      duration: rationalSeconds(parts[3], tb),
      size: Number(parts[4]),
      md5: parts[5],
    })
  }
  return {codecs, streams}
}

/**
 * The sha256 per stream from ffmpeg's streamhash muxer: `<index>,<type>,SHA256=<hex>` lines (up to
 * ffmpeg 9.0, the Function's 7.0.2 included), or version 2 (ffmpeg 9.1: a `#hash: SHA256` header
 * and `<index>, <size>, <hex>` lines).
 */
export function parseStreamHash(text: string): string[] {
  const hashes: string[] = []
  const lines = text.split('\n').map((line) => line.trim())
  const version2 = lines.includes('#hash: SHA256')
  for (const line of lines) {
    // Version 2 lines go on with the side data's hash (", S=1, 36, <hex>") when a stream has some.
    const match = version2 ? /^(\d+),\s*\d+,\s*([0-9a-f]{64})(?:,|$)/.exec(line) : /^(\d+),[a-z],SHA256=([0-9a-f]{64})$/.exec(line)
    if (match) hashes[Number(match[1])] = match[2]
  }
  return hashes
}

export interface TimingReport {
  /** Packets whose time stamps moved because the input's decode time stamps did not increase. */
  adjustedPackets: number
  maxAdjustmentSeconds: number
  /** Streams whose last packet has another duration in the output. */
  lastDurationChanges: number
}

/**
 * Compares the packets of every kept stream. Payloads (size and MD5, in order) must be identical.
 * Time stamps must be identical except for packets whose input decode time stamp was not greater
 * than every earlier one, which may move by at most MAX_TIMESTAMP_ADJUSTMENT_SECONDS. A stream's
 * last packet may have another duration (within the same limit). PCM audio, whose packets are cut
 * from the sample chunks, is compared by its sha256, its first time stamp and its total duration.
 */
export function comparePackets(
  input: FrameMd5,
  output: FrameMd5,
  inputHashes: string[],
  outputHashes: string[],
): {problems: string[]; timing: TimingReport} {
  const problems: string[] = []
  const timing: TimingReport = {adjustedPackets: 0, maxAdjustmentSeconds: 0, lastDurationChanges: 0}
  const count = Math.max(input.streams.length, output.streams.length)
  for (let s = 0; s < count; s++) {
    const a = input.streams[s] ?? []
    const b = output.streams[s] ?? []
    const codec = input.codecs[s] ?? '?'
    if (input.codecs[s] !== output.codecs[s]) problems.push(`stream ${s}: codec ${input.codecs[s]} became ${output.codecs[s]}`)
    if (!inputHashes[s] || inputHashes[s] !== outputHashes[s]) problems.push(`stream ${s} (${codec}): sha256 of the stream differs`)
    if (codec.startsWith('pcm_')) {
      const total = (list: Packet[]) => list.reduce((sum, p) => sum + p.size, 0)
      const duration = (list: Packet[]) =>
        list.reduce<Rational>((sum, p) => ({num: sum.num * p.duration.den + p.duration.num * sum.den, den: sum.den * p.duration.den}), {num: 0n, den: 1n})
      if (total(a) !== total(b)) problems.push(`stream ${s} (${codec}): ${total(a)} bytes became ${total(b)}`)
      if (a.length > 0 && b.length > 0 && compare(a[0].pts, b[0].pts) !== 0) problems.push(`stream ${s} (${codec}): the first sample moved`)
      if (compare(duration(a), duration(b)) !== 0) problems.push(`stream ${s} (${codec}): the duration changed`)
      continue
    }
    if (a.length !== b.length) {
      problems.push(`stream ${s} (${codec}): ${a.length} packets became ${b.length}`)
      continue
    }
    let maxDts: Rational | null = null
    for (let i = 0; i < a.length; i++) {
      const p = a[i]
      const q = b[i]
      if (p.size !== q.size || p.md5 !== q.md5) {
        problems.push(`stream ${s} (${codec}): packet ${i} differs`)
        break
      }
      const nonIncreasing = maxDts !== null && compare(p.dts, maxDts) <= 0
      if (maxDts === null || compare(p.dts, maxDts) > 0) maxDts = p.dts
      const moved = compare(p.dts, q.dts) !== 0 || compare(p.pts, q.pts) !== 0
      if (moved) {
        const shift = Math.max(Math.abs(seconds(p.dts) - seconds(q.dts)), Math.abs(seconds(p.pts) - seconds(q.pts)))
        if (!nonIncreasing || shift > MAX_TIMESTAMP_ADJUSTMENT_SECONDS) {
          problems.push(`stream ${s} (${codec}): packet ${i} moved by ${(shift * 1000).toFixed(3)} ms`)
          break
        }
        timing.adjustedPackets += 1
        timing.maxAdjustmentSeconds = Math.max(timing.maxAdjustmentSeconds, shift)
      }
      if (compare(p.duration, q.duration) !== 0) {
        const change = Math.abs(seconds(p.duration) - seconds(q.duration))
        if (i !== a.length - 1 || change > MAX_TIMESTAMP_ADJUSTMENT_SECONDS) {
          problems.push(`stream ${s} (${codec}): packet ${i} duration changed by ${(change * 1000).toFixed(3)} ms`)
          break
        }
        timing.lastDurationChanges += 1
        timing.maxAdjustmentSeconds = Math.max(timing.maxAdjustmentSeconds, change)
      }
    }
  }
  return {problems, timing}
}

/** ffmpeg arguments that write the framemd5 and streamhash of the given streams of a file. */
export function hashArgs(file: string, streams: number[], frameMd5File: string, streamHashFile: string): string[] {
  const maps = streams.flatMap((i) => ['-map', `0:${i}`])
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    file,
    ...maps,
    '-c',
    'copy',
    '-f',
    'framemd5',
    frameMd5File,
    ...maps,
    '-c',
    'copy',
    '-f',
    'streamhash',
    '-hash',
    'sha256',
    streamHashFile,
  ]
}

export interface VideoStripReport {
  muxer: Muxer
  extension: string
  mimeType: string
  removed: string[]
  notes: string[]
  timing: TimingReport
  /** sha256 of each kept stream's packets (identical in the input and the output). */
  streamSha256: string[]
}

async function run(ffmpeg: FfmpegRunner, args: string[], what: string): Promise<string> {
  const result = await ffmpeg(args)
  if (result.killedAtDeadline) throw new VideoStripTimeoutError(`ran out of time while ${what}`)
  if (result.code !== 0) {
    const tail = result.stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ')
    throw new VideoStripError(`ffmpeg failed while ${what}: ${tail || `exit code ${result.code}`}`)
  }
  return result.stderr
}

/** `ffmpeg -i` of a file (exits 1 by design: no output). */
export async function describeFile(ffmpeg: FfmpegRunner, file: string): Promise<ContainerDescription> {
  const result = await ffmpeg(['-hide_banner', '-nostdin', '-i', file])
  if (result.killedAtDeadline) throw new VideoStripTimeoutError('ran out of time while reading the video')
  return describeContainer(result.stderr)
}

/**
 * Strips `input` (a local path or the range proxy URL) into `workDir/stripped.<ext>` and verifies
 * it. Returns the output path and the report, or throws VideoStripError (the file cannot be
 * stripped or the check failed) or VideoStripTimeoutError.
 */
export async function stripVideo(options: {
  ffmpeg: FfmpegRunner
  input: string
  workDir: string
  /** The input's first bytes (at least 12), for its major brand (see majorBrand). */
  head: Uint8Array
}): Promise<{output: string; report: VideoStripReport}> {
  const {ffmpeg, input, workDir} = options
  const description = await describeFile(ffmpeg, input)
  description.majorBrand = majorBrand(options.head) ?? description.majorBrand
  const plan = planStrip(description)
  const output = path.join(workDir, `stripped.${plan.extension}`)
  await run(ffmpeg, stripArgs(plan, input, output), 'copying the streams without metadata')

  const problems = checkStrippedDescription(plan, await describeFile(ffmpeg, output))
  if (plan.muxer === 'mov' || plan.muxer === 'mp4') problems.push(...(await checkIsobmffBoxes(output)))

  const files = {
    inFrames: path.join(workDir, 'input.framemd5'),
    inHash: path.join(workDir, 'input.streamhash'),
    outFrames: path.join(workDir, 'output.framemd5'),
    outHash: path.join(workDir, 'output.streamhash'),
  }
  await run(ffmpeg, hashArgs(input, plan.kept.map((s) => s.index), files.inFrames, files.inHash), 'hashing the original packets')
  await run(ffmpeg, hashArgs(output, plan.kept.map((_, i) => i), files.outFrames, files.outHash), 'hashing the stripped packets')
  const inputHashes = parseStreamHash(await readFile(files.inHash, 'utf8'))
  const outputHashes = parseStreamHash(await readFile(files.outHash, 'utf8'))
  const compared = comparePackets(
    parseFrameMd5(await readFile(files.inFrames, 'utf8')),
    parseFrameMd5(await readFile(files.outFrames, 'utf8')),
    inputHashes,
    outputHashes,
  )
  problems.push(...compared.problems)
  if (problems.length > 0) throw new VideoStripError(`the stripped video failed its checks: ${problems.join('; ')}`)

  const notes = [...plan.notes]
  if (compared.timing.adjustedPackets > 0) {
    notes.push(
      `${compared.timing.adjustedPackets} packets with repeated time stamps in the original moved by at most ${(compared.timing.maxAdjustmentSeconds * 1000).toFixed(1)} ms (the muxer needs increasing time stamps)`,
    )
  }
  return {
    output,
    report: {
      muxer: plan.muxer,
      extension: plan.extension,
      mimeType: plan.mimeType,
      removed: plan.removed,
      notes,
      timing: compared.timing,
      streamSha256: outputHashes,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// In-place strip of QuickTime/MP4 files.

/** Stream metadata an in-place strip may leave: technical fields of the track and sample entry. */
const IN_PLACE_STREAM_KEYS = new Set(['handler_name', 'vendor_id', 'encoder', 'language'])

/** sha256 over every byte of the file outside `ranges` (sorted, merged), with the ranges' positions. */
async function hashOutside(reader: ByteReader, ranges: [number, number][]): Promise<string> {
  const hash = createHash('sha256')
  const chunk = 4 * 1024 * 1024
  for (const [start, end] of subtractRanges([[0, reader.size]], ranges)) {
    hash.update(`${start}-${end}:`)
    for (let at = start; at < end; at += chunk) hash.update(await reader.read(at, Math.min(chunk, end - at)))
  }
  return hash.digest('hex')
}

/** Problems when two framemd5/streamhash outputs are not exactly equal (no time stamp may move). */
export function exactPacketProblems(input: FrameMd5, output: FrameMd5, inputHashes: string[], outputHashes: string[]): string[] {
  const problems: string[] = []
  const count = Math.max(input.streams.length, output.streams.length)
  for (let s = 0; s < count; s++) {
    const a = input.streams[s] ?? []
    const b = output.streams[s] ?? []
    const codec = input.codecs[s] ?? '?'
    if (input.codecs[s] !== output.codecs[s]) problems.push(`stream ${s}: codec ${input.codecs[s]} became ${output.codecs[s]}`)
    if (!inputHashes[s] || inputHashes[s] !== outputHashes[s]) problems.push(`stream ${s} (${codec}): sha256 of the stream differs`)
    if (a.length === 0) problems.push(`stream ${s} (${codec}): no packets`)
    if (a.length !== b.length) {
      problems.push(`stream ${s} (${codec}): ${a.length} packets became ${b.length}`)
      continue
    }
    for (let i = 0; i < a.length; i++) {
      const p = a[i]
      const q = b[i]
      if (p.size !== q.size || p.md5 !== q.md5 || compare(p.dts, q.dts) !== 0 || compare(p.pts, q.pts) !== 0 || compare(p.duration, q.duration) !== 0) {
        problems.push(`stream ${s} (${codec}): packet ${i} differs`)
        break
      }
    }
  }
  return problems
}

/** Problems with the streams of the stripped file compared with the input's audio and video streams. */
export function inPlaceDescriptionProblems(input: ContainerDescription, output: ContainerDescription): string[] {
  const problems: string[] = []
  const kept = input.streams.filter((s) => s.kind === 'video' || s.kind === 'audio')
  if (output.streams.length !== kept.length) problems.push(`${output.streams.length} streams instead of ${kept.length}`)
  output.streams.forEach((s, i) => {
    const expected = kept[i]
    if (!expected) return
    if (s.kind !== expected.kind || s.codec !== expected.codec) problems.push(`stream ${i} is ${s.kind} ${s.codec}, expected ${expected.kind} ${expected.codec}`)
    if (s.details.join(', ') !== expected.details.join(', ')) problems.push(`stream ${i} changed from "${expected.details.join(', ')}" to "${s.details.join(', ')}"`)
    if (s.sideData.join('; ') !== expected.sideData.join('; ')) problems.push(`stream ${i} side data changed from "${expected.sideData.join('; ')}" to "${s.sideData.join('; ')}"`)
    if (s.dolbyVision !== expected.dolbyVision) problems.push(`stream ${i} ${expected.dolbyVision ? 'lost' : 'gained'} its Dolby Vision configuration`)
    const extra = s.metadataKeys.filter((k) => !IN_PLACE_STREAM_KEYS.has(k) || !expected.metadataKeys.includes(k))
    if (extra.length > 0) problems.push(`stream ${i} still has metadata: ${extra.join(', ')}`)
  })
  const extra = output.globalMetadataKeys.filter((k) => !['major_brand', 'minor_version', 'compatible_brands'].includes(k))
  if (extra.length > 0) problems.push(`file metadata left: ${extra.join(', ')}`)
  if (output.chapters > 0) problems.push(`${output.chapters} chapters left`)
  return problems
}

export type InPlaceStripOutcome =
  | {kind: 'clean'; plan: IsobmffVideoPlan}
  | {kind: 'stripped'; plan: IsobmffVideoPlan; removed: string[]; streamSha256: string[]}

/**
 * Strips the QuickTime/MP4 file at `file` in place (the caller's own copy of the upload) and
 * verifies it (see the top of this file). Returns `clean` without touching the file when it has
 * nothing personal. Throws IsobmffUnsupportedError (from the planner) for files the in-place
 * stripper refuses, VideoStripError when a check fails (the file is then unusable) and
 * VideoStripTimeoutError.
 */
export async function stripIsobmffInPlace(options: {ffmpeg: FfmpegRunner; file: string; workDir: string}): Promise<InPlaceStripOutcome> {
  const {ffmpeg, file, workDir} = options
  const handle = await open(file, 'r+')
  try {
    const reader = await fileHandleReader(handle)
    const plan = await planIsobmffStrip(reader)
    if (!plan.personal) return {kind: 'clean', plan}

    const before = await describeFile(ffmpeg, file)
    const media = before.streams.filter((s) => s.kind === 'video' || s.kind === 'audio')
    if (media.length !== plan.keptTracks.length) {
      throw new VideoStripError(`ffmpeg reads ${media.length} audio and video streams, the file has ${plan.keptTracks.length} audio and video tracks`)
    }
    const files = {
      inFrames: path.join(workDir, 'input.framemd5'),
      inHash: path.join(workDir, 'input.streamhash'),
      outFrames: path.join(workDir, 'output.framemd5'),
      outHash: path.join(workDir, 'output.streamhash'),
    }
    await run(ffmpeg, hashArgs(file, media.map((s) => s.index), files.inFrames, files.inHash), 'hashing the original packets')
    const outsideBefore = await hashOutside(reader, plan.changedRanges)

    await applyIsobmffPlanToFile(handle, plan)

    const problems: string[] = []
    if ((await hashOutside(reader, plan.changedRanges)) !== outsideBefore) problems.push('bytes outside the stripped ranges changed')
    problems.push(...(await checkStrippedIsobmff(reader)))
    problems.push(...inPlaceDescriptionProblems(before, await describeFile(ffmpeg, file)))
    await run(ffmpeg, hashArgs(file, media.map((_, i) => i), files.outFrames, files.outHash), 'hashing the stripped packets')
    const inputHashes = parseStreamHash(await readFile(files.inHash, 'utf8'))
    const outputHashes = parseStreamHash(await readFile(files.outHash, 'utf8'))
    problems.push(
      ...exactPacketProblems(
        parseFrameMd5(await readFile(files.inFrames, 'utf8')),
        parseFrameMd5(await readFile(files.outFrames, 'utf8')),
        inputHashes,
        outputHashes,
      ),
    )
    if (problems.length > 0) throw new VideoStripError(`the stripped video failed its checks: ${problems.join('; ')}`)
    return {kind: 'stripped', plan, removed: plan.removals.filter((r) => r.personal).map((r) => r.what), streamSha256: outputHashes}
  } finally {
    await handle.close()
  }
}
