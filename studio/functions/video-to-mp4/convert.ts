/**
 * Converts one upload to an MP4 with the fixed settings (settings.ts) and verifies the result.
 * No Sanity client here: the input is a URL, the output a local file (see sanity.ts for the
 * upload). Every expected failure is a ConversionFailure whose message is shown to the editor.
 */
import {createWriteStream} from 'node:fs'
import {mkdir, readdir, rm, stat, statfs} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {checkIsobmffBoxes} from '../privacy/video-strip'
import {runFfmpeg, sha1File} from './ffmpeg'
import {FrameTimesCollector, frameTimeProblems, SHOWINFO_FILTER, type FrameTimes} from './frames'
import {
  ffmpegErrorLines,
  isInformationalLogLine,
  parseFfmpegInputDescription,
  UnreadableInputError,
  type InputDescription,
} from './media-info'
import {inspectMp4, verifyConvertedMp4, type Mp4Summary} from './mp4'
import {ConversionFailure, RetryableConversionError} from './orchestrator'
import {startRangeProxy, type RangeProxy} from './range-proxy'
import {buildFfmpegArgs, expectedOutputSize, type VideoSize, type X264Preset} from './settings'

/** Uploads up to this size are downloaded to /tmp (512 MB in Lambda) before conversion. */
export const DOWNLOAD_LIMIT_BYTES = 400 * 1000 * 1000

/** Least space kept free in /tmp for the MP4 when downloading the input. */
const OUTPUT_HEADROOM_BYTES = 64 * 1000 * 1000

/**
 * Space kept free in /tmp for the MP4, as a multiple of the input size, when downloading the
 * input. CRF 23 makes low-bitrate inputs larger: the largest of the 29 Wagtail videos grew by 46 %
 * (media 12, 2.08 to 3.03 MiB), so the input and an MP4 one and a half times its size must both fit.
 */
const OUTPUT_SIZE_RATIO = 1.5

/**
 * How ffmpeg reads the upload: downloaded to /tmp when the upload, plus room for an MP4 up to
 * OUTPUT_SIZE_RATIO times its size, fits in the free space (and the upload is at most `limit`);
 * otherwise through the range proxy, so only the MP4 is written to /tmp.
 */
export function chooseInputMode(
  size: number | undefined,
  freeBytes: number,
  limit: number = DOWNLOAD_LIMIT_BYTES,
): 'download' | 'proxy' {
  if (size === undefined || size > limit) return 'proxy'
  const outputRoom = Math.max(OUTPUT_HEADROOM_BYTES, Math.ceil(size * OUTPUT_SIZE_RATIO))
  return size + outputRoom <= freeBytes ? 'download' : 'proxy'
}

/** ffmpeg's message when a write fails because the disk is full (ENOSPC). */
const NO_SPACE = /No space left on device/i

export const WORK_DIR_PREFIX = 'video-to-mp4-'

export interface SourceVideo {
  assetId: string
  url: string
  size?: number
  sha1hash?: string
  mimeType?: string
  originalFilename?: string
}

export interface ConvertOptions {
  ffmpegPath: string
  preset: X264Preset
  /** Epoch ms by which all work must have stopped (ffmpeg is killed then). */
  deadline: number
  /** Directory for work directories; os.tmpdir() by default. */
  tmpDir?: string
  /** Inputs larger than this are streamed through the range proxy instead of downloaded. */
  downloadLimitBytes?: number
  log?: (message: string) => void
  fetchImpl?: typeof fetch
}

export interface ConvertedVideo {
  /** Local path of the MP4 (inside workDir). */
  outputPath: string
  workDir: string
  outputBytes: number
  sha1: string
  input: InputDescription & {video: NonNullable<InputDescription['video']>}
  inputMode: 'download' | 'proxy'
  output: Mp4Summary
  expectedSize: VideoSize
  /** Decoded frames of the input video stream and of the MP4, all at the same times. */
  frames: {input: number; output: number}
  timings: Record<string, number>
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' / ')
}

/** Removes work directories a killed run left in this container's /tmp. */
export async function removeStaleWorkDirs(tmpDir: string): Promise<string[]> {
  const removed: string[] = []
  for (const entry of await readdir(tmpDir, {withFileTypes: true})) {
    if (entry.isDirectory() && entry.name.startsWith(WORK_DIR_PREFIX)) {
      await rm(path.join(tmpDir, entry.name), {recursive: true, force: true})
      removed.push(entry.name)
    }
  }
  return removed
}

export async function download(
  source: SourceVideo,
  file: string,
  deadline: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(source.url, {
        headers: {'accept-encoding': 'identity'},
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file))
      const {size} = await stat(file)
      if (source.size !== undefined && size !== source.size) {
        throw new Error(`got ${size} bytes, the asset has ${source.size}`)
      }
      if (source.sha1hash) {
        const sha1 = await sha1File(file)
        if (sha1 !== source.sha1hash)
          throw new Error(`sha1 ${sha1} differs from the asset's ${source.sha1hash}`)
      }
      return
    } catch (error) {
      if (attempt === attempts || Date.now() >= deadline) {
        throw new RetryableConversionError(
          `the uploaded file could not be downloaded (${(error as Error).message})`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
}

/** `ffmpeg -i` without an output: prints the stream list and exits 1 by design. */
export async function describeInput(
  ffmpegPath: string,
  input: string,
  deadline: number,
): Promise<InputDescription> {
  const result = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-i', input], deadline)
  if (result.killedAtDeadline) {
    throw new RetryableConversionError('reading the file took until the time limit')
  }
  try {
    return parseFfmpegInputDescription(result.stderr)
  } catch (error) {
    if (error instanceof UnreadableInputError) {
      throw new ConversionFailure(`This file could not be read as a video: ${error.message}`)
    }
    throw error
  }
}

/**
 * Output options of the `-f null` outputs that only decode: every frame keeps its own time.
 * Otherwise ffmpeg retimes a variable-frame-rate video to 1/average frame rate for the null muxer
 * and logs "non monotonically increasing dts" errors that are about that retiming, not the file.
 */
const NULL_OUTPUT_TIMING = ['-fps_mode:v', 'passthrough', '-enc_time_base:v', 'demux']

/**
 * Routes the stderr lines of an ffmpeg run with `-loglevel level+info`: showinfo lines go to
 * `frames`, other informational lines are dropped, and warnings and errors are kept.
 */
function logRouter(frames: FrameTimesCollector): (line: string) => boolean {
  return (line) => frames.push(line) || isInformationalLogLine(line)
}

/**
 * Decodes the whole MP4 once, so a file that cannot be played fails the conversion, and returns
 * the time of every decoded video frame.
 */
async function decodeCheck(
  ffmpegPath: string,
  file: string,
  deadline: number,
): Promise<FrameTimes> {
  const frames = new FrameTimesCollector()
  const result = await runFfmpeg(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-loglevel',
      'level+info',
      '-xerror',
      '-i',
      file,
      '-map',
      '0',
      '-vf',
      SHOWINFO_FILTER,
      ...NULL_OUTPUT_TIMING,
      '-f',
      'null',
      '-',
    ],
    deadline,
    {onStderrLine: logRouter(frames)},
  )
  if (result.killedAtDeadline) {
    throw new ConversionFailure('Ran out of time while checking the converted MP4.')
  }
  if (result.code !== 0) {
    throw new ConversionFailure(
      `The converted MP4 does not decode cleanly: ${ffmpegErrorLines(result.stderr, 3).join(' / ') || lastLines(result.stderr, 3) || `exit code ${result.code}`}`,
    )
  }
  return frames.result()
}

export async function convertToMp4(
  source: SourceVideo,
  options: ConvertOptions,
): Promise<ConvertedVideo> {
  const log = options.log ?? (() => undefined)
  const fetchImpl = options.fetchImpl ?? fetch
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const limit = options.downloadLimitBytes ?? DOWNLOAD_LIMIT_BYTES
  const {deadline, ffmpegPath, preset} = options
  const timings: Record<string, number> = {}
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    try {
      return await work()
    } finally {
      timings[name] = Date.now() - started
    }
  }

  if (source.mimeType !== undefined && !source.mimeType.startsWith('video/')) {
    throw new ConversionFailure(
      `This file is not a video (${source.mimeType}). Upload a video file.`,
    )
  }

  const workDir = path.join(tmpDir, `${WORK_DIR_PREFIX}${process.pid}-${Date.now()}`)
  await mkdir(workDir, {recursive: true})
  let proxy: RangeProxy | undefined
  const closeProxy = async () => {
    if (!proxy) return
    const closing = proxy
    proxy = undefined
    await closing.close()
    log(
      `${source.assetId}: range proxy served ${closing.stats.requests} requests, ${closing.stats.bytes} bytes, ${closing.stats.resumes} resumes`,
    )
  }
  try {
    const free = await statfs(tmpDir)
    const freeBytes = free.bavail * free.bsize
    const size = source.size
    let inputMode = chooseInputMode(size, freeBytes, limit)
    const outputPath = path.join(workDir, 'output.mp4')

    /** Makes the input available to ffmpeg in `mode`: a local file or the range proxy's URL. */
    const openInput = async (mode: 'download' | 'proxy'): Promise<string> => {
      if (mode === 'download') {
        const extension = path
          .extname(source.originalFilename ?? '')
          .toLowerCase()
          .replace(/[^.a-z0-9]/g, '')
        const file = path.join(workDir, `input${extension || '.bin'}`)
        await timed('downloadMs', () => download(source, file, deadline, fetchImpl))
        return file
      }
      proxy = await startRangeProxy(source.url, {
        fetchImpl,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      log(`${source.assetId}: ${size ?? 'unknown'} bytes; ffmpeg reads it through the range proxy`)
      return proxy.url
    }

    let input = await openInput(inputMode)
    const description = await timed('describeMs', () => describeInput(ffmpegPath, input, deadline))
    const video = description.video
    if (!video) {
      throw new ConversionFailure(
        description.audioStreams > 0
          ? `This file has no video stream, only audio (${description.firstAudioCodec}). Upload a video file.`
          : `This file could not be read as a video: ffmpeg found no video or audio stream in it (read as ${description.format}). Upload a video file.`,
      )
    }
    const expectedSize = expectedOutputSize({
      width: video.displayWidth,
      height: video.displayHeight,
    })

    let inputFrames = new FrameTimesCollector()
    const encode = async (from: string) => {
      inputFrames = new FrameTimesCollector()
      const args = [
        // Level tags let logRouter separate the showinfo lines from warnings and errors.
        '-loglevel',
        'level+info',
        '-nostats',
        ...buildFfmpegArgs({
          input: from,
          output: outputPath,
          preset,
          hasAudio: description.hasAudio,
        }),
        // A second output that only logs the time of every decoded input frame, from the same
        // decode, for the frame check below. It does not change the MP4.
        '-map',
        '0:V:0',
        '-vf',
        SHOWINFO_FILTER,
        ...NULL_OUTPUT_TIMING,
        '-f',
        'null',
        '-',
      ]
      return runFfmpeg(ffmpegPath, args, deadline, {onStderrLine: logRouter(inputFrames)})
    }
    let result = await timed('encodeMs', () => encode(input))
    if (
      inputMode === 'download' &&
      result.code !== 0 &&
      !result.killedAtDeadline &&
      NO_SPACE.test(result.stderr)
    ) {
      // The MP4 did not fit next to the downloaded upload. Free the space and read the upload
      // through the range proxy instead, so only the MP4 is in /tmp.
      log(
        `${source.assetId}: /tmp is full with the download; converting again through the range proxy`,
      )
      await rm(workDir, {recursive: true, force: true})
      await mkdir(workDir, {recursive: true})
      inputMode = 'proxy'
      input = await openInput(inputMode)
      result = await timed('encodeRetryMs', () => encode(input))
    }
    if (result.killedAtDeadline) {
      throw new ConversionFailure(
        `The conversion took longer than the Function allows (stopped after ${seconds(result.wallMs)}). Shorten the video or upload a smaller file.`,
      )
    }
    if (result.code !== 0) {
      const reasons = ffmpegErrorLines(result.stderr)
      const proxyNote =
        proxy && proxy.stats.errors.length > 0 ? ` (input: ${proxy.stats.errors.join('; ')})` : ''
      if (proxyNote) {
        // ffmpeg failed while the connection to the CDN had errors: not the video's fault.
        throw new RetryableConversionError(
          `reading the upload from the CDN failed (${proxy!.stats.errors.join('; ')})`,
        )
      }
      if (NO_SPACE.test(result.stderr)) {
        throw new ConversionFailure(
          `The MP4 is larger than the converter's temporary storage (${(freeBytes / 1_000_000).toFixed(0)} MB free). Shorten the video or upload a smaller file.`,
        )
      }
      throw new ConversionFailure(
        `ffmpeg could not convert this file: ${reasons.join(' / ') || lastLines(result.stderr, 3) || `exit code ${result.code}`}${proxyNote}`,
      )
    }
    await closeProxy()

    const output = await timed('inspectMs', () => inspectMp4(outputPath))
    const problems = verifyConvertedMp4(output, {
      width: expectedSize.width,
      height: expectedSize.height,
      hasAudio: description.hasAudio,
      inputDurationSeconds: description.durationSeconds,
    })
    // No location or other metadata may reach the MP4 the site serves: no metadata boxes except
    // ffmpeg's encoder tag, no creation times, no tracks other than video and audio.
    problems.push(...(await checkIsobmffBoxes(outputPath, {allowEncoderTag: true})))
    if (problems.length > 0) {
      throw new ConversionFailure(`The converted MP4 failed its checks: ${problems.join('; ')}`)
    }
    const outputFrames = await timed('decodeCheckMs', () =>
      decodeCheck(ffmpegPath, outputPath, deadline),
    )
    const inputFrameTimes = inputFrames.result()
    const frameProblems = frameTimeProblems(inputFrameTimes, outputFrames)
    if (frameProblems.length > 0) {
      throw new ConversionFailure(
        `The converted MP4 does not keep the video's frames: ${frameProblems.join('; ')}`,
      )
    }
    const sha1 = await sha1File(outputPath)
    const {size: outputBytes} = await stat(outputPath)
    return {
      outputPath,
      workDir,
      outputBytes,
      sha1,
      input: {...description, video},
      inputMode,
      output,
      expectedSize,
      frames: {input: inputFrameTimes.seconds.length, output: outputFrames.seconds.length},
      timings,
    }
  } catch (error) {
    await rm(workDir, {recursive: true, force: true})
    throw error
  } finally {
    await closeProxy()
  }
}
