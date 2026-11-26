/**
 * The image-privacy Function's ImageStore on top of @sanity/client: revision-checked patches in the
 * raw perspective (drafts and release versions included), the reference query, the guarded delete,
 * the download of an upload's stored bytes (`dlRaw`, size and sha1 checked) and the upload of its
 * stripped copy.
 */
import {createHash} from 'node:crypto'

import {ClientError, type SanityClient} from '@sanity/client'

import {IMAGE_METADATA_OPTIONS, IMAGE_PRIVACY_SOURCE_NAME} from '../privacy/constants'
import {isWritableDocument, releaseDocumentId, releaseOfVersion} from '../privacy/releases'
import {RetryableImageError, type DeleteOutcome, type ImageStore, type PatchOps, type StoredDocument} from './orchestrator'
import type {ImageAssetDocument} from './trigger'

function isRevisionConflict(error: unknown): boolean {
  return error instanceof ClientError && (error.statusCode === 409 || error.statusCode === 404)
}

/** Largest upload the Function downloads (Sanity's own image limit is lower). */
const MAX_IMAGE_BYTES = 200 * 1000 * 1000

/**
 * The stored bytes of an image asset. The image CDN's plain URL serves a re-encoded rendition
 * without metadata (and without the orientation and ICC profile), never the upload itself; `dlRaw`
 * returns the stored file and requires a token (anonymous requests get 401).
 */
export function rawImageUrl(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('dlRaw', '')
  return parsed.toString()
}

export function createSanityImageStore(client: SanityClient, options: {deadline: number; fetchImpl?: typeof fetch}): ImageStore {
  const raw = client.withConfig({perspective: 'raw', useCdn: false})
  const fetchImpl = options.fetchImpl ?? fetch
  const token = client.config().token
  const referencing = (id: string) => raw.fetch<string[]>('*[references($id)]._id', {id}, {tag: 'image-privacy.references'})
  return {
    async getDocument(id) {
      return ((await raw.getDocument(id)) ?? null) as StoredDocument | null
    },
    async patchIfRevision(id: string, revision: string, ops: PatchOps) {
      let patch = raw.patch(id).ifRevisionId(revision)
      if (ops.set) patch = patch.set(ops.set)
      if (ops.unset && ops.unset.length > 0) patch = patch.unset(ops.unset)
      try {
        await patch.commit({autoGenerateArrayKeys: false, visibility: 'sync', tag: 'image-privacy.patch'})
        return 'ok'
      } catch (error) {
        if (isRevisionConflict(error)) return 'conflict'
        throw error
      }
    },
    referencing,
    async isWritable(id) {
      const release = releaseOfVersion(id)
      if (release === null) return true
      const state = await raw.fetch<string | null>('*[_id == $id][0].state', {id: releaseDocumentId(release)}, {tag: 'image-privacy.release'})
      return isWritableDocument(id, state)
    },
    async deleteAssetIfUnreferenced(assetId): Promise<DeleteOutcome> {
      const before = await referencing(assetId)
      if (before.length > 0) return {kind: 'referenced', by: before}
      try {
        await raw.delete(assetId, {visibility: 'sync', tag: 'image-privacy.delete'})
        return {kind: 'deleted'}
      } catch (error) {
        if (error instanceof ClientError && error.statusCode === 404) return {kind: 'missing'}
        if (error instanceof ClientError && error.statusCode === 409) return {kind: 'referenced', by: await referencing(assetId)}
        throw error
      }
    },
    async download(asset: ImageAssetDocument) {
      if (!asset.url) throw new RetryableImageError(`${asset._id} has no URL yet`)
      if (asset.size !== undefined && asset.size > MAX_IMAGE_BYTES) {
        throw new RetryableImageError(`${asset._id} is ${asset.size} bytes, more than the Function reads`)
      }
      let bytes: Uint8Array
      try {
        if (!token) throw new Error('the Function has no token to read the stored image (dlRaw)')
        const response = await fetchImpl(rawImageUrl(asset.url), {
          headers: {'accept-encoding': 'identity', authorization: `Bearer ${token}`},
          signal: AbortSignal.timeout(Math.max(1, options.deadline - Date.now())),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        bytes = new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        throw new RetryableImageError(`the image could not be downloaded (${(error as Error).message})`)
      }
      if (asset.size !== undefined && bytes.length !== asset.size) {
        throw new RetryableImageError(`downloaded ${bytes.length} bytes, the asset has ${asset.size}`)
      }
      const sha1 = createHash('sha1').update(bytes).digest('hex')
      if (asset.sha1hash && sha1 !== asset.sha1hash) {
        throw new RetryableImageError(`the download's sha1 ${sha1} differs from the asset's ${asset.sha1hash}`)
      }
      return bytes
    },
    async uploadStripped(bytes, upload, mimeType) {
      let asset: ImageAssetDocument
      try {
        asset = (await client.assets.upload('image', Buffer.from(bytes), {
          filename: upload.originalFilename ?? upload._id,
          contentType: mimeType,
          source: {name: IMAGE_PRIVACY_SOURCE_NAME, id: upload._id},
          extract: [...IMAGE_METADATA_OPTIONS],
          tag: 'image-privacy.upload',
        })) as unknown as ImageAssetDocument
      } catch (error) {
        throw new RetryableImageError(`the copy without metadata could not be uploaded (${(error as Error).message})`)
      }
      const sha1 = createHash('sha1').update(bytes).digest('hex')
      if (asset.sha1hash !== sha1 || asset.size !== bytes.length) {
        throw new RetryableImageError(`the uploaded copy ${asset._id} is not the stripped file (sha1 ${asset.sha1hash}, expected ${sha1})`)
      }
      return asset
    },
  }
}
