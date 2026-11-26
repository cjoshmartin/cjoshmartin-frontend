/**
 * Makes the original a video block keeps private: a copy of the upload without location and
 * personal metadata (privacy/video-strip.ts: ffmpeg stream copy, verified packet by packet),
 * uploaded as a file asset with source {name: VIDEO_ORIGINAL_SOURCE_NAME, id: <upload>} and
 * `privacy` = {status: "stripped", version: VIDEO_STRIP_VERSION, strippedFrom, removed, ...}.
 *
 * The upload is read from /tmp when it and its copy fit there together, otherwise through the
 * range proxy (only the copy is written to /tmp). Uploads whose copy cannot fit in /tmp cannot be
 * stripped in the Function and fail with a message.
 */
import {createReadStream} from 'node:fs'
import {mkdir, open, rm, stat, statfs} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {SanityClient} from '@sanity/client'

import {
  PRIVACY_FIELD,
  VIDEO_ORIGINAL_SOURCE_NAME,
  VIDEO_STRIP_VERSION,
  type AssetPrivacy,
} from '../privacy/constants'
import {stripVideo, VideoStripError, VideoStripTimeoutError, type FfmpegRunner} from '../privacy/video-strip'
import {download, WORK_DIR_PREFIX} from './convert'
import {runFfmpeg, sha1File} from './ffmpeg'
import {ConversionFailure, RetryableConversionError, type AssetDocument} from './orchestrator'
import {startRangeProxy, type RangeProxy} from './range-proxy'

/** Space kept free in /tmp besides the copy (ffmpeg's hash files, the description). */
const HEADROOM_BYTES = 32 * 1000 * 1000

export interface StripOriginalOptions {
  ffmpegPath: string
  deadline: number
  log: (message: string) => void
  tmpDir?: string
  fetchImpl?: typeof fetch
}

/** First bytes of the upload (for its major brand), from the local file or with a range request. */
async function readHead(input: {file?: string; url: string}, fetchImpl: typeof fetch): Promise<Uint8Array> {
  if (input.file) {
    const handle = await open(input.file, 'r')
    try {
      const head = Buffer.alloc(64)
      const {bytesRead} = await handle.read(head, 0, 64, 0)
      return new Uint8Array(head.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  }
  const response = await fetchImpl(input.url, {headers: {range: 'bytes=0-63', 'accept-encoding': 'identity'}})
  if (!response.ok) throw new RetryableConversionError(`the upload's first bytes could not be read (HTTP ${response.status})`)
  return new Uint8Array(await response.arrayBuffer()).subarray(0, 64)
}

function baseName(filename: string | undefined, fallback: string): string {
  const name = (filename ?? '').replace(/[/\\]/g, '_').trim()
  const base = name.replace(/\.[^.]*$/, '')
  return base || fallback
}

export async function stripOriginal(
  client: SanityClient,
  upload: AssetDocument,
  options: StripOriginalOptions,
): Promise<{assetId: string; message: string}> {
  if (!upload.url) throw new RetryableConversionError(`${upload._id} has no URL yet`)
  if (upload.mimeType !== undefined && !upload.mimeType.startsWith('video/')) {
    throw new ConversionFailure(`This file is not a video (${upload.mimeType}). Upload a video file.`)
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const workDir = path.join(tmpDir, `${WORK_DIR_PREFIX}strip-${process.pid}-${Date.now()}`)
  await mkdir(workDir, {recursive: true})
  let proxy: RangeProxy | undefined
  try {
    const free = await statfs(tmpDir)
    const freeBytes = free.bavail * free.bsize
    const size = upload.size
    // The copy is about as large as the upload.
    let input: {file?: string; url: string}
    if (size !== undefined && size * 2 + HEADROOM_BYTES <= freeBytes) {
      const file = path.join(workDir, 'upload')
      await download(
        {assetId: upload._id, url: upload.url, size: upload.size, sha1hash: upload.sha1hash, mimeType: upload.mimeType, originalFilename: upload.originalFilename},
        file,
        options.deadline,
        fetchImpl,
      )
      input = {file, url: upload.url}
    } else if (size === undefined || size + HEADROOM_BYTES <= freeBytes) {
      proxy = await startRangeProxy(upload.url, {
        fetchImpl,
        signal: AbortSignal.timeout(Math.max(1, options.deadline - Date.now())),
      })
      input = {url: proxy.url}
      options.log(`${upload._id}: ${size} bytes; stripping through the range proxy`)
    } else {
      throw new ConversionFailure(
        `The video is too large for the converter to remove its location data (${(size / 1e6).toFixed(0)} MB; the limit is about ${((freeBytes - HEADROOM_BYTES) / 1e6).toFixed(0)} MB). Shorten it or upload a smaller file.`,
      )
    }

    const ffmpeg: FfmpegRunner = (args) => runFfmpeg(options.ffmpegPath, args, options.deadline)
    const head = await readHead(input.file ? input : {url: upload.url}, fetchImpl)
    let stripped: Awaited<ReturnType<typeof stripVideo>>
    try {
      stripped = await stripVideo({ffmpeg, input: input.file ?? input.url, workDir, head})
    } catch (error) {
      if (error instanceof VideoStripTimeoutError) {
        throw new ConversionFailure(`Removing the location data from the original took longer than the Function allows (${error.message}). Shorten the video or upload a smaller file.`)
      }
      if (error instanceof VideoStripError) {
        if (proxy && proxy.stats.errors.length > 0) {
          throw new RetryableConversionError(`reading the upload from the CDN failed (${proxy.stats.errors.join('; ')})`)
        }
        throw new ConversionFailure(`The location and personal metadata could not be removed from the original: ${error.message}`)
      }
      throw error
    }
    const {output, report} = stripped
    options.log(`${upload._id}: stripped (${report.muxer}); removed ${report.removed.join('; ')}${report.notes.length > 0 ? `; ${report.notes.join('; ')}` : ''}`)

    const sha1 = await sha1File(output)
    const {size: bytes} = await stat(output)
    const filename = `${baseName(upload.originalFilename, upload._id)}.${report.extension}`
    let asset: AssetDocument
    try {
      asset = (await client.assets.upload('file', createReadStream(output), {
        filename,
        contentType: report.mimeType,
        source: {name: VIDEO_ORIGINAL_SOURCE_NAME, id: upload._id},
      })) as unknown as AssetDocument
    } catch (error) {
      throw new RetryableConversionError(`the copy without metadata could not be uploaded (${(error as Error).message})`)
    }
    const expectedId = `file-${sha1}-${report.extension}`
    if (asset._id !== expectedId || asset.size !== bytes) {
      throw new RetryableConversionError(`the uploaded copy became ${asset._id} (${asset.size} bytes), expected ${expectedId} (${bytes} bytes)`)
    }
    const privacy: AssetPrivacy = {
      status: 'stripped',
      version: VIDEO_STRIP_VERSION,
      strippedFrom: upload._id,
      removed: report.removed,
      message: report.notes.join(' '),
      updatedAt: new Date().toISOString(),
    }
    await client.patch(asset._id).set({[PRIVACY_FIELD]: privacy}).commit({visibility: 'sync'})
    const notes = report.notes.length > 0 ? ` (${report.notes.join('; ')})` : ''
    return {
      assetId: asset._id,
      message: `The original is kept without its location and personal metadata, streams unchanged${notes}.`,
    }
  } finally {
    if (proxy) await proxy.close()
    await rm(workDir, {recursive: true, force: true})
  }
}
