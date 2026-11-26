/**
 * What one run of the upload-privacy Function does (see trigger.ts), independent of the Sanity
 * client and of ffmpeg (passed in), so it can be tested with an in-memory store.
 *
 * For an upload's `create` event: remove location and EXIF data Sanity extracted into the asset
 * document, wait up to GRACE_SECONDS for a document to use the upload, then handle it. Then, for
 * every event, sweep up to SWEEP_LIMIT earlier unused uploads.
 *
 * Handling one upload (handleUpload):
 * - used by a document: nothing (the content Functions strip it and move the references);
 * - being converted (video-to-mp4 lease) or checked (a fresh `processing` mark): nothing;
 * - `replaced` by an existing copy: deleted;
 * - checked with the current stripper (`clean`, `stripped`, `failed`): nothing;
 * - otherwise stripped: an image by the image-privacy Function's own processing (a copy without
 *   location and personal metadata, references moved, the upload deleted), a video by the
 *   video-to-mp4 Function's stripper (a copy, the upload marked `replaced`, then deleted here), an
 *   image uploaded as a file (served as stored) by the image stripper into a file copy; a clean
 *   upload is marked `clean` and kept. Other files (PDF, STL) are not stripped by any Function and
 *   are left as they are.
 */
import {
  IMAGE_STRIP_VERSION,
  PRIVACY_FIELD,
  VIDEO_STRIP_VERSION,
  type AssetPrivacy,
} from '../privacy/constants'
import type {AssetOutcome, DeleteOutcome, PatchOps, StoredDocument} from '../image-privacy/orchestrator'
import {LEASE_FIELD, leaseHeldByOther} from '../video-to-mp4/patches'
import {
  GRACE_SECONDS,
  isAssetType,
  OWN_SOURCE_NAMES,
  POLL_SECONDS,
  STALE_PROCESSING_SECONDS,
  UPLOADED_SINCE,
  type UploadEventData,
} from './trigger'

/** The Content Lake operations a run needs. */
export interface UploadStore {
  /** The document with this exact id (drafts and versions included), or null. */
  getDocument(id: string): Promise<StoredDocument | null>
  patchIfRevision(id: string, revision: string, ops: PatchOps): Promise<'ok' | 'conflict'>
  /** Ids of every document (drafts, published, release versions) that references the asset. */
  referencing(assetId: string): Promise<string[]>
  /** Deletes the asset if nothing references it. */
  deleteAssetIfUnreferenced(assetId: string): Promise<DeleteOutcome>
  /** The sweep (trigger.ts SWEEP_QUERY): ids of earlier unused uploads that still need work. */
  sweepCandidates(exclude: readonly string[]): Promise<string[]>
}

/** The video stripper (video-to-mp4's stripOriginal): a copy and the upload marked `replaced`, or `clean`. */
export type VideoStripper = (upload: StoredDocument) => Promise<{assetId: string; clean: boolean; message: string}>

/**
 * The image stripper for an image uploaded as a file asset (served as stored at /files/): a copy
 * uploaded as a file asset, marked `stripped`, and the upload marked `replaced`; or the upload
 * marked `clean`. Same result shape as VideoStripper.
 */
export type ImageFileStripper = VideoStripper

/** A file the stripper cannot handle (not a video or image, cannot be read, too large): final for this version. */
export class UploadStripFailure extends Error {
  override name = 'UploadStripFailure'
}

export interface RunOptions {
  store: UploadStore
  event: UploadEventData
  /** Unique per invocation; recorded as the lease holder. */
  runId: string
  /** The image-privacy Function's processing of one image asset. */
  processImage: (assetId: string) => Promise<{outcome: AssetOutcome; unexpected?: unknown}>
  stripVideo: VideoStripper
  stripImageFile: ImageFileStripper
  /** Epoch ms after which no new upload is started. */
  deadline: number
  now?: () => Date
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

export type UploadOutcome =
  | {assetId: string; kind: 'missing' | 'in-use' | 'busy' | 'done' | 'not-ours' | 'unsupported'}
  | {assetId: string; kind: 'deleted'; reason: string}
  | {assetId: string; kind: 'kept'; reason: string}
  | {assetId: string; kind: 'image'; outcome: AssetOutcome}
  | {assetId: string; kind: 'video' | 'image-file'; result: 'clean' | 'stripped' | 'failed' | 'pending'; message: string}

export interface RunOutcome {
  extractedRemoved: boolean
  outcomes: UploadOutcome[]
}

/** Raised after the outcomes were recorded when something hit an unexpected error, for the logs. */
export class UnexpectedUploadError extends Error {
  override name = 'UnexpectedUploadError'
}

const MAX_PATCH_ATTEMPTS = 10
const MAX_MESSAGE_LENGTH = 600

function truncate(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length <= MAX_MESSAGE_LENGTH ? oneLine : `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFresh(time: unknown, now: Date, maxAgeSeconds: number): boolean {
  const parsed = typeof time === 'string' ? Date.parse(time) : Number.NaN
  return !Number.isNaN(parsed) && parsed > now.getTime() - maxAgeSeconds * 1000
}

type AssetDoc = StoredDocument & {
  _createdAt?: string
  mimeType?: string
  source?: {name?: string; id?: string}
  metadata?: Record<string, unknown>
  [PRIVACY_FIELD]?: AssetPrivacy
}

export async function runUploadPrivacy(options: RunOptions): Promise<RunOutcome> {
  const {store, event, runId} = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => undefined)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const unexpected: unknown[] = []

  /** Re-reads the document and applies `compute`'s patch with a revision check, retrying conflicts. */
  async function update(id: string, compute: (doc: AssetDoc) => PatchOps | null): Promise<'patched' | 'unchanged' | 'missing'> {
    for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
      const doc = (await store.getDocument(id)) as AssetDoc | null
      if (!doc) return 'missing'
      const ops = compute(doc)
      if (!ops) return 'unchanged'
      if ((await store.patchIfRevision(id, doc._rev, ops)) === 'ok') return 'patched'
      await sleep(Math.min(2000, 150 * attempt) + Math.floor(Math.random() * 100))
    }
    throw new Error(`${id}: gave up after ${MAX_PATCH_ATTEMPTS} attempts, the document kept changing`)
  }

  const isVideoFile = (asset: AssetDoc) => typeof asset.mimeType === 'string' && asset.mimeType.startsWith('video/')
  const versionFor = (asset: AssetDoc) => (asset._type === 'sanity.imageAsset' || !isVideoFile(asset) ? IMAGE_STRIP_VERSION : VIDEO_STRIP_VERSION)

  /** Strips a file asset (a video, or an image uploaded as a file) under a `processing` lease. */
  async function handleFile(asset: AssetDoc, kind: 'video' | 'image-file'): Promise<UploadOutcome> {
    const version = kind === 'video' ? VIDEO_STRIP_VERSION : IMAGE_STRIP_VERSION
    const strip = kind === 'video' ? options.stripVideo : options.stripImageFile
    const started = now()
    const lease: AssetPrivacy = {
      status: 'processing',
      version,
      holder: runId,
      updatedAt: started.toISOString(),
      expiresAt: new Date(started.getTime() + STALE_PROCESSING_SECONDS * 1000).toISOString(),
    }
    const taken = await update(asset._id, (doc) => (doc._rev === asset._rev ? {set: {[PRIVACY_FIELD]: lease}} : null))
    if (taken !== 'patched') return {assetId: asset._id, kind: 'busy'}
    const current = (await store.getDocument(asset._id)) as AssetDoc | null
    if (!current) return {assetId: asset._id, kind: 'missing'}
    const mark = async (privacy: AssetPrivacy) => {
      await update(asset._id, (doc) => (doc[PRIVACY_FIELD]?.holder === runId ? {set: {[PRIVACY_FIELD]: privacy}} : null))
    }
    let result: Awaited<ReturnType<VideoStripper>>
    try {
      result = await strip(current)
    } catch (error) {
      const failure = error instanceof UploadStripFailure
      const message = truncate(failure ? error.message : `Could not remove the location data yet (${errorText(error)}); retried by a later sweep.`)
      await mark({status: failure ? 'failed' : 'pending', version, message, updatedAt: now().toISOString()})
      if (!failure) unexpected.push(error)
      return {assetId: asset._id, kind, result: failure ? 'failed' : 'pending', message}
    }
    if (result.clean) return {assetId: asset._id, kind, result: 'clean', message: result.message}
    const deleted = await store.deleteAssetIfUnreferenced(asset._id)
    return {
      assetId: asset._id,
      kind,
      result: 'stripped',
      message: `${result.message} Copy ${result.assetId}; upload ${deleted.kind === 'referenced' ? `kept, now used by ${deleted.by.join(', ')}` : 'deleted'}.`,
    }
  }

  async function handleUpload(assetId: string): Promise<UploadOutcome> {
    const asset = (await store.getDocument(assetId)) as AssetDoc | null
    if (!asset) return {assetId, kind: 'missing'}
    if (!isAssetType(asset._type)) return {assetId, kind: 'not-ours'}
    const created = typeof asset._createdAt === 'string' ? Date.parse(asset._createdAt) : Number.NaN
    if (Number.isNaN(created) || created < Date.parse(UPLOADED_SINCE)) return {assetId, kind: 'not-ours'}
    if ((OWN_SOURCE_NAMES as readonly string[]).includes(asset.source?.name ?? '')) return {assetId, kind: 'not-ours'}
    if ((await store.referencing(assetId)).length > 0) return {assetId, kind: 'in-use'}
    if (leaseHeldByOther(asset[LEASE_FIELD], runId, now())) return {assetId, kind: 'busy'}

    const privacy = asset[PRIVACY_FIELD]
    if (privacy?.status === 'processing' && isFresh(privacy.updatedAt, now(), STALE_PROCESSING_SECONDS)) return {assetId, kind: 'busy'}
    if (privacy?.status === 'replaced' && privacy.replacementAssetId && (await store.getDocument(privacy.replacementAssetId))) {
      const deleted = await store.deleteAssetIfUnreferenced(assetId)
      return deleted.kind === 'referenced'
        ? {assetId, kind: 'kept', reason: `used again by ${deleted.by.join(', ')}`}
        : {assetId, kind: 'deleted', reason: `replaced by ${privacy.replacementAssetId}`}
    }
    if (privacy?.version === versionFor(asset) && ['clean', 'stripped', 'failed'].includes(privacy.status ?? '')) return {assetId, kind: 'done'}

    if (asset._type === 'sanity.imageAsset') {
      const {outcome, unexpected: error} = await options.processImage(assetId)
      if (error !== undefined) unexpected.push(error)
      return {assetId, kind: 'image', outcome}
    }
    if (isVideoFile(asset)) return handleFile(asset, 'video')
    if (typeof asset.mimeType === 'string' && asset.mimeType.startsWith('image/')) return handleFile(asset, 'image-file')
    return {assetId, kind: 'unsupported'}
  }

  // --- The event's own upload ---------------------------------------------------------------
  const outcomes: UploadOutcome[] = []
  let extractedRemoved = false
  const handled = new Set<string>()
  if (event.operation === 'create' && isAssetType(event.type)) {
    const id = event.id
    handled.add(id)
    // Location and EXIF Sanity extracted on request go at once (the asset document is public).
    const removed = await update(id, (doc) => {
      const keys = ['location', 'exif', 'image'].filter((key) => doc.metadata?.[key] !== undefined)
      return keys.length > 0 ? {unset: keys.map((key) => `metadata.${key}`)} : null
    })
    extractedRemoved = removed === 'patched'
    if (extractedRemoved) log(`${id}: removed the location and EXIF data extracted into the asset document`)
    // Wait for a document to use the upload, or for a Function to take it.
    const waitUntil = now().getTime() + GRACE_SECONDS * 1000
    for (;;) {
      const asset = (await store.getDocument(id)) as AssetDoc | null
      if (!asset || asset[PRIVACY_FIELD] !== undefined || asset[LEASE_FIELD] !== undefined) break
      if ((await store.referencing(id)).length > 0) break
      if (now().getTime() >= waitUntil) break
      await sleep(POLL_SECONDS * 1000)
    }
    try {
      outcomes.push(await handleUpload(id))
    } catch (error) {
      unexpected.push(error)
      log(`${id}: stopped by an error (${errorText(error)})`)
    }
  }

  // --- The sweep of earlier unused uploads ---------------------------------------------------
  for (const id of await store.sweepCandidates([...handled])) {
    if (Date.now() > options.deadline) {
      log(`${id}: not started, the run is near its time limit; a later event sweeps it`)
      break
    }
    try {
      outcomes.push(await handleUpload(id))
    } catch (error) {
      unexpected.push(error)
      log(`${id}: stopped by an error (${errorText(error)})`)
    }
  }

  for (const outcome of outcomes) log(`${outcome.assetId}: ${describeOutcome(outcome)}`)
  if (unexpected.length > 0) {
    throw new UnexpectedUploadError(
      `${unexpected.length} upload(s) hit an unexpected error (recorded as pending where possible): ${unexpected.map(errorText).join('; ')}`,
      {cause: unexpected[0]},
    )
  }
  return {extractedRemoved, outcomes}
}

export function describeOutcome(outcome: UploadOutcome): string {
  switch (outcome.kind) {
    case 'missing':
      return 'no longer exists'
    case 'in-use':
      return 'used by a document; the content Functions handle it'
    case 'busy':
      return 'being converted or checked by another run'
    case 'done':
      return 'already checked'
    case 'not-ours':
      return 'made by the migration or a Function; left alone'
    case 'unsupported':
      return 'not an image or a video; no Function strips it, left as it is'
    case 'deleted':
      return `deleted (${outcome.reason})`
    case 'kept':
      return `kept (${outcome.reason})`
    case 'image':
      return `image: ${outcome.outcome.kind}`
    case 'video':
    case 'image-file':
      return `${outcome.kind}: ${outcome.result}: ${outcome.message}`
  }
}
