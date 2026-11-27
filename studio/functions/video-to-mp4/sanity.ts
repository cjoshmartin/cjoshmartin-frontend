/**
 * The orchestrator's ContentStore and Converter on top of @sanity/client: revision-checked
 * patches, the queries for other blocks using the same upload and for an earlier conversion with
 * the current settings, and the upload of a converted MP4 as a file asset with
 * source {name: "video-to-mp4", id: <the original it was converted from>} and the settings version
 * recorded on it. The original is always the stripped copy (or an upload with nothing personal),
 * so that id names nothing private. Asset bytes are read with privacy/private-fetch.ts.
 */
import {createReadStream} from 'node:fs'
import {rm} from 'node:fs/promises'
import os from 'node:os'

import {ClientError, type SanityClient} from '@sanity/client'

import {PRIVACY_FIELD, VIDEO_ORIGINAL_SOURCE_NAME, VIDEO_STRIP_VERSION} from '../privacy/constants'
import {privateAssetFetch} from '../privacy/private-fetch'
import type {UploadDigester} from '../privacy/provenance'
import {isWritableDocument, releaseDocumentId, releaseOfVersion} from '../privacy/releases'
import {convertToMp4, removeStaleWorkDirs, type ConvertOptions} from './convert'
import {
  RetryableConversionError,
  type AssetDocument,
  type ContentStore,
  type Converter,
  type DeleteOutcome,
  type StoredDocument,
} from './orchestrator'
import {stripOriginal} from './strip-original'
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

export function createSanityStore(client: SanityClient, options: {uploadDigest: UploadDigester | undefined}): ContentStore {
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
    async isWritable(id) {
      const release = releaseOfVersion(id)
      if (release === null) return true
      const state = await raw.fetch<string | null>('*[_id == $id][0].state', {id: releaseDocumentId(release)}, {tag: 'video-to-mp4.release'})
      return isWritableDocument(id, state)
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
    async findStrippedOriginal(uploadAssetId) {
      // Copies record the upload's digest, never its id (privacy/provenance.ts); without the key
      // no copy can be found, and the upload is stripped again (to the same bytes, so the same asset).
      if (!options.uploadDigest) return null
      return raw.fetch<AssetDocument | null>(
        `*[_type == "sanity.fileAsset" && source.name == $name && source.id == $id && ${PRIVACY_FIELD}.status == "stripped" && ${PRIVACY_FIELD}.version == $version] | order(_createdAt asc)[0]`,
        {name: VIDEO_ORIGINAL_SOURCE_NAME, id: options.uploadDigest(uploadAssetId), version: VIDEO_STRIP_VERSION},
        {tag: 'video-to-mp4.stripped'},
      )
    },
    async deleteAssetIfUnreferenced(assetId): Promise<DeleteOutcome> {
      // The raw perspective includes drafts and release versions.
      const referencing = () =>
        raw.fetch<string[]>('*[references($id)]._id', {id: assetId}, {tag: 'video-to-mp4.references'})
      const before = await referencing()
      if (before.length > 0) return {kind: 'referenced', by: before}
      try {
        await raw.delete(assetId, {visibility: 'sync'})
        return {kind: 'deleted'}
      } catch (error) {
        if (error instanceof ClientError && error.statusCode === 404) return {kind: 'missing'}
        if (error instanceof ClientError && error.statusCode === 409) {
          // A reference was added between the query and the delete.
          return {kind: 'referenced', by: await referencing()}
        }
        throw error
      }
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
  /** The keyed digest a stripped copy records instead of the upload's id (privacy/provenance.ts). */
  uploadDigest: UploadDigester | undefined
  /** Reads asset bytes; privateAssetFetch with the client's token by default. */
  fetchImpl?: typeof fetch
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

export function createSanityConverter(
  client: SanityClient,
  options: SanityConverterOptions,
): Converter {
  const verifiedFfmpeg = async (): Promise<string> => {
    try {
      return await options.ffmpeg()
    } catch (error) {
      throw new RetryableConversionError(
        `the converter is not set up correctly (${(error as Error).message}); the site owner has to redeploy it`,
      )
    }
  }
  // Lambda runs one invocation per container at a time, so any work directory left in /tmp
  // belongs to an earlier run that was killed. Removed once per run, before the first step.
  let cleaned = false
  const removeStale = async () => {
    if (cleaned) return
    cleaned = true
    const removed = await removeStaleWorkDirs(options.tmpDir ?? os.tmpdir())
    if (removed.length > 0) {
      options.log(`removed work directories of an earlier run: ${removed.join(', ')}`)
    }
  }
  // Every read of an asset's bytes has its own cache key and the token, so an unstripped upload
  // never enters the asset CDN's public cache under its plain URL (privacy/private-fetch.ts).
  const fetchImpl = options.fetchImpl ?? privateAssetFetch(client.config().token)
  return {
    async strip(upload: AssetDocument) {
      const ffmpegPath = await verifiedFfmpeg()
      await removeStale()
      return stripOriginal(client, upload, {
        ffmpegPath,
        deadline: options.deadline,
        log: options.log,
        tmpDir: options.tmpDir,
        fetchImpl,
        uploadDigest: options.uploadDigest,
      })
    },
    async convert(source: AssetDocument) {
      if (!source.url) throw new RetryableConversionError(`${source._id} has no URL yet`)
      const ffmpegPath = await verifiedFfmpeg()
      await removeStale()
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
          fetchImpl,
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
