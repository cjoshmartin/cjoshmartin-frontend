/**
 * Runs ffmpeg and ffprobe for the video conversion (steps/convert.ts) and checks converted MP4s
 * against the contract (docs/sanity-migration/schema-contract.md, "MP4 settings").
 *
 * The conversion arguments come only from studio/functions/video-to-mp4/settings.ts, the single
 * source of truth that the video-to-mp4 Sanity Function uses too. The checks here are independent
 * of those arguments: they read the output with ffprobe, parse its top-level MP4 boxes and decode
 * every frame.
 */
import {spawn} from 'node:child_process'
import {open} from 'node:fs/promises'

import {
  AUDIO_CHANNELS,
  buildFfmpegArgs,
  expectedOutputSize,
  MAX_DIMENSION,
  type VideoSize,
  type X264Preset,
} from '../../../../studio/functions/video-to-mp4/settings'

/** Largest allowed difference between input and output durations, in seconds. */
export const DURATION_TOLERANCE_SECONDS = 0.1

/** Format tags an MP4 written by ffmpeg may carry; anything else was copied from the input. */
const ALLOWED_FORMAT_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder'])

/** Stream tags the mp4 muxer and the encoders write themselves. */
const ALLOWED_STREAM_TAGS = new Set(['language', 'handler_name', 'vendor_id', 'encoder'])

export interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  duration?: string
  nb_frames?: string
  nb_read_frames?: string
  channels?: number
  bit_rate?: string
  color_transfer?: string
  color_primaries?: string
  color_range?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
  side_data_list?: {side_data_type?: string; rotation?: number}[]
}

export interface ProbeResult {
  streams: ProbeStream[]
  format: {
    format_name?: string
    duration?: string
    size?: string
    bit_rate?: string
    tags?: Record<string, string>
  }
}

export interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Runs a command asynchronously (never through a shell) and collects its output. */
export function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']})
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) =>
      resolve({code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')}),
    )
  })
}

async function runOrThrow(command: string, args: readonly string[]): Promise<CommandResult> {
  const result = await runCommand(command, args)
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.code ?? result.signal}:\n${(result.stderr || result.stdout).slice(-4000)}`,
    )
  }
  return result
}

/** First line of `ffmpeg -version`, e.g. "ffmpeg version 9.0.1 Copyright ...". */
export async function toolVersion(tool: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const {stdout} = await runOrThrow(tool, ['-hide_banner', '-version'])
  const line = stdout.split('\n')[0]?.trim()
  if (!line) throw new Error(`${tool} -version printed nothing`)
  return line
}

/**
 * ffprobe's JSON for a file. With `countFrames`, ffprobe decodes every frame of every stream
 * (`nb_read_frames`), and anything it reports on stderr at level "error" fails the probe.
 */
export async function probe(file: string, options: {countFrames?: boolean} = {}): Promise<ProbeResult> {
  const args = ['-hide_banner', '-v', 'error', ...(options.countFrames ? ['-count_frames'] : []), '-show_format', '-show_streams', '-print_format', 'json', file]
  const result = await runOrThrow('ffprobe', args)
  if (options.countFrames && result.stderr.trim()) {
    throw new Error(`ffprobe reported errors while decoding ${file}:\n${result.stderr.slice(-4000)}`)
  }
  return JSON.parse(result.stdout) as ProbeResult
}

/** The stream ffmpeg's `-map 0:V:0` selects: the first video stream that is not cover art. */
export function primaryVideoStream(result: ProbeResult): ProbeStream | undefined {
  return result.streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic && !s.disposition?.timed_thumbnails,
  )
}

/** The stream ffmpeg's `-map 0:a:0` selects. */
export function primaryAudioStream(result: ProbeResult): ProbeStream | undefined {
  return result.streams.find((s) => s.codec_type === 'audio')
}

/** Rotation of a stream in degrees from its display matrix (0 when it has none). */
export function streamRotation(stream: ProbeStream): number {
  const fromSideData = stream.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation
  if (typeof fromSideData === 'number') return fromSideData
  const fromTag = stream.tags?.rotate
  return fromTag === undefined ? 0 : Number(fromTag)
}

/** The size a player shows: the coded size, with width and height swapped for ±90° rotations. */
export function displayedSize(stream: ProbeStream): VideoSize {
  const {width, height} = stream
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`video stream ${stream.index} has no width or height`)
  }
  const rotation = streamRotation(stream)
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) {
    throw new Error(`video stream ${stream.index} has an unsupported rotation of ${rotation} degrees`)
  }
  const quarterTurns = ((rotation / 90) % 4 + 4) % 4
  return quarterTurns % 2 === 1 ? {width: height!, height: width!} : {width: width!, height: height!}
}

function seconds(value: string | undefined): number | undefined {
  if (value === undefined || value === 'N/A') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** What the converter needs to know about an input, and what its output is checked against. */
export interface InputSummary {
  formatName: string
  durationSeconds: number
  video: {
    index: number
    codec: string
    width: number
    height: number
    rotation: number
    displayed: VideoSize
    durationSeconds: number
    pixelFormat: string
    colorTransfer: string | null
  }
  audio: {index: number; codec: string; channels: number; durationSeconds: number} | null
  /** Duration of the streams the conversion keeps (the video and, if any, the audio). */
  mappedDurationSeconds: number
  /** Streams the conversion drops (data, subtitles, extra audio or video). */
  droppedStreams: string[]
}

export function summarizeInput(result: ProbeResult, file: string): InputSummary {
  const video = primaryVideoStream(result)
  if (!video) throw new Error(`${file} has no video stream`)
  const audio = primaryAudioStream(result)
  const formatDuration = seconds(result.format.duration)
  if (formatDuration === undefined) throw new Error(`${file} has no duration`)
  // A stream without its own duration (some containers) lasts as long as the file.
  const videoDuration = seconds(video.duration) ?? formatDuration
  const audioDuration = audio ? (seconds(audio.duration) ?? formatDuration) : undefined
  return {
    formatName: result.format.format_name ?? 'unknown',
    durationSeconds: formatDuration,
    video: {
      index: video.index,
      codec: video.codec_name ?? 'unknown',
      width: video.width!,
      height: video.height!,
      rotation: streamRotation(video),
      displayed: displayedSize(video),
      durationSeconds: videoDuration,
      pixelFormat: video.pix_fmt ?? 'unknown',
      colorTransfer: video.color_transfer ?? null,
    },
    audio: audio
      ? {index: audio.index, codec: audio.codec_name ?? 'unknown', channels: audio.channels ?? 0, durationSeconds: audioDuration!}
      : null,
    mappedDurationSeconds: Math.max(videoDuration, audioDuration ?? 0),
    droppedStreams: result.streams
      .filter((s) => s !== video && s !== audio)
      .map((s) => `${s.index}:${s.codec_type ?? 'unknown'}${s.codec_name ? `/${s.codec_name}` : ''}`),
  }
}

/** The full ffmpeg command line (without the executable) for one conversion. */
export function conversionArgs(options: {input: string; output: string; preset: X264Preset; hasAudio: boolean}): string[] {
  // -loglevel is a global option, so it goes before the input; the settings' own arguments follow
  // unchanged.
  return ['-loglevel', 'error', ...buildFfmpegArgs(options)]
}

/** Converts `input` to `output` with the contract settings. ffmpeg runs asynchronously. */
export async function convertToMp4(options: {input: string; output: string; preset: X264Preset; hasAudio: boolean}): Promise<void> {
  const result = await runCommand('ffmpeg', conversionArgs(options))
  if (result.code !== 0) {
    throw new Error(`ffmpeg failed on ${options.input} (exit ${result.code ?? result.signal}):\n${result.stderr.slice(-4000)}`)
  }
}

/** Top-level box types of an ISO BMFF (MP4) file, in file order. */
export async function topLevelBoxes(file: string): Promise<string[]> {
  const handle = await open(file, 'r')
  try {
    const {size} = await handle.stat()
    const boxes: string[] = []
    const header = Buffer.alloc(16)
    let offset = 0
    while (offset < size) {
      const {bytesRead} = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) throw new Error(`${file}: truncated box header at byte ${offset}`)
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (boxSize === 1) {
        if (bytesRead < 16) throw new Error(`${file}: truncated 64-bit box size at byte ${offset}`)
        boxSize = Number(header.readBigUInt64BE(8))
      } else if (boxSize === 0) {
        boxSize = size - offset
      }
      if (boxSize < 8 || offset + boxSize > size) throw new Error(`${file}: box "${type}" at byte ${offset} has an invalid size ${boxSize}`)
      boxes.push(type)
      offset += boxSize
    }
    return boxes
  } finally {
    await handle.close()
  }
}

/** Decodes every stream of a file with ffmpeg; any decoder error fails. */
export async function decodeErrors(file: string): Promise<string> {
  const result = await runCommand('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', file, '-map', '0', '-f', 'null', '-'])
  if (result.code !== 0) return `exit ${result.code ?? result.signal}: ${result.stderr.trim().slice(-2000)}`
  return result.stderr.trim()
}

export interface OutputSummary {
  width: number
  height: number
  durationSeconds: number
  videoDurationSeconds: number
  audioDurationSeconds: number | null
  videoFrames: number
  profile: string
  pixelFormat: string
  colorTransfer: string | null
  audioCodec: string | null
  audioChannels: number | null
  boxes: string[]
}

/** One failed check: a stable id (for listing known deviations) and what was measured. */
export interface VerificationProblem {
  check:
    | 'probe'
    | 'streams'
    | 'container'
    | 'faststart'
    | 'metadata'
    | 'codec'
    | 'profile'
    | 'pixelFormat'
    | 'evenDimensions'
    | 'maxDimension'
    | 'dimensions'
    | 'rotation'
    | 'frames'
    | 'videoDuration'
    | 'audioCodec'
    | 'audioChannels'
    | 'audioDuration'
    | 'fileDuration'
    | 'decode'
  message: string
}

export interface VerificationResult {
  ok: boolean
  problems: VerificationProblem[]
  output: OutputSummary | null
}

export function describeProblems(problems: readonly VerificationProblem[]): string {
  return problems.map((p) => `${p.check}: ${p.message}`).join('; ')
}

/** Number of frames of the stream ffmpeg's `-map 0:V:0` selects, by decoding them. */
export async function countVideoFrames(file: string, input: InputSummary): Promise<number> {
  const result = await runOrThrow('ffprobe', [
    '-hide_banner', '-v', 'error', '-count_frames', '-select_streams', String(input.video.index),
    '-show_entries', 'stream=nb_read_frames', '-print_format', 'json', file,
  ])
  const frames = Number((JSON.parse(result.stdout) as ProbeResult).streams[0]?.nb_read_frames)
  if (!Number.isInteger(frames)) throw new Error(`ffprobe could not count the frames of ${file}`)
  return frames
}

/**
 * Checks a converted MP4 against the contract and its input:
 * H.264 High, yuv420p, longest side at most MAX_DIMENSION, even dimensions that equal
 * expectedOutputSize of the input's displayed size, no rotation left, moov before mdat
 * (faststart), stereo AAC only when the input had audio and no other streams, no metadata copied
 * from the input, durations within DURATION_TOLERANCE_SECONDS, and every frame decodes without an
 * error (with as many frames read as the header declares).
 */
export async function verifyMp4(file: string, input: InputSummary): Promise<VerificationResult> {
  const problems: VerificationProblem[] = []
  const expect = (condition: boolean, check: VerificationProblem['check'], message: string) => {
    if (!condition) problems.push({check, message})
  }

  let result: ProbeResult
  try {
    result = await probe(file, {countFrames: true})
  } catch (error) {
    return {ok: false, problems: [{check: 'probe', message: error instanceof Error ? error.message : String(error)}], output: null}
  }
  const videos = result.streams.filter((s) => s.codec_type === 'video')
  const audios = result.streams.filter((s) => s.codec_type === 'audio')
  const others = result.streams.filter((s) => s.codec_type !== 'video' && s.codec_type !== 'audio')
  expect(videos.length === 1, 'streams', `${videos.length} video streams, expected 1`)
  expect(audios.length === (input.audio ? 1 : 0), 'streams', `${audios.length} audio streams, expected ${input.audio ? 1 : 0} (input ${input.audio ? 'has' : 'has no'} audio)`)
  expect(others.length === 0, 'streams', `extra streams: ${others.map((s) => `${s.index}:${s.codec_type}`).join(', ')}`)
  const video = videos[0]
  const audio = audios[0]
  const formatDuration = seconds(result.format.duration)
  expect((result.format.format_name ?? '').split(',').includes('mp4'), 'container', `container ${result.format.format_name}, expected mp4`)

  const boxes = await topLevelBoxes(file)
  const moov = boxes.indexOf('moov')
  const mdat = boxes.indexOf('mdat')
  expect(moov >= 0 && mdat >= 0 && moov < mdat, 'faststart', `top-level boxes ${boxes.join(', ')}: moov must come before mdat (faststart)`)

  const unexpectedFormatTags = Object.keys(result.format.tags ?? {}).filter((tag) => !ALLOWED_FORMAT_TAGS.has(tag))
  expect(unexpectedFormatTags.length === 0, 'metadata', `metadata copied from the input: ${unexpectedFormatTags.join(', ')}`)
  for (const stream of result.streams) {
    const extra = Object.keys(stream.tags ?? {}).filter((tag) => !ALLOWED_STREAM_TAGS.has(tag))
    expect(extra.length === 0, 'metadata', `stream ${stream.index} has metadata copied from the input: ${extra.join(', ')}`)
  }

  if (video) {
    const width = video.width ?? 0
    const height = video.height ?? 0
    const expected = expectedOutputSize(input.video.displayed)
    expect(video.codec_name === 'h264', 'codec', `video codec ${video.codec_name}, expected h264`)
    expect(video.profile === 'High', 'profile', `H.264 profile ${video.profile}, expected High`)
    expect(video.pix_fmt === 'yuv420p', 'pixelFormat', `pixel format ${video.pix_fmt}, expected yuv420p`)
    expect(width % 2 === 0 && height % 2 === 0, 'evenDimensions', `odd dimensions ${width}x${height}`)
    expect(Math.max(width, height) <= MAX_DIMENSION, 'maxDimension', `${width}x${height} is larger than ${MAX_DIMENSION} px`)
    expect(width === expected.width && height === expected.height, 'dimensions', `${width}x${height}, expected ${expected.width}x${expected.height} for a displayed input of ${input.video.displayed.width}x${input.video.displayed.height}`)
    expect(streamRotation(video) === 0, 'rotation', `rotation ${streamRotation(video)} left in the output`)
    const declared = Number(video.nb_frames)
    const read = Number(video.nb_read_frames)
    expect(Number.isInteger(read) && read > 0, 'frames', `no frames could be decoded (nb_read_frames ${video.nb_read_frames})`)
    expect(declared === read, 'frames', `the header declares ${video.nb_frames} frames, ${video.nb_read_frames} decoded`)
    const videoDuration = seconds(video.duration)
    expect(
      videoDuration !== undefined && Math.abs(videoDuration - input.video.durationSeconds) <= DURATION_TOLERANCE_SECONDS,
      'videoDuration',
      `video lasts ${videoDuration ?? 'unknown'} s, input video ${input.video.durationSeconds} s`,
    )
  }
  if (audio) {
    expect(audio.codec_name === 'aac', 'audioCodec', `audio codec ${audio.codec_name}, expected aac`)
    expect(audio.channels === AUDIO_CHANNELS, 'audioChannels', `${audio.channels} audio channels, expected ${AUDIO_CHANNELS}`)
    const audioDuration = seconds(audio.duration)
    expect(
      input.audio !== null && audioDuration !== undefined && Math.abs(audioDuration - input.audio.durationSeconds) <= DURATION_TOLERANCE_SECONDS,
      'audioDuration',
      `audio lasts ${audioDuration ?? 'unknown'} s, input audio ${input.audio?.durationSeconds ?? 'none'} s`,
    )
  }
  expect(
    formatDuration !== undefined && Math.abs(formatDuration - input.mappedDurationSeconds) <= DURATION_TOLERANCE_SECONDS,
    'fileDuration',
    `file lasts ${formatDuration ?? 'unknown'} s, input ${input.mappedDurationSeconds} s (video and audio kept)`,
  )

  const decodeOutput = await decodeErrors(file)
  expect(decodeOutput === '', 'decode', `decoding reported errors: ${decodeOutput}`)

  return {
    ok: problems.length === 0,
    problems,
    output: video
      ? {
          width: video.width ?? 0,
          height: video.height ?? 0,
          durationSeconds: formatDuration ?? 0,
          videoDurationSeconds: seconds(video.duration) ?? 0,
          audioDurationSeconds: audio ? (seconds(audio.duration) ?? 0) : null,
          videoFrames: Number(video.nb_read_frames),
          profile: video.profile ?? 'unknown',
          pixelFormat: video.pix_fmt ?? 'unknown',
          colorTransfer: video.color_transfer ?? null,
          audioCodec: audio?.codec_name ?? null,
          audioChannels: audio?.channels ?? null,
          boxes,
        }
      : null,
  }
}
