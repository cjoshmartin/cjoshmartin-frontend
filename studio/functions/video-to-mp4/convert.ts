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

import {runFfmpeg, sha1File} from './ffmpeg'
import {
  ffmpegErrorLines,
  parseFfmpegInputDescription,
  UnreadableInputError,
  type InputDescription,
} from './media-info'
import {inspectMp4, verifyConvertedMp4, type Mp4Summary} from './mp4'
import {ConversionFailure} from './orchestrator'
import {startRangeProxy, type RangeProxy} from './range-proxy'
import {buildFfmpegArgs, expectedOutputSize, type VideoSize, type X264Preset} from './settings'

/** Uploads up to this size are downloaded to /tmp (512 MB in Lambda) before conversion. */
export const DOWNLOAD_LIMIT_BYTES = 400 * 1000 * 1000

/** Space kept free in /tmp for the output when downloading the input. */
const OUTPUT_HEADROOM_BYTES = 64 * 1000 * 1000

const WORK_DIR_PREFIX = 'video-to-mp4-'

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

async function download(
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
        throw new ConversionFailure(
          `Could not download the uploaded file (${(error as Error).message}). Remove the video block and add the video again to retry.`,
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
  if (result.killedAtDeadline)
    throw new ConversionFailure('Ran out of time while reading the file.')
  try {
    return parseFfmpegInputDescription(result.stderr)
  } catch (error) {
    if (error instanceof UnreadableInputError) {
      throw new ConversionFailure(`This file could not be read as a video: ${error.message}`)
    }
    throw error
  }
}

/** Decodes the whole MP4 once, so a file that cannot be played fails the conversion. */
async function decodeCheck(ffmpegPath: string, file: string, deadline: number): Promise<void> {
  const result = await runFfmpeg(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-i',
      file,
      '-map',
      '0',
      '-f',
      'null',
      '-',
    ],
    deadline,
  )
  if (result.killedAtDeadline) {
    throw new ConversionFailure('Ran out of time while checking the converted MP4.')
  }
  if (result.code !== 0) {
    throw new ConversionFailure(
      `The converted MP4 does not decode cleanly: ${lastLines(result.stderr, 3) || `exit code ${result.code}`}`,
    )
  }
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
  try {
    const free = await statfs(tmpDir)
    const freeBytes = free.bavail * free.bsize
    const size = source.size
    const inputMode: 'download' | 'proxy' =
      size !== undefined && size <= limit && size + OUTPUT_HEADROOM_BYTES <= freeBytes
        ? 'download'
        : 'proxy'
    let input: string
    if (inputMode === 'download') {
      const extension = path
        .extname(source.originalFilename ?? '')
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, '')
      input = path.join(workDir, `input${extension || '.bin'}`)
      await timed('downloadMs', () => download(source, input, deadline, fetchImpl))
    } else {
      proxy = await startRangeProxy(source.url, {
        fetchImpl,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      input = proxy.url
      log(`${source.assetId}: ${size ?? 'unknown'} bytes; ffmpeg reads it through the range proxy`)
    }

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

    const outputPath = path.join(workDir, 'output.mp4')
    const args = [
      '-loglevel',
      'warning',
      ...buildFfmpegArgs({input, output: outputPath, preset, hasAudio: description.hasAudio}),
    ]
    const encode = await timed('encodeMs', () => runFfmpeg(ffmpegPath, args, deadline))
    if (encode.killedAtDeadline) {
      throw new ConversionFailure(
        `The conversion took longer than the Function allows (stopped after ${seconds(encode.wallMs)}). Shorten the video or upload a smaller file.`,
      )
    }
    if (encode.code !== 0) {
      const reasons = ffmpegErrorLines(encode.stderr)
      const proxyNote =
        proxy && proxy.stats.errors.length > 0 ? ` (input: ${proxy.stats.errors.join('; ')})` : ''
      throw new ConversionFailure(
        `ffmpeg could not convert this file: ${reasons.join(' / ') || lastLines(encode.stderr, 3) || `exit code ${encode.code}`}${proxyNote}`,
      )
    }

    const output = await timed('inspectMs', () => inspectMp4(outputPath))
    const problems = verifyConvertedMp4(output, {
      width: expectedSize.width,
      height: expectedSize.height,
      hasAudio: description.hasAudio,
      inputDurationSeconds: description.durationSeconds,
    })
    if (problems.length > 0) {
      throw new ConversionFailure(`The converted MP4 failed its checks: ${problems.join('; ')}`)
    }
    await timed('decodeCheckMs', () => decodeCheck(ffmpegPath, outputPath, deadline))
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
      timings,
    }
  } catch (error) {
    await rm(workDir, {recursive: true, force: true})
    throw error
  } finally {
    if (proxy) {
      await proxy.close()
      log(
        `${source.assetId}: range proxy served ${proxy.stats.requests} requests, ${proxy.stats.bytes} bytes, ${proxy.stats.resumes} resumes`,
      )
    }
  }
}
