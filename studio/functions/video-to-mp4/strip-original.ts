/**
 * Makes the original a video block keeps private: a copy of the upload without location and
 * personal metadata, uploaded as a file asset with source {name: VIDEO_ORIGINAL_SOURCE_NAME, id:
 * <the upload's digest>} and `privacy` = {status: "stripped", version: VIDEO_STRIP_VERSION,
 * strippedFromDigest, removed, ...} (privacy/provenance.ts: the copy never names the upload's id).
 * The upload is then marked `replaced` (replacementAssetId: the copy), so every part of the
 * privacy setup knows it can be deleted once nothing references it.
 *
 * QuickTime/MP4 uploads are stripped in place (privacy/video-strip.ts stripIsobmffInPlace): the
 * container, edit lists, time stamps and samples stay exactly as they were. Other containers, and
 * ISO BMFF files the in-place stripper refuses, fall back to the ffmpeg stream copy (stripVideo),
 * which rewrites the container and says so. An upload with nothing personal (no metadata box with
 * content, no data track, no creation time, no unused data) is kept as it is and marked `clean`.
 *
 * The upload is downloaded to /tmp (sha1 checked) and edited there, so it needs its own size of
 * free space; the stream copy fallback reads it through the range proxy when the copy fits but the
 * upload does not fit next to it. Uploads too large for /tmp cannot be stripped in the Function and
 * fail with a message.
 *
 * Every read of the upload goes through `fetchImpl`, which the callers make with
 * privacy/private-fetch.ts, so the unstripped bytes never enter the asset CDN's public cache under
 * the upload's plain URL (a deleted asset stays cached there for up to 30 days).
 */
import {createReadStream} from 'node:fs'
import {mkdir, rm, stat, statfs} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {SanityClient} from '@sanity/client'

import {
  PRIVACY_FIELD,
  VIDEO_ORIGINAL_SOURCE_NAME,
  VIDEO_STRIP_VERSION,
  type AssetPrivacy,
} from '../privacy/constants'
import {IsobmffUnsupportedError, looksLikeIsobmff} from '../privacy/isobmff-video'
import {copySourceId, type UploadDigester} from '../privacy/provenance'
import {
  stripIsobmffInPlace,
  stripVideo,
  VideoStripError,
  VideoStripTimeoutError,
  type FfmpegRunner,
} from '../privacy/video-strip'
import {download, WORK_DIR_PREFIX} from './convert'
import {runFfmpeg, sha1File} from './ffmpeg'
import {ConversionFailure, RetryableConversionError, type AssetDocument} from './orchestrator'
import {startRangeProxy, type RangeProxy} from './range-proxy'

/** Space kept free in /tmp besides the video (ffmpeg's hash files, the description). */
const HEADROOM_BYTES = 32 * 1000 * 1000

export interface StripOriginalOptions {
  ffmpegPath: string
  deadline: number
  log: (message: string) => void
  tmpDir?: string
  /** Reads the upload's bytes: privacy/private-fetch.ts privateAssetFetch in the Functions. */
  fetchImpl: typeof fetch
  /** The keyed digest recorded on the copy instead of the upload's id; undefined without the key. */
  uploadDigest: UploadDigester | undefined
}

/** What stripOriginal did: a stripped copy, or the upload left as it is because it is clean. */
export interface StripOriginalResult {
  /** The asset the block keeps as `original`: the stripped copy, or the upload itself when clean. */
  assetId: string
  clean: boolean
  message: string
}

/** First bytes of the upload (for its major brand and container), with a range request. */
async function readHead(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await fetchImpl(url, {headers: {range: 'bytes=0-63', 'accept-encoding': 'identity'}})
  if (!response.ok) throw new RetryableConversionError(`the upload's first bytes could not be read (HTTP ${response.status})`)
  return new Uint8Array(await response.arrayBuffer()).subarray(0, 64)
}

function baseName(filename: string | undefined, fallback: string): string {
  const name = (filename ?? '').replace(/[/\\]/g, '_').trim()
  const base = name.replace(/\.[^.]*$/, '')
  return base || fallback
}

/** The file extension Sanity gave the upload (its asset id ends with it). */
function uploadExtension(upload: AssetDocument): string {
  const match = /^file-[0-9a-f]{40}-([A-Za-z0-9]+)$/.exec(upload._id)
  if (!match) throw new RetryableConversionError(`${upload._id} is not a file asset id`)
  return match[1]
}

export async function stripOriginal(
  client: SanityClient,
  upload: AssetDocument,
  options: StripOriginalOptions,
): Promise<StripOriginalResult> {
  if (!upload.url) throw new RetryableConversionError(`${upload._id} has no URL yet`)
  if (upload.mimeType !== undefined && !upload.mimeType.startsWith('video/')) {
    throw new ConversionFailure(`This file is not a video (${upload.mimeType}). Upload a video file.`)
  }
  const fetchImpl = options.fetchImpl
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const workDir = path.join(tmpDir, `${WORK_DIR_PREFIX}strip-${process.pid}-${Date.now()}`)
  await mkdir(workDir, {recursive: true})
  let proxy: RangeProxy | undefined
  const ffmpeg: FfmpegRunner = (args) => runFfmpeg(options.ffmpegPath, args, options.deadline)
  const tooLarge = (limit: number) =>
    new ConversionFailure(
      `The video is too large for the converter to remove its location data (${((upload.size ?? 0) / 1e6).toFixed(0)} MB; the limit is about ${(limit / 1e6).toFixed(0)} MB). Shorten it or upload a smaller file.`,
    )
  try {
    const free = await statfs(tmpDir)
    const freeBytes = free.bavail * free.bsize
    const size = upload.size
    const head = await readHead(upload.url, fetchImpl)
    const source = {assetId: upload._id, url: upload.url, size: upload.size, sha1hash: upload.sha1hash, mimeType: upload.mimeType, originalFilename: upload.originalFilename}

    let output: string
    let uploadAs: {filename: string; contentType: string | undefined; extension: string}
    let removed: string[]
    let notes: string[]
    const uploadFile = path.join(workDir, 'upload')
    const fits = (copies: number) => size !== undefined && size * copies + HEADROOM_BYTES <= freeBytes
    let inPlace: Awaited<ReturnType<typeof stripIsobmffInPlace>> | 'refused' | 'not-isobmff' = 'not-isobmff'
    if (looksLikeIsobmff(head)) {
      if (!fits(1)) throw tooLarge(freeBytes - HEADROOM_BYTES)
      await download(source, uploadFile, options.deadline, fetchImpl)
      try {
        inPlace = await stripIsobmffInPlace({ffmpeg, file: uploadFile, workDir})
      } catch (error) {
        if (!(error instanceof IsobmffUnsupportedError)) throw error
        options.log(`${upload._id}: not stripped in place (${error.message}); using a stream copy`)
        inPlace = 'refused'
        // The planner refuses before it writes, so the download is still the upload's bytes.
      }
    }

    if (inPlace !== 'refused' && inPlace !== 'not-isobmff') {
      if (inPlace.kind === 'clean') {
        const privacy: AssetPrivacy = {
          status: 'clean',
          version: VIDEO_STRIP_VERSION,
          removed: [],
          message: 'No location or personal metadata: no metadata box with content, no data track, no creation time, no unused data.',
          updatedAt: new Date().toISOString(),
        }
        await client.patch(upload._id).set({[PRIVACY_FIELD]: privacy}).commit({visibility: 'sync'})
        options.log(`${upload._id}: no personal metadata; kept as it is`)
        return {assetId: upload._id, clean: true, message: 'The upload has no location or personal metadata; it is kept as it is.'}
      }
      output = uploadFile
      const extension = uploadExtension(upload)
      uploadAs = {filename: upload.originalFilename ?? `${baseName(undefined, upload._id)}.${extension}`, contentType: upload.mimeType, extension}
      removed = inPlace.removed
      notes = []
    } else {
      // The stream copy: the input is the download when there is one, else the range proxy.
      let input: string
      if (inPlace === 'refused') {
        if (!fits(2)) throw tooLarge((freeBytes - HEADROOM_BYTES) / 2)
        input = uploadFile
      } else if (fits(2)) {
        await download(source, uploadFile, options.deadline, fetchImpl)
        input = uploadFile
      } else if (size === undefined || size + HEADROOM_BYTES <= freeBytes) {
        proxy = await startRangeProxy(upload.url, {
          fetchImpl,
          signal: AbortSignal.timeout(Math.max(1, options.deadline - Date.now())),
        })
        input = proxy.url
        options.log(`${upload._id}: ${size} bytes; stripping through the range proxy`)
      } else {
        throw tooLarge(freeBytes - HEADROOM_BYTES)
      }
      const stripped = await stripVideo({ffmpeg, input, workDir, head})
      output = stripped.output
      uploadAs = {
        filename: `${baseName(upload.originalFilename, upload._id)}.${stripped.report.extension}`,
        contentType: stripped.report.mimeType,
        extension: stripped.report.extension,
      }
      removed = stripped.report.removed
      notes = [`the container was rewritten by a stream copy (${stripped.report.muxer}); the packets are unchanged`, ...stripped.report.notes]
    }
    options.log(`${upload._id}: stripped (${inPlace === 'refused' || inPlace === 'not-isobmff' ? 'stream copy' : 'in place'}); removed ${removed.join('; ')}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`)

    const sha1 = await sha1File(output)
    const {size: bytes} = await stat(output)
    let asset: AssetDocument
    try {
      asset = (await client.assets.upload('file', createReadStream(output), {
        filename: uploadAs.filename,
        ...(uploadAs.contentType ? {contentType: uploadAs.contentType} : {}),
        source: {name: VIDEO_ORIGINAL_SOURCE_NAME, id: copySourceId(upload._id, options.uploadDigest)},
      })) as unknown as AssetDocument
    } catch (error) {
      throw new RetryableConversionError(`the copy without metadata could not be uploaded (${(error as Error).message})`)
    }
    const expectedId = `file-${sha1}-${uploadAs.extension}`
    if (asset._id !== expectedId || asset.size !== bytes) {
      throw new RetryableConversionError(`the uploaded copy became ${asset._id} (${asset.size} bytes), expected ${expectedId} (${bytes} bytes)`)
    }
    const now = new Date().toISOString()
    const link = options.uploadDigest?.(upload._id)
    const privacy: AssetPrivacy = {
      status: 'stripped',
      version: VIDEO_STRIP_VERSION,
      ...(link ? {strippedFromDigest: link} : {}),
      removed,
      message: notes.join(' '),
      updatedAt: now,
    }
    await client.patch(asset._id).set({[PRIVACY_FIELD]: privacy}).commit({visibility: 'sync'})
    const replaced: AssetPrivacy = {status: 'replaced', version: VIDEO_STRIP_VERSION, replacementAssetId: asset._id, removed, updatedAt: now}
    await client.patch(upload._id).set({[PRIVACY_FIELD]: replaced}).commit({visibility: 'sync'})
    const noted = notes.length > 0 ? ` (${notes.join('; ')})` : ''
    return {
      assetId: asset._id,
      clean: false,
      message: `The original is kept without its location and personal metadata, streams unchanged${noted}.`,
    }
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
  } finally {
    if (proxy) await proxy.close()
    await rm(workDir, {recursive: true, force: true})
  }
}
