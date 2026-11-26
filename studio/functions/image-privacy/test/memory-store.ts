/**
 * In-memory ImageStore for the orchestrator tests: documents with revisions, revision-checked
 * patches (the video Function's applyPatch), references() evaluated with groq-js, downloads from a
 * byte map and uploads that create content-addressed image assets.
 */
import {createHash, randomUUID} from 'node:crypto'

import {evaluate, parse} from 'groq-js'

import {applyPatch} from '../../video-to-mp4/test/memory-store'
import type {DeleteOutcome, ImageStore, PatchOps, StoredDocument} from '../orchestrator'
import {RetryableImageError} from '../orchestrator'
import type {ImageAssetDocument} from '../trigger'

type Doc = Record<string, unknown> & {_id: string; _type: string}

export class MemoryImageStore implements ImageStore {
  readonly docs = new Map<string, Doc & {_rev: string}>()
  readonly bytes = new Map<string, Uint8Array>()
  readonly uploads: {sourceId: string; mimeType: string; id: string}[] = []
  readonly deletions: string[] = []
  /** Called before every upload (a test publishes a draft "mid-processing" here). */
  beforeUpload: (() => void | Promise<void>) | undefined
  /** Called before every delete attempt (a test adds a reference "meanwhile" here). */
  beforeDelete: ((id: string) => void | Promise<void>) | undefined
  /** Dimensions the uploaded copy gets; by default the upload's own. */
  copyDimensions: {width: number; height: number} | undefined
  downloadError: Error | undefined

  put(doc: Doc): Doc & {_rev: string} {
    const stored = {...structuredClone(doc), _rev: randomUUID()}
    this.docs.set(doc._id, stored)
    return stored
  }

  get(id: string): (Doc & {_rev: string}) | undefined {
    const doc = this.docs.get(id)
    return doc ? structuredClone(doc) : undefined
  }

  delete(id: string): void {
    this.docs.delete(id)
  }

  /** An image asset document for `bytes`, as Sanity creates it on upload. */
  putImage(bytes: Uint8Array, extra: Partial<ImageAssetDocument> = {}): string {
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const id = `image-${sha1}-8x8-jpg`
    this.bytes.set(id, bytes)
    this.put({
      _id: id,
      _type: 'sanity.imageAsset',
      _createdAt: new Date().toISOString(),
      url: `https://cdn.sanity.io/images/p/staging/${sha1}-8x8.jpg`,
      size: bytes.length,
      sha1hash: sha1,
      mimeType: 'image/jpeg',
      originalFilename: 'IMG_0001.jpg',
      metadata: {dimensions: {width: 8, height: 8}},
      ...extra,
    })
    return id
  }

  async getDocument(id: string): Promise<StoredDocument | null> {
    await Promise.resolve()
    const doc = this.docs.get(id)
    return doc ? (structuredClone(doc) as StoredDocument) : null
  }

  async patchIfRevision(id: string, revision: string, ops: PatchOps): Promise<'ok' | 'conflict'> {
    await Promise.resolve()
    const doc = this.docs.get(id)
    if (!doc || doc._rev !== revision) return 'conflict'
    this.docs.set(id, {...applyPatch(doc, ops), _rev: randomUUID()})
    return 'ok'
  }

  async referencing(assetId: string): Promise<string[]> {
    const result = await evaluate(parse('*[references($id)]._id'), {dataset: [...this.docs.values()], params: {id: assetId}})
    return (await result.get()) as string[]
  }

  async deleteAssetIfUnreferenced(assetId: string): Promise<DeleteOutcome> {
    await this.beforeDelete?.(assetId)
    const by = await this.referencing(assetId)
    if (by.length > 0) return {kind: 'referenced', by}
    if (!this.docs.has(assetId)) return {kind: 'missing'}
    this.docs.delete(assetId)
    this.deletions.push(assetId)
    return {kind: 'deleted'}
  }

  async download(asset: ImageAssetDocument): Promise<Uint8Array> {
    if (this.downloadError) throw this.downloadError
    const bytes = this.bytes.get(asset._id)
    if (!bytes) throw new RetryableImageError(`no bytes for ${asset._id}`)
    return bytes
  }

  async uploadStripped(bytes: Uint8Array, upload: ImageAssetDocument, mimeType: string): Promise<ImageAssetDocument> {
    await this.beforeUpload?.()
    const dimensions = this.copyDimensions ?? upload.metadata?.dimensions
    const id = this.putImage(bytes, {
      originalFilename: upload.originalFilename,
      mimeType,
      source: {name: 'image-privacy', id: upload._id},
      metadata: {dimensions: {width: dimensions?.width, height: dimensions?.height}},
    })
    this.uploads.push({sourceId: upload._id, mimeType, id})
    return this.get(id) as unknown as ImageAssetDocument
  }
}
