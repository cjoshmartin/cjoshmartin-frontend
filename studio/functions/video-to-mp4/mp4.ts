/**
 * Minimal ISO BMFF (MP4) reader for checking a converted file without ffprobe, which the Function
 * does not have. It reads the box layout, the movie duration and, per track, the handler, sample
 * entry, frame size, display matrix, sample count, the H.264 SPS (profile, chroma format, bit
 * depth) and the AAC configuration. verifyConvertedMp4 turns that into the list of problems that
 * make a conversion fail.
 */
import {open} from 'node:fs/promises'

import {MAX_DIMENSION} from './settings'

export interface TopLevelBox {
  type: string
  offset: number
  size: number
}

export interface AvcInfo {
  /** profile_idc: 66 Baseline, 77 Main, 100 High. */
  profileIdc: number
  /** 0 monochrome, 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4. */
  chromaFormatIdc: number
  bitDepthLuma: number
  bitDepthChroma: number
}

export interface AacInfo {
  /** MPEG-4 objectTypeIndication from the esds DecoderConfigDescriptor (0x40 = MPEG-4 audio). */
  objectTypeIndication: number
  /** Audio object type from the AudioSpecificConfig (2 = AAC LC). */
  audioObjectType: number
  /** channelConfiguration from the AudioSpecificConfig (2 = stereo). */
  channelConfiguration: number
}

export interface Mp4Track {
  handler: string
  sampleEntry: string | null
  sampleCount: number
  /** The display matrix of tkhd is the identity (no rotation or flip). */
  identityMatrix: boolean
  /** Coded frame size from the visual sample entry. */
  width?: number
  height?: number
  avc?: AvcInfo
  /** channelcount of the audio sample entry. */
  channelCount?: number
  aac?: AacInfo
}

export interface Mp4Summary {
  fileSize: number
  topLevel: TopLevelBox[]
  /** `moov` comes before the first `mdat` (`-movflags +faststart`). */
  faststart: boolean
  durationSeconds: number | null
  tracks: Mp4Track[]
}

export class Mp4FormatError extends Error {
  override name = 'Mp4FormatError'
}

interface Box {
  type: string
  /** Offset of the payload (after the header) in `data`. */
  start: number
  end: number
}

/** Child boxes of `data[start, end)`. */
function children(data: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) throw new Mp4FormatError(`truncated 64-bit box header for ${type}`)
      size = Number(data.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) {
      throw new Mp4FormatError(`box ${type} at ${offset} has invalid size ${size}`)
    }
    boxes.push({type, start: offset + header, end: offset + size})
    offset += size
  }
  return boxes
}

function child(data: Buffer, box: Box, type: string): Box | undefined {
  return children(data, box.start, box.end).find((b) => b.type === type)
}

function path(data: Buffer, box: Box, ...types: string[]): Box | undefined {
  let current: Box | undefined = box
  for (const type of types) {
    if (!current) return undefined
    current = child(data, current, type)
  }
  return current
}

/** Reads bits MSB first, for the SPS (Exp-Golomb) and the AudioSpecificConfig. */
class BitReader {
  private bit = 0
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.bit >> 3]
      if (byte === undefined) throw new Mp4FormatError('read past the end of a bitstream')
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1)
      this.bit += 1
    }
    return value
  }
  /** Unsigned Exp-Golomb code. */
  ue(): number {
    let zeros = 0
    while (this.read(1) === 0) {
      zeros += 1
      if (zeros > 31) throw new Mp4FormatError('invalid Exp-Golomb code')
    }
    return 2 ** zeros - 1 + (zeros > 0 ? this.read(zeros) : 0)
  }
}

/** Removes emulation prevention bytes (00 00 03 -> 00 00) from a NAL unit. */
function unescapeRbsp(nal: Buffer): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue
    out.push(nal[i])
  }
  return Uint8Array.from(out)
}

const HIGH_PROFILES_WITH_CHROMA_INFO = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
])

/** The first SPS in an avcC box: profile, chroma format and bit depth. */
export function parseAvcC(data: Buffer): AvcInfo {
  if (data.length < 7) throw new Mp4FormatError('avcC is too short')
  const spsCount = data[5] & 0x1f
  if (spsCount < 1) throw new Mp4FormatError('avcC has no SPS')
  const spsLength = data.readUInt16BE(6)
  const nal = data.subarray(8, 8 + spsLength)
  if (nal.length !== spsLength || spsLength < 4) throw new Mp4FormatError('avcC SPS is truncated')
  if ((nal[0] & 0x1f) !== 7) throw new Mp4FormatError('avcC does not start with an SPS NAL unit')
  const rbsp = unescapeRbsp(nal.subarray(1))
  const bits = new BitReader(rbsp)
  const profileIdc = bits.read(8)
  bits.read(8) // constraint flags
  bits.read(8) // level_idc
  bits.ue() // seq_parameter_set_id
  let chromaFormatIdc = 1
  let bitDepthLuma = 8
  let bitDepthChroma = 8
  if (HIGH_PROFILES_WITH_CHROMA_INFO.has(profileIdc)) {
    chromaFormatIdc = bits.ue()
    if (chromaFormatIdc === 3) bits.read(1) // separate_colour_plane_flag
    bitDepthLuma = bits.ue() + 8
    bitDepthChroma = bits.ue() + 8
  }
  return {profileIdc, chromaFormatIdc, bitDepthLuma, bitDepthChroma}
}

/** Descriptor tag and payload bounds at `offset` (ISO 14496-1 expandable size). */
function descriptor(data: Buffer, offset: number): {tag: number; start: number; end: number} {
  const tag = data[offset]
  let size = 0
  let i = offset + 1
  for (let n = 0; n < 4; n++, i++) {
    const byte = data[i]
    if (byte === undefined) throw new Mp4FormatError('truncated descriptor')
    size = (size << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      i += 1
      break
    }
  }
  if (i + size > data.length)
    throw new Mp4FormatError(`descriptor 0x${tag.toString(16)} overruns esds`)
  return {tag, start: i, end: i + size}
}

/** objectTypeIndication and AudioSpecificConfig from an esds payload (after version/flags). */
export function parseEsds(data: Buffer): AacInfo {
  const es = descriptor(data, 0)
  if (es.tag !== 0x03) throw new Mp4FormatError('esds has no ES_Descriptor')
  let offset = es.start + 2 // ES_ID
  const flags = data[offset]
  offset += 1
  if (flags & 0x80) offset += 2 // streamDependenceFlag
  if (flags & 0x40) offset += 1 + data[offset] // URL_Flag
  if (flags & 0x20) offset += 2 // OCRstreamFlag
  const config = descriptor(data, offset)
  if (config.tag !== 0x04) throw new Mp4FormatError('esds has no DecoderConfigDescriptor')
  const objectTypeIndication = data[config.start]
  const specific = descriptor(data, config.start + 13)
  if (specific.tag !== 0x05) throw new Mp4FormatError('esds has no DecoderSpecificInfo')
  const bits = new BitReader(data.subarray(specific.start, specific.end))
  let audioObjectType = bits.read(5)
  if (audioObjectType === 31) audioObjectType = 32 + bits.read(6)
  const frequencyIndex = bits.read(4)
  if (frequencyIndex === 15) bits.read(24)
  const channelConfiguration = bits.read(4)
  return {objectTypeIndication, audioObjectType, channelConfiguration}
}

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

function parseTrack(data: Buffer, trak: Box): Mp4Track {
  const tkhd = child(data, trak, 'tkhd')
  if (!tkhd) throw new Mp4FormatError('track without tkhd')
  const tkhdVersion = data[tkhd.start]
  const matrixOffset = tkhd.start + 4 + (tkhdVersion === 1 ? 32 : 20) + 8 + 8
  const matrix = Array.from({length: 9}, (_, i) => data.readUInt32BE(matrixOffset + i * 4))
  const identityMatrix = matrix.every((value, i) => value === IDENTITY_MATRIX[i])

  const hdlr = path(data, trak, 'mdia', 'hdlr')
  if (!hdlr) throw new Mp4FormatError('track without hdlr')
  const handler = data.toString('latin1', hdlr.start + 8, hdlr.start + 12)

  const stbl = path(data, trak, 'mdia', 'minf', 'stbl')
  if (!stbl) throw new Mp4FormatError(`${handler} track without stbl`)
  const stsz = child(data, stbl, 'stsz')
  const sampleCount = stsz ? data.readUInt32BE(stsz.start + 8) : 0
  const stsd = child(data, stbl, 'stsd')
  if (!stsd) throw new Mp4FormatError(`${handler} track without stsd`)
  const entries = children(data, stsd.start + 8, stsd.end)
  const entry = entries[0]
  const track: Mp4Track = {
    handler,
    sampleEntry: entry?.type ?? null,
    sampleCount,
    identityMatrix,
  }
  if (!entry) return track

  if (handler === 'vide') {
    track.width = data.readUInt16BE(entry.start + 24)
    track.height = data.readUInt16BE(entry.start + 26)
    const avcC = children(data, entry.start + 78, entry.end).find((b) => b.type === 'avcC')
    if (avcC) track.avc = parseAvcC(data.subarray(avcC.start, avcC.end))
  } else if (handler === 'soun') {
    track.channelCount = data.readUInt16BE(entry.start + 16)
    const esds = children(data, entry.start + 28, entry.end).find((b) => b.type === 'esds')
    if (esds) track.aac = parseEsds(data.subarray(esds.start + 4, esds.end))
  }
  return track
}

/** Reads the box layout of the file and parses its `moov`. */
export async function inspectMp4(file: string): Promise<Mp4Summary> {
  const handle = await open(file, 'r')
  try {
    const {size: fileSize} = await handle.stat()
    const topLevel: TopLevelBox[] = []
    const header = Buffer.alloc(16)
    let offset = 0
    while (offset < fileSize) {
      if (offset + 8 > fileSize)
        throw new Mp4FormatError(`${fileSize - offset} stray bytes at the end`)
      await handle.read(header, 0, 16, offset)
      let size = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (size === 1) size = Number(header.readBigUInt64BE(8))
      else if (size === 0) size = fileSize - offset
      if (size < 8 || offset + size > fileSize) {
        throw new Mp4FormatError(`top-level box ${type} at ${offset} has invalid size ${size}`)
      }
      topLevel.push({type, offset, size})
      offset += size
    }

    const moovBox = topLevel.find((box) => box.type === 'moov')
    const firstMdat = topLevel.find((box) => box.type === 'mdat')
    let durationSeconds: number | null = null
    const tracks: Mp4Track[] = []
    if (moovBox) {
      const data = Buffer.alloc(moovBox.size)
      await handle.read(data, 0, moovBox.size, moovBox.offset)
      const moov = children(data, 0, data.length)[0]
      const mvhd = child(data, moov, 'mvhd')
      if (mvhd) {
        const version = data[mvhd.start]
        const timescale = data.readUInt32BE(mvhd.start + (version === 1 ? 20 : 12))
        const duration =
          version === 1
            ? Number(data.readBigUInt64BE(mvhd.start + 24))
            : data.readUInt32BE(mvhd.start + 16)
        durationSeconds = timescale > 0 ? duration / timescale : null
      }
      for (const trak of children(data, moov.start, moov.end).filter((b) => b.type === 'trak')) {
        tracks.push(parseTrack(data, trak))
      }
    }
    return {
      fileSize,
      topLevel,
      faststart: Boolean(moovBox && firstMdat && moovBox.offset < firstMdat.offset),
      durationSeconds,
      tracks,
    }
  } finally {
    await handle.close()
  }
}

export interface Mp4Expectations {
  /** Expected frame size (expectedOutputSize of the displayed input size). */
  width: number
  height: number
  hasAudio: boolean
  /** Input duration in seconds, or null when the input did not report one. */
  inputDurationSeconds: number | null
}

/** Allowed difference between input and output duration. */
export function durationTolerance(seconds: number): number {
  return Math.max(0.5, seconds * 0.01)
}

/**
 * Problems that make the file unacceptable as a contract v2 MP4 (empty when it is fine): MP4 with
 * faststart, exactly one H.264 High 4:2:0 8-bit video track of the expected size with no
 * rotation, one AAC-LC stereo track exactly when the input has audio, no other tracks, and a
 * duration close to the input's.
 */
export function verifyConvertedMp4(summary: Mp4Summary, expected: Mp4Expectations): string[] {
  const problems: string[] = []
  const types = summary.topLevel.map((box) => box.type)
  if (types[0] !== 'ftyp') problems.push(`the file does not start with ftyp (${types.join(', ')})`)
  if (!types.includes('moov')) problems.push('no moov box')
  if (!types.includes('mdat')) problems.push('no mdat box')
  if (!summary.faststart) problems.push(`moov is not before mdat (${types.join(', ')})`)

  const video = summary.tracks.filter((t) => t.handler === 'vide')
  const audio = summary.tracks.filter((t) => t.handler === 'soun')
  const other = summary.tracks.filter((t) => t.handler !== 'vide' && t.handler !== 'soun')
  if (video.length !== 1) problems.push(`${video.length} video tracks instead of 1`)
  if (other.length > 0)
    problems.push(`unexpected tracks: ${other.map((t) => t.handler).join(', ')}`)

  const v = video[0]
  if (v) {
    if (v.sampleEntry !== 'avc1') problems.push(`video sample entry is ${v.sampleEntry}, not avc1`)
    if (!v.avc) problems.push('the video track has no avcC')
    else {
      if (v.avc.profileIdc !== 100)
        problems.push(`H.264 profile_idc ${v.avc.profileIdc}, not 100 (High)`)
      if (v.avc.chromaFormatIdc !== 1)
        problems.push(`chroma_format_idc ${v.avc.chromaFormatIdc}, not 1 (4:2:0)`)
      if (v.avc.bitDepthLuma !== 8 || v.avc.bitDepthChroma !== 8) {
        problems.push(`bit depth ${v.avc.bitDepthLuma}/${v.avc.bitDepthChroma}, not 8 (yuv420p)`)
      }
    }
    if (v.width !== expected.width || v.height !== expected.height) {
      problems.push(
        `frame size ${v.width}x${v.height}, expected ${expected.width}x${expected.height}`,
      )
    }
    if (v.width !== undefined && v.height !== undefined) {
      if (v.width % 2 !== 0 || v.height % 2 !== 0)
        problems.push(`odd frame size ${v.width}x${v.height}`)
      if (Math.max(v.width, v.height) > MAX_DIMENSION) {
        problems.push(`longest side ${Math.max(v.width, v.height)} is above ${MAX_DIMENSION}`)
      }
    }
    if (!v.identityMatrix) problems.push('the video track still has a rotation (display matrix)')
    if (v.sampleCount < 1) problems.push('the video track has no frames')
  }

  if (expected.hasAudio) {
    if (audio.length !== 1) problems.push(`${audio.length} audio tracks instead of 1`)
    const a = audio[0]
    if (a) {
      if (a.sampleEntry !== 'mp4a')
        problems.push(`audio sample entry is ${a.sampleEntry}, not mp4a`)
      if (!a.aac) problems.push('the audio track has no esds')
      else {
        if (a.aac.objectTypeIndication !== 0x40) {
          problems.push(
            `audio objectTypeIndication 0x${a.aac.objectTypeIndication.toString(16)}, not 0x40 (AAC)`,
          )
        }
        if (a.aac.audioObjectType !== 2)
          problems.push(`AAC object type ${a.aac.audioObjectType}, not 2 (LC)`)
        if (a.aac.channelConfiguration !== 2) {
          problems.push(`AAC channel configuration ${a.aac.channelConfiguration}, not 2 (stereo)`)
        }
      }
      if (a.channelCount !== 2) problems.push(`audio channel count ${a.channelCount}, not 2`)
      if (a.sampleCount < 1) problems.push('the audio track has no samples')
    }
  } else if (audio.length > 0) {
    problems.push(`${audio.length} audio tracks, but the input has no audio`)
  }

  if (summary.durationSeconds === null) problems.push('no movie duration')
  else if (expected.inputDurationSeconds !== null) {
    const difference = Math.abs(summary.durationSeconds - expected.inputDurationSeconds)
    if (difference > durationTolerance(expected.inputDurationSeconds)) {
      problems.push(
        `duration ${summary.durationSeconds.toFixed(2)} s, input ${expected.inputDurationSeconds.toFixed(2)} s`,
      )
    }
  }
  return problems
}
