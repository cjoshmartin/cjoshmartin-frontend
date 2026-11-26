/**
 * What one run of the image-privacy Function does for one document event, independent of the
 * Sanity client (passed in as an ImageStore), so it can be tested with an in-memory store.
 *
 * For every image asset the document references that still needs work (trigger.ts), in order:
 * 1. `replaced` with an existing stripped copy: point every reference at the copy and delete the
 *    upload (step 5).
 * 2. Take the lease: set `privacy` to `processing` with this run as holder, revision-checked, so
 *    one upload is never stripped by two runs at once (another run's fresh lease: skip it; that run
 *    points every reference at its copy, including this document's).
 * 3. Download the upload (sha1 checked) and run the stripper (privacy/image-strip.ts). No personal
 *    metadata: mark it `clean` and leave it alone.
 * 4. Otherwise upload the stripped bytes (only placeholders and palette extracted, never EXIF or
 *    location), check that the copy has the same dimensions (so crop and hotspot stay right), mark
 *    the copy `stripped`, then mark the upload `replaced` (and remove any location or EXIF Sanity
 *    extracted into its asset document).
 * 5. Point every reference to the upload in drafts, published documents and release versions at
 *    the copy (only `_ref` changes, and a testimonial's `asciiArtSource` with it; crop, hotspot,
 *    alt, caption stay), then delete the upload once nothing references it. A reference added
 *    meanwhile is caught by deleting with a check and repeating, and in the worst case by the
 *    filter, which matches `replaced`. A version in a release that can no longer be edited keeps
 *    its reference; the upload stays `replaced` until the release is published (the published
 *    document's event repoints it) or archived (the upload-privacy Function's sweep deletes it).
 * A file that cannot be stripped is marked `failed` (final for this version; the Studio warns); a
 * problem that is not the file's fault is marked `pending` and retried after RETRY_DELAY_SECONDS.
 */
import {IMAGE_STRIP_VERSION, PRIVACY_FIELD, type AssetPrivacy} from '../privacy/constants'
import {IMAGE_MIME_TYPES, ImageStripError, stripImage, type ImageStripResult} from '../privacy/image-strip'
import {
  assetNeedsWork,
  imageAssetIds,
  isStrippedImage,
  repointSet,
  STALE_PROCESSING_SECONDS,
  type ImageAssetDocument,
} from './trigger'

export type StoredDocument = Record<string, unknown> & {_id: string; _type: string; _rev: string}

export interface PatchOps {
  set?: Record<string, unknown>
  unset?: string[]
}

export type DeleteOutcome = {kind: 'deleted'} | {kind: 'missing'} | {kind: 'referenced'; by: string[]}

/** The Content Lake and asset operations a run needs. */
export interface ImageStore {
  /** The document with this exact id (drafts and versions included), or null. */
  getDocument(id: string): Promise<StoredDocument | null>
  patchIfRevision(id: string, revision: string, ops: PatchOps): Promise<'ok' | 'conflict'>
  /** Ids of every document (drafts, published, release versions) that references the asset. */
  referencing(assetId: string): Promise<string[]>
  /**
   * Whether the Function may write to the document: drafts and published documents always, a
   * release version only while its release is active (privacy/releases.ts).
   */
  isWritable(id: string): Promise<boolean>
  /** Deletes the asset if nothing references it. */
  deleteAssetIfUnreferenced(assetId: string): Promise<DeleteOutcome>
  /** The upload's bytes, checked against its sha1hash and size. */
  download(asset: ImageAssetDocument): Promise<Uint8Array>
  /**
   * Uploads the stripped bytes as an image asset with source {name: IMAGE_PRIVACY_SOURCE_NAME, id:
   * <upload>}, the upload's file name, and only the placeholder and palette metadata extracted.
   */
  uploadStripped(bytes: Uint8Array, upload: ImageAssetDocument, mimeType: string): Promise<ImageAssetDocument>
}

/** A problem that is not the file's fault (network, API): recorded as `pending`, retried later. */
export class RetryableImageError extends Error {
  override name = 'RetryableImageError'
}

export type AssetOutcome =
  | {assetId: string; kind: 'clean'}
  | {assetId: string; kind: 'stripped'; replacement: string; removed: string[]; deleted: boolean}
  | {assetId: string; kind: 'repointed'; replacement: string; deleted: boolean}
  | {assetId: string; kind: 'held'; holder: string}
  | {assetId: string; kind: 'failed'; message: string}
  | {assetId: string; kind: 'pending'; message: string}
  | {assetId: string; kind: 'skipped'; reason: string}

export type RunOutcome =
  | {kind: 'document-missing'}
  | {kind: 'nothing-to-do'}
  | {kind: 'done'; assets: AssetOutcome[]}

export interface RunOptions {
  store: ImageStore
  documentId: string
  /** Unique per invocation; recorded as the lease holder. */
  runId: string
  /** Epoch ms after which no new asset is started (the rest waits for the next event). */
  deadline?: number
  now?: () => Date
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

/** Raised after the outcome was recorded when an asset hit an unexpected error, for the logs. */
export class UnexpectedImageError extends Error {
  override name = 'UnexpectedImageError'
}

const MAX_PATCH_ATTEMPTS = 10
const MAX_REPOINT_ROUNDS = 5
const MAX_MESSAGE_LENGTH = 600

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length <= MAX_MESSAGE_LENGTH ? oneLine : `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
}

export const RETRY_NOTE = 'It is retried automatically on the next change to a document that uses the image, 10 minutes after this attempt or later.'

/** What processing one image asset needs: the store, this run's id (the lease holder) and the clock. */
export type ImageAssetProcessorOptions = Pick<RunOptions, 'store' | 'runId' | 'now' | 'log' | 'sleep'>

/**
 * Steps 1 to 5 of the top of this file for one asset, shared by this Function's document events and
 * the upload-privacy Function's check of uploads that no document uses.
 */
export function createImageAssetProcessor(options: ImageAssetProcessorOptions): {
  processAsset: (assetId: string) => Promise<{outcome: AssetOutcome; unexpected?: unknown}>
} {
  const {store, runId} = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => undefined)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  /** Re-reads the document and applies `compute`'s patch with a revision check, retrying conflicts. */
  async function update(
    id: string,
    compute: (doc: StoredDocument) => PatchOps | null,
  ): Promise<'patched' | 'unchanged' | 'missing'> {
    for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
      const doc = await store.getDocument(id)
      if (!doc) return 'missing'
      const ops = compute(doc)
      if (!ops) return 'unchanged'
      if ((await store.patchIfRevision(id, doc._rev, ops)) === 'ok') return 'patched'
      log(`${id}: revision ${doc._rev} changed before the patch (attempt ${attempt}); re-reading`)
      await sleep(Math.min(2000, 150 * attempt) + Math.floor(Math.random() * 100))
    }
    throw new Error(`${id}: gave up after ${MAX_PATCH_ATTEMPTS} attempts, the document kept changing`)
  }

  const privacyOf = (doc: StoredDocument | null) => (doc as ImageAssetDocument | null)?.[PRIVACY_FIELD]

  /** Sets the upload's `privacy`, but only while this run holds its lease. */
  async function markUpload(assetId: string, privacy: AssetPrivacy, extra: PatchOps = {}): Promise<boolean> {
    const outcome = await update(assetId, (doc) =>
      privacyOf(doc)?.holder === runId ? {set: {[PRIVACY_FIELD]: privacy, ...extra.set}, unset: extra.unset} : null,
    )
    return outcome === 'patched'
  }

  /** Points every reference to `from` at `to`, then deletes `from` once nothing references it. */
  async function repointAndDelete(from: string, to: string): Promise<boolean> {
    for (let round = 1; round <= MAX_REPOINT_ROUNDS; round++) {
      for (const id of await store.referencing(from)) {
        if (!(await store.isWritable(id))) {
          log(`${id}: in a release that can no longer be edited; its reference to ${from} stays until the release is published or archived`)
          continue
        }
        const outcome = await update(id, (doc) => {
          const set = repointSet(doc, from, to)
          return Object.keys(set).length > 0 ? {set} : null
        })
        if (outcome === 'patched') log(`${id}: references to ${from} now point at ${to}`)
      }
      const deleted = await store.deleteAssetIfUnreferenced(from)
      if (deleted.kind !== 'referenced') {
        log(`${from}: ${deleted.kind === 'deleted' ? 'deleted' : 'already deleted'}`)
        return true
      }
      log(`${from}: still referenced by ${deleted.by.join(', ')} (round ${round}); pointing them at ${to}`)
      await sleep(200 * round)
    }
    log(`${from}: still referenced after ${MAX_REPOINT_ROUNDS} rounds; the next event of those documents finishes it`)
    return false
  }

  async function processAsset(assetId: string): Promise<{outcome: AssetOutcome; unexpected?: unknown}> {
    const asset = (await store.getDocument(assetId)) as ImageAssetDocument | null
    if (!asset || asset._type !== 'sanity.imageAsset') {
      return {outcome: {assetId, kind: 'skipped', reason: asset ? `a ${asset._type}` : 'no longer exists'}}
    }
    if (!assetNeedsWork(asset, now())) return {outcome: {assetId, kind: 'skipped', reason: 'already handled'}}

    const privacy = asset[PRIVACY_FIELD]
    if (privacy?.status === 'replaced' && privacy.replacementAssetId) {
      const copy = (await store.getDocument(privacy.replacementAssetId)) as ImageAssetDocument | null
      if (isStrippedImage(copy)) {
        const deleted = await repointAndDelete(assetId, privacy.replacementAssetId)
        return {outcome: {assetId, kind: 'repointed', replacement: privacy.replacementAssetId, deleted}}
      }
      log(`${assetId}: its stripped copy ${privacy.replacementAssetId} is gone; checking it again`)
    }

    // The lease.
    const started = now()
    const lease: AssetPrivacy = {
      status: 'processing',
      version: IMAGE_STRIP_VERSION,
      holder: runId,
      updatedAt: started.toISOString(),
      expiresAt: new Date(started.getTime() + STALE_PROCESSING_SECONDS * 1000).toISOString(),
    }
    let holder: string | undefined
    const taken = await update(assetId, (doc) => {
      const current = privacyOf(doc)
      if (!assetNeedsWork(doc as ImageAssetDocument, now())) {
        holder = current?.status === 'processing' ? (current.holder ?? 'another run') : undefined
        return null
      }
      return {set: {[PRIVACY_FIELD]: lease}}
    })
    if (taken === 'missing') return {outcome: {assetId, kind: 'skipped', reason: 'no longer exists'}}
    if (taken === 'unchanged') {
      return {outcome: holder ? {assetId, kind: 'held', holder} : {assetId, kind: 'skipped', reason: 'handled by another run meanwhile'}}
    }

    let result: ImageStripResult
    try {
      const bytes = await store.download(asset)
      result = stripImage(bytes)
    } catch (error) {
      if (error instanceof ImageStripError) {
        const message = truncate(`Location and personal metadata could not be removed: ${error.message}`)
        await markUpload(assetId, {status: 'failed', version: IMAGE_STRIP_VERSION, message, updatedAt: now().toISOString()})
        return {outcome: {assetId, kind: 'failed', message}}
      }
      return pending(assetId, error)
    }

    if (!result.output) {
      await markUpload(assetId, {
        status: 'clean',
        version: IMAGE_STRIP_VERSION,
        removed: [],
        message: result.removed.length > 0 ? truncate(`Only technical metadata: ${result.removed.map((r) => r.what).join('; ')}`) : '',
        updatedAt: now().toISOString(),
      })
      return {outcome: {assetId, kind: 'clean'}}
    }

    let copy: ImageAssetDocument
    try {
      copy = await store.uploadStripped(result.output, asset, IMAGE_MIME_TYPES[result.format])
    } catch (error) {
      return pending(assetId, error)
    }
    const width = asset.metadata?.dimensions?.width
    const height = asset.metadata?.dimensions?.height
    if (copy.metadata?.dimensions?.width !== width || copy.metadata?.dimensions?.height !== height) {
      const message = truncate(
        `The copy without metadata has other dimensions (${copy.metadata?.dimensions?.width}x${copy.metadata?.dimensions?.height}, the upload ${width}x${height}), so crops would move; the upload was kept.`,
      )
      await markUpload(assetId, {status: 'failed', version: IMAGE_STRIP_VERSION, message, updatedAt: now().toISOString()})
      return {outcome: {assetId, kind: 'failed', message}}
    }
    try {
      // The copy is marked before anything points at it, so the documents' update events find
      // nothing to do (recursion guard).
      const copyPrivacy: AssetPrivacy = {
        status: 'stripped',
        version: IMAGE_STRIP_VERSION,
        strippedFrom: assetId,
        removed: result.personal,
        updatedAt: now().toISOString(),
      }
      await update(copy._id, () => ({set: {[PRIVACY_FIELD]: copyPrivacy}}))
      const replaced: AssetPrivacy = {
        status: 'replaced',
        version: IMAGE_STRIP_VERSION,
        replacementAssetId: copy._id,
        removed: result.personal,
        updatedAt: now().toISOString(),
      }
      // Location and EXIF that Sanity may have extracted into the upload's asset document go too.
      const extracted = ['location', 'exif', 'image'].filter((k) => asset.metadata?.[k as 'location'] !== undefined)
      if (!(await markUpload(assetId, replaced, {unset: extracted.map((k) => `metadata.${k}`)}))) {
        throw new Error(`${assetId}: lost the lease before marking it replaced`)
      }
    } catch (error) {
      return pending(assetId, error)
    }
    log(`${assetId}: stripped to ${copy._id}; removed ${result.personal.join('; ')}`)
    const deleted = await repointAndDelete(assetId, copy._id)
    return {outcome: {assetId, kind: 'stripped', replacement: copy._id, removed: result.personal, deleted}}
  }

  async function pending(assetId: string, error: unknown): Promise<{outcome: AssetOutcome; unexpected?: unknown}> {
    const reason = error instanceof RetryableImageError ? error.message : `unexpected error (${errorText(error)})`
    const message = truncate(`Could not check the image yet: ${reason}. ${RETRY_NOTE}`)
    await markUpload(assetId, {status: 'pending', version: IMAGE_STRIP_VERSION, message, updatedAt: now().toISOString()})
    return {outcome: {assetId, kind: 'pending', message}, ...(error instanceof RetryableImageError ? {} : {unexpected: error})}
  }

  return {processAsset}
}

export async function runImagePrivacy(options: RunOptions): Promise<RunOutcome> {
  const {store, documentId, runId} = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => undefined)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const {processAsset} = createImageAssetProcessor(options)

  const doc = await store.getDocument(documentId)
  if (!doc) return {kind: 'document-missing'}
  const ids = imageAssetIds(doc)
  const assets = await Promise.all(ids.map((id) => store.getDocument(id)))
  const todo = ids.filter((_, i) => assetNeedsWork(assets[i] as ImageAssetDocument | null, now()))
  if (todo.length === 0) return {kind: 'nothing-to-do'}

  const outcomes: AssetOutcome[] = []
  const unexpected: unknown[] = []
  for (const assetId of todo) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      log(`${assetId}: not started, the run is near its time limit; the next event of ${documentId} handles it`)
      break
    }
    try {
      const {outcome, unexpected: error} = await processAsset(assetId)
      outcomes.push(outcome)
      log(`${assetId}: ${describeOutcome(outcome)}`)
      if (error !== undefined) unexpected.push(error)
    } catch (error) {
      // An API error while pointing references at the copy or deleting the upload: the upload is
      // `replaced` (the filter matches it again on the next event) or its lease goes stale.
      unexpected.push(error)
      log(`${assetId}: stopped by an error (${errorText(error)})`)
    }
  }
  if (unexpected.length > 0) {
    throw new UnexpectedImageError(
      `${documentId}: ${unexpected.length} image(s) hit an unexpected error (recorded as pending): ${unexpected.map(errorText).join('; ')}`,
      {cause: unexpected[0]},
    )
  }
  return {kind: 'done', assets: outcomes}
}

export function describeOutcome(outcome: AssetOutcome): string {
  switch (outcome.kind) {
    case 'clean':
      return 'no personal metadata; left as it is'
    case 'stripped':
      return `replaced by ${outcome.replacement} without ${outcome.removed.join('; ')}; upload ${outcome.deleted ? 'deleted' : 'still referenced'}`
    case 'repointed':
      return `references moved to ${outcome.replacement}; upload ${outcome.deleted ? 'deleted' : 'still referenced'}`
    case 'held':
      return `being handled by run ${outcome.holder}`
    case 'failed':
      return `failed: ${outcome.message}`
    case 'pending':
      return `pending: ${outcome.message}`
    case 'skipped':
      return `skipped (${outcome.reason})`
  }
}
