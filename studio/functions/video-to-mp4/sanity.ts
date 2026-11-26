/**
 * The orchestrator's ContentStore and Converter on top of @sanity/client: revision-checked
 * patches, the queries for other blocks using the same upload and for an earlier conversion with
 * the current settings, and the upload of a converted MP4 as a file asset with
 * source {name: "video-to-mp4", id: <upload>} and the settings version recorded on it.
 */
import {createReadStream} from 'node:fs'
import {rm} from 'node:fs/promises'
import os from 'node:os'

import {ClientError, type SanityClient} from '@sanity/client'

import {convertToMp4, removeStaleWorkDirs, type ConvertOptions} from './convert'
import {
  RetryableConversionError,
  type AssetDocument,
  type ContentStore,
  type Converter,
  type StoredDocument,
} from './orchestrator'
import type {PatchOps} from './patches'
import {
  CONVERTED_ASSET_SETTINGS_FIELD,
  CONVERTED_ASSET_SOURCE_NAME,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
  convertedFilename,
  type X264Preset,
} from './settings'
import {documentsUsingFileQuery} from './trigger'

/** Sanity's answer when ifRevisionID no longer matches (or the document vanished meanwhile). */
function isRevisionConflict(error: unknown): boolean {
  return error instanceof ClientError && (error.statusCode === 409 || error.statusCode === 404)
}

export function createSanityStore(client: SanityClient): ContentStore {
  const raw = client.withConfig({perspective: 'raw', useCdn: false})
  return {
    async getDocument(id) {
      return ((await raw.getDocument(id)) ?? null) as StoredDocument | null
    },
    async patchIfRevision(id: string, revision: string, ops: PatchOps) {
      let patch = raw.patch(id).ifRevisionId(revision)
      if (ops.set) patch = patch.set(ops.set)
      if (ops.unset) patch = patch.unset(ops.unset)
      try {
        await patch.commit({autoGenerateArrayKeys: false, visibility: 'sync'})
        return 'ok'
      } catch (error) {
        if (isRevisionConflict(error)) return 'conflict'
        throw error
      }
    },
    async documentsUsingFile(assetId) {
      return raw.fetch<string[]>(documentsUsingFileQuery(), {assetId}, {tag: 'video-to-mp4.users'})
    },
    async findConvertedAsset(sourceAssetId) {
      return raw.fetch<AssetDocument | null>(
        `*[_type == "sanity.fileAsset" && source.name == $name && source.id == $id && mimeType == $mimeType && ${CONVERTED_ASSET_SETTINGS_FIELD} == $settingsVersion] | order(_createdAt asc)[0]`,
        {
          name: CONVERTED_ASSET_SOURCE_NAME,
          id: sourceAssetId,
          mimeType: OUTPUT_MIME_TYPE,
          settingsVersion: SETTINGS_VERSION,
        },
        {tag: 'video-to-mp4.reuse'},
      )
    },
  }
}

export interface SanityConverterOptions {
  /** Resolves to the verified ffmpeg path (see ffmpeg.ts verifyFfmpegBinary). */
  ffmpeg: () => Promise<string>
  preset: X264Preset
  deadline: number
  log: (message: string) => void
  tmpDir?: string
  downloadLimitBytes?: ConvertOptions['downloadLimitBytes']
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

export function createSanityConverter(
  client: SanityClient,
  options: SanityConverterOptions,
): Converter {
  return {
    async convert(source: AssetDocument) {
      if (!source.url) throw new RetryableConversionError(`${source._id} has no URL yet`)
      let ffmpegPath: string
      try {
        ffmpegPath = await options.ffmpeg()
      } catch (error) {
        throw new RetryableConversionError(
          `the converter is not set up correctly (${(error as Error).message}); the site owner has to redeploy it`,
        )
      }
      // Lambda runs one invocation per container at a time, so any work directory left in /tmp
      // belongs to an earlier run that was killed.
      const removed = await removeStaleWorkDirs(options.tmpDir ?? os.tmpdir())
      if (removed.length > 0) {
        options.log(`removed work directories of an earlier run: ${removed.join(', ')}`)
      }
      const started = Date.now()
      const converted = await convertToMp4(
        {
          assetId: source._id,
          url: source.url,
          size: source.size,
          sha1hash: source.sha1hash,
          mimeType: source.mimeType,
          originalFilename: source.originalFilename,
        },
        {
          ffmpegPath,
          preset: options.preset,
          deadline: options.deadline,
          log: options.log,
          tmpDir: options.tmpDir,
          downloadLimitBytes: options.downloadLimitBytes,
        },
      )
      try {
        const filename = convertedFilename(source.originalFilename, source._id)
        const uploadStarted = Date.now()
        const asset = await client.assets.upload('file', createReadStream(converted.outputPath), {
          filename,
          contentType: OUTPUT_MIME_TYPE,
          source: {name: CONVERTED_ASSET_SOURCE_NAME, id: source._id},
        })
        const uploadMs = Date.now() - uploadStarted
        const expectedId = `file-${converted.sha1}-mp4`
        if (asset._id !== expectedId) {
          throw new Error(`the uploaded MP4 became ${asset._id}, expected ${expectedId}`)
        }
        if (asset.mimeType !== OUTPUT_MIME_TYPE || asset.size !== converted.outputBytes) {
          throw new Error(
            `the uploaded MP4 is ${asset.mimeType}, ${asset.size} bytes; expected ${OUTPUT_MIME_TYPE}, ${converted.outputBytes} bytes`,
          )
        }
        const assetSource = (asset as {source?: {name?: string; id?: string}}).source
        if (assetSource?.name !== CONVERTED_ASSET_SOURCE_NAME || assetSource.id !== source._id) {
          // Identical bytes were uploaded before under another source; Sanity returned that asset.
          options.log(
            `${asset._id} already existed with source ${JSON.stringify(assetSource ?? null)}; using it`,
          )
        }
        // Recorded before any block points at the MP4, so a later run reuses it only while the
        // settings are the same. If this run dies first, the next one converts again: the bytes
        // are the same, so the upload returns this asset, and the field is set then.
        await client
          .patch(asset._id)
          .set({[CONVERTED_ASSET_SETTINGS_FIELD]: SETTINGS_VERSION})
          .commit({visibility: 'sync'})
        const {input, expectedSize, output} = converted
        const audioTrack = output.tracks.some((t) => t.handler === 'soun')
        const rotation = input.video.rotation ? `, rotated ${input.video.rotation}°` : ''
        const totalSeconds = ((Date.now() - started) / 1000).toFixed(0)
        options.log(
          `${source._id} -> ${asset._id}: ${JSON.stringify({...converted.timings, uploadMs, inputMode: converted.inputMode})}`,
        )
        return {
          outputAssetId: asset._id,
          message:
            `Converted ${source.originalFilename ?? source._id} (${input.video.codec} ` +
            `${input.video.width}x${input.video.height}${rotation}, ${megabytes(source.size ?? 0)}) to ` +
            `MP4 ${expectedSize.width}x${expectedSize.height} H.264${audioTrack ? ' + AAC stereo' : ', no audio'}, ` +
            `${megabytes(converted.outputBytes)}, in ${totalSeconds} s.`,
        }
      } finally {
        await rm(converted.workDir, {recursive: true, force: true})
      }
    },
  }
}
