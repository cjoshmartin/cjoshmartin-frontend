/**
 * Strips personal metadata from a video original in place, with the same stripper the video-to-mp4
 * Function uses (studio/functions/privacy/isobmff-video.ts), and proves that the picture and the
 * sound are untouched:
 *
 * - the stripped file has the same size, and every byte outside the ranges the stripper reports
 *   as changed is identical;
 * - every kept stream has the same packets: pts, dts, duration, flags (keyframes and the packets an
 *   edit list discards), size, byte position and sha256 of the data (`ffprobe -show_packets
 *   -show_data_hash sha256`);
 * - every kept stream has the same ffprobe description: codec and its configuration, size,
 *   colour (range, space, transfer, primaries), side data (display matrix rotation, Dolby Vision
 *   configuration, ambient viewing environment, ...), time base, start, duration and frame count.
 *   Only stream tags may be removed (those kept must be equal);
 * - the container has the same duration, start time and bit rate, only the kept streams, and only
 *   format tags were removed;
 * - a new scan (src/privacy/scan.ts) finds no personal tag, no data track, no metadata box with
 *   content, no creation time, no non-zero byte of `mdat` that no track uses and no location or
 *   device signature outside the samples.
 */
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'

import {
  applyIsobmffPlan,
  bufferReader,
  planIsobmffStrip,
  type IsobmffVideoPlan,
} from '../../../../studio/functions/privacy/isobmff-video'
import {runCommand} from '../video/ffmpeg'
import {stableStringify} from '../util'
import {scanLocalFile} from './scan'

interface ProbeStreamJson {
  index: number
  codec_type?: string
  tags?: Record<string, string>
  [key: string]: unknown
}

interface ProbeJson {
  streams: ProbeStreamJson[]
  format: {nb_streams?: number; duration?: string; start_time?: string; bit_rate?: string; size?: string; tags?: Record<string, string>; [key: string]: unknown}
}

async function ffprobeJson(file: string): Promise<ProbeJson> {
  const result = await runCommand('ffprobe', ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', file])
  if (result.code !== 0 || result.stderr.trim()) throw new Error(`ffprobe ${file} failed (exit ${result.code}): ${result.stderr.slice(-2000)}`)
  return JSON.parse(result.stdout) as ProbeJson
}

/** One line per packet of one stream: pts,dts,duration,flags,size,pos,data hash. */
export async function packetLines(file: string, streamIndex: number): Promise<string[]> {
  const result = await runCommand('ffprobe', [
    '-hide_banner', '-v', 'error', '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts,dts,duration,flags,size,pos,data_hash', '-show_data_hash', 'sha256',
    '-of', 'csv=p=0', file,
  ])
  if (result.code !== 0 || result.stderr.trim()) throw new Error(`ffprobe packets of ${file} stream ${streamIndex} failed: ${result.stderr.slice(-2000)}`)
  return result.stdout.split('\n').filter((line) => line.trim() !== '')
}

const isMedia = (s: ProbeStreamJson) => s.codec_type === 'video' || s.codec_type === 'audio'

export interface VideoVerification {
  /** Per kept stream: codec type, packet count and sha256 over its packet lines. */
  streams: {codecType: string; codecName: string; packets: number; packetsSha256: string}[]
  removedStreams: string[]
  removedFormatTags: string[]
  removedStreamTags: string[]
  /** Side data types of the kept streams (unchanged), e.g. "Display Matrix", "DOVI configuration record". */
  sideData: string[]
}

function without<T extends Record<string, unknown>>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)))
}

/** Proves that `stripped` is `original` with only metadata removed. Throws with every problem found. */
export async function verifyStrippedVideo(original: string, stripped: string, changedRanges: readonly [number, number][]): Promise<VideoVerification> {
  const problems: string[] = []
  const [a, b] = await Promise.all([readFile(original), readFile(stripped)])
  if (a.length !== b.length) problems.push(`size changed from ${a.length} to ${b.length}`)
  else {
    let at = 0
    for (const [start, end] of [...changedRanges, [a.length, a.length] as [number, number]]) {
      if (start < at) {
        problems.push(`changed ranges overlap at ${start}`)
        break
      }
      if (!a.subarray(at, start).equals(b.subarray(at, start))) problems.push(`bytes ${at}-${start} differ outside the stripped boxes`)
      at = end
    }
  }

  const [pa, pb] = await Promise.all([ffprobeJson(original), ffprobeJson(stripped)])
  const kept = pa.streams.filter(isMedia)
  const removedStreams = pa.streams.filter((s) => !isMedia(s)).map((s) => `${s.index}:${s.codec_type ?? '?'}/${String(s.codec_tag_string ?? '?')}`)
  if (pb.streams.length !== kept.length) problems.push(`${pb.streams.length} streams after, ${kept.length} audio and video streams before`)
  const removedStreamTags = new Set<string>()
  const streams: VideoVerification['streams'] = []
  const sideData = new Set<string>()
  for (const [i, before] of kept.entries()) {
    const after = pb.streams[i]
    if (!after) break
    const where = `stream ${before.index} (${before.codec_type})`
    if (stableStringify(without(before, ['index', 'tags'])) !== stableStringify(without(after, ['index', 'tags']))) {
      problems.push(`${where}: its description changed`)
    }
    for (const [key, value] of Object.entries(before.tags ?? {})) {
      if (!(key in (after.tags ?? {}))) removedStreamTags.add(key)
      else if (after.tags![key] !== value) problems.push(`${where}: tag ${key} changed`)
    }
    for (const key of Object.keys(after.tags ?? {})) if (!(key in (before.tags ?? {}))) problems.push(`${where}: tag ${key} was added`)
    for (const entry of (before.side_data_list as {side_data_type?: string}[] | undefined) ?? []) sideData.add(String(entry.side_data_type))
    const [packetsBefore, packetsAfter] = await Promise.all([packetLines(original, before.index), packetLines(stripped, after.index)])
    const joined = packetsBefore.join('\n')
    if (joined !== packetsAfter.join('\n')) problems.push(`${where}: packets differ`)
    if (packetsBefore.length === 0) problems.push(`${where}: no packets`)
    streams.push({
      codecType: String(before.codec_type),
      codecName: String(before.codec_name),
      packets: packetsBefore.length,
      packetsSha256: createHash('sha256').update(joined).digest('hex'),
    })
  }

  for (const key of ['duration', 'start_time', 'bit_rate', 'size', 'format_name'] as const) {
    if (pa.format[key] !== pb.format[key]) problems.push(`format ${key} changed from ${String(pa.format[key])} to ${String(pb.format[key])}`)
  }
  const removedFormatTags: string[] = []
  for (const [key, value] of Object.entries(pa.format.tags ?? {})) {
    if (!(key in (pb.format.tags ?? {}))) removedFormatTags.push(key)
    else if (pb.format.tags![key] !== value) {
      // ffprobe joins the values of a key found in several boxes with ";" (for example major_brand
      // from ftyp and from a removed moov/meta). Losing the removed box's value is not a change.
      const left = value.split(';')
      if (pb.format.tags![key]!.split(';').every((part) => left.includes(part))) removedFormatTags.push(`${key} (a duplicate value)`)
      else problems.push(`format tag ${key} changed`)
    }
  }
  for (const key of Object.keys(pb.format.tags ?? {})) if (!(key in (pa.format.tags ?? {}))) problems.push(`format tag ${key} was added`)

  const scan = await scanLocalFile(stripped)
  if (scan.unreadable) problems.push(`the stripped file cannot be checked: ${scan.unreadable}`)
  if (scan.findings.length) problems.push(`personal metadata remains: ${scan.findings.map((f) => f.tag).join(', ')}`)

  if (problems.length) throw new Error(`${stripped} is not a lossless strip of ${original}:\n- ${problems.join('\n- ')}`)
  return {
    streams,
    removedStreams,
    removedFormatTags: removedFormatTags.sort(),
    removedStreamTags: [...removedStreamTags].sort(),
    sideData: [...sideData].sort(),
  }
}

export interface VideoStripMethod {
  tool: 'isobmff'
  /** What was removed (box paths and track descriptions, never values). */
  removals: {what: string; bytes: number}[]
  /** Every byte range the stripper wrote to; the rest of the file is unchanged. */
  changedRanges: [number, number][]
  /** `mdat` bytes no kept track uses, and how many of them were not zero. */
  unreferenced: IsobmffVideoPlan['unreferenced']
}

/**
 * Writes the stripped copy of `input` to `output`; returns what the stripper did. Throws when the
 * video has nothing personal to remove: such a video is not copied.
 */
export async function stripVideo(input: string, output: string): Promise<VideoStripMethod> {
  const bytes = await readFile(input)
  const plan = await planIsobmffStrip(bufferReader(bytes))
  if (!plan.personal) throw new Error(`${input} has no personal metadata the video stripper removes`)
  await writeFile(output, applyIsobmffPlan(bytes, plan), {flag: 'wx'})
  return {
    tool: 'isobmff',
    removals: plan.removals.filter((r) => r.personal).map(({what, bytes}) => ({what, bytes})),
    changedRanges: plan.changedRanges,
    unreferenced: plan.unreferenced,
  }
}

/**
 * Problems found when comparing the audio and video packets of two files stream by stream (in
 * order); empty when every audio and video stream has the same packets. Data streams are ignored
 * (a stripped copy has none).
 */
export async function compareMediaPackets(original: string, other: string): Promise<string[]> {
  const [a, b] = await Promise.all([ffprobeJson(original), ffprobeJson(other)])
  const left = a.streams.filter(isMedia)
  const right = b.streams.filter(isMedia)
  if (left.length !== right.length) return [`${left.length} audio and video streams in ${original}, ${right.length} in ${other}`]
  const problems: string[] = []
  for (const [i, stream] of left.entries()) {
    const [x, y] = await Promise.all([packetLines(original, stream.index), packetLines(other, right[i]!.index)])
    if (x.length === 0) problems.push(`stream ${stream.index} has no packets`)
    if (x.join('\n') !== y.join('\n')) problems.push(`stream ${stream.index} (${stream.codec_type}) has other packets`)
  }
  return problems
}
