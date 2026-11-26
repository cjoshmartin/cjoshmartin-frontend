/**
 * Strips an image that was uploaded as a file asset (a file link before it accepted PDFs only, or
 * an API client). File assets are served exactly as stored at /files/, so its location would be
 * public. The image-privacy Function's stripper makes the copy (coded image, orientation and ICC
 * profile byte for byte), which is uploaded as a file asset with source {name: "image-privacy",
 * id: <upload>} and marked `stripped`; the upload is marked `replaced`. An image with nothing
 * personal is marked `clean`.
 */
import {createHash} from 'node:crypto'

import type {SanityClient} from '@sanity/client'

import {IMAGE_PRIVACY_SOURCE_NAME, IMAGE_STRIP_VERSION, PRIVACY_FIELD, type AssetPrivacy} from '../privacy/constants'
import {IMAGE_MIME_TYPES, ImageStripError, stripImage} from '../privacy/image-strip'
import type {StoredDocument} from '../image-privacy/orchestrator'
import {UploadStripFailure} from './orchestrator'

/** Largest image file the Function reads into memory. */
const MAX_IMAGE_FILE_BYTES = 200 * 1000 * 1000

type FileAsset = StoredDocument & {url?: string; size?: number; sha1hash?: string; originalFilename?: string; mimeType?: string}

export async function stripImageFile(
  client: SanityClient,
  upload: FileAsset,
  options: {deadline: number; fetchImpl?: typeof fetch},
): Promise<{assetId: string; clean: boolean; message: string}> {
  if (!upload.url) throw new Error(`${upload._id} has no URL yet`)
  if (upload.size !== undefined && upload.size > MAX_IMAGE_FILE_BYTES) {
    throw new UploadStripFailure(`The image is ${(upload.size / 1e6).toFixed(0)} MB, more than the Function reads; upload a smaller file.`)
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(upload.url, {headers: {'accept-encoding': 'identity'}, signal: AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))})
  if (!response.ok) throw new Error(`the file could not be downloaded (HTTP ${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (upload.size !== undefined && bytes.length !== upload.size) throw new Error(`downloaded ${bytes.length} bytes, the asset has ${upload.size}`)
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  if (upload.sha1hash && sha1 !== upload.sha1hash) throw new Error(`the download's sha1 ${sha1} differs from the asset's ${upload.sha1hash}`)

  let result: ReturnType<typeof stripImage>
  try {
    result = stripImage(bytes)
  } catch (error) {
    if (error instanceof ImageStripError) throw new UploadStripFailure(`Location and personal metadata could not be removed: ${error.message}`)
    throw error
  }
  const now = new Date().toISOString()
  if (!result.output) {
    const clean: AssetPrivacy = {status: 'clean', version: IMAGE_STRIP_VERSION, removed: [], updatedAt: now}
    await client.patch(upload._id).set({[PRIVACY_FIELD]: clean}).commit({visibility: 'sync'})
    return {assetId: upload._id, clean: true, message: 'The image has no location or personal metadata; it is kept as it is.'}
  }
  const copy = (await client.assets.upload('file', Buffer.from(result.output), {
    filename: upload.originalFilename ?? upload._id,
    contentType: IMAGE_MIME_TYPES[result.format],
    source: {name: IMAGE_PRIVACY_SOURCE_NAME, id: upload._id},
  })) as unknown as FileAsset
  const copySha1 = createHash('sha1').update(result.output).digest('hex')
  if (copy.sha1hash !== copySha1 || copy.size !== result.output.length) {
    throw new Error(`the uploaded copy ${copy._id} is not the stripped file (sha1 ${copy.sha1hash}, expected ${copySha1})`)
  }
  const stripped: AssetPrivacy = {status: 'stripped', version: IMAGE_STRIP_VERSION, strippedFrom: upload._id, removed: result.personal, updatedAt: now}
  await client.patch(copy._id).set({[PRIVACY_FIELD]: stripped}).commit({visibility: 'sync'})
  const replaced: AssetPrivacy = {status: 'replaced', version: IMAGE_STRIP_VERSION, replacementAssetId: copy._id, removed: result.personal, updatedAt: now}
  await client.patch(upload._id).set({[PRIVACY_FIELD]: replaced}).commit({visibility: 'sync'})
  return {assetId: copy._id, clean: false, message: `Removed ${result.personal.join('; ')}; the coded image, orientation and colour profile are unchanged.`}
}
