/**
 * What one run of the upload-privacy Function does (see trigger.ts), independent of the Sanity
 * client and of ffmpeg (passed in), so it can be tested with an in-memory store.
 *
 * For an upload's `create` event: remove location and EXIF data Sanity extracted into the asset
 * document, wait up to GRACE_SECONDS for a document to use the upload, then handle it. Then, for
 * every event, sweep up to SWEEP_LIMIT earlier unused uploads.
 *
 * The wait (waitForUse) decides from what it saw, not from one last query: an upload a reference
 * query showed as used is left to the content Functions, even if a query a moment later does not
 * show the reference (the query index can lag a just-written draft; recreate fix round 1, finding
 * 4), and an upload not readable yet right after its create event is waited for, not handled.
 * Only an upload no query showed as used for the whole grace period is handled as unused.
 *
 * Extracted location or EXIF is also a warning: the upload itself wrote it into the asset
 * document's first revision, which the History API of a public dataset serves without a token
 * for the history retention period. Removing it from the document cannot change that revision.
 *
 * Handling one upload (handleUpload):
 * - used by a document: nothing (the content Functions strip it and move the references);
 * - being converted (video-to-mp4 lease) or checked (a fresh `processing` mark): nothing;
 * - `replaced` by an existing copy: deleted;
 * - checked with the current stripper (`clean`, `stripped`): nothing;
 * - `failed` with the current stripper (its location data cannot be removed): deleted, because a
 *   file with its location is never kept in the public dataset (privacy review round 2, finding 2);
 * - otherwise stripped: an image by the image-privacy Function's own processing (a copy without
 *   location and personal metadata, references moved, the upload deleted), a video by the
 *   video-to-mp4 Function's stripper (a copy, the upload marked `replaced`, then deleted here), an
 *   image uploaded as a file (served as stored) by the image stripper into a file copy; a clean
 *   upload is marked `clean` and kept; an upload the stripper fails on is marked `failed` and
 *   deleted. Other files (PDF, STL) are not stripped by any Function and
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
  /** For what the owner must act on (WARN in the Function logs); defaults to `log`. */
  warn?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * How the wait for a document to use the event's own upload ended (waitForUse), after `seconds`.
 * - `referenced`: a reference query returned `by` documents; `recheck` is what one more query
 *   returned right after (0 means the query index lagged; the first answer is kept);
 * - `taken`: a Function marked the upload (`privacy`) or holds its video lease;
 * - `deleted`: the upload was readable during the wait and then gone;
 * - `never-readable`: the upload was not readable during the whole grace period;
 * - `unused`: readable, unmarked and used by no document for the whole grace period.
 */
export type WaitEnd =
  | {kind: 'referenced'; seconds: number; by: number; recheck: number}
  | {kind: 'taken' | 'deleted' | 'never-readable' | 'unused'; seconds: number}

/** The keys of extracted metadata that hold location, camera or EXIF data. */
const EXTRACTED_PERSONAL_KEYS = ['location', 'exif', 'image'] as const

export type UploadOutcome =
  | {assetId: string; kind: 'missing' | 'in-use' | 'busy' | 'done' | 'not-ours' | 'unsupported'}
  | {assetId: string; kind: 'deleted'; reason: string}
  | {assetId: string; kind: 'kept'; reason: string}
  | {assetId: string; kind: 'image'; outcome: AssetOutcome}
  | {assetId: string; kind: 'video' | 'image-file'; result: 'clean' | 'stripped' | 'failed' | 'pending'; message: string}

export interface RunOutcome {
  extractedRemoved: boolean
  /** How the wait for the event's own upload ended (a `create` event of an asset only). */
  wait?: WaitEnd
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
  const warn = options.warn ?? log
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
      if (!failure) {
        unexpected.push(error)
        return {assetId: asset._id, kind, result: 'pending', message}
      }
      return deleteUnstrippable(asset._id, message)
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

  /** Deletes an unused upload whose location data the current stripper cannot remove. */
  async function deleteUnstrippable(assetId: string, message: string): Promise<UploadOutcome> {
    const deleted = await store.deleteAssetIfUnreferenced(assetId)
    if (deleted.kind === 'referenced') return {assetId, kind: 'kept', reason: `its location data cannot be removed (${message}), but it is used again by ${deleted.by.join(', ')}`}
    log(`${assetId}: its location data cannot be removed (${message}); deleted`)
    return {assetId, kind: 'deleted', reason: 'its location data cannot be removed'}
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
    if (privacy?.version === versionFor(asset) && privacy.status === 'failed') return deleteUnstrippable(assetId, privacy.message ?? 'no message was recorded')
    if (privacy?.version === versionFor(asset) && ['clean', 'stripped'].includes(privacy.status ?? '')) return {assetId, kind: 'done'}

    if (asset._type === 'sanity.imageAsset') {
      const {outcome, unexpected: error} = await options.processImage(assetId)
      if (error !== undefined) unexpected.push(error)
      if (outcome.kind === 'failed') return deleteUnstrippable(assetId, outcome.message)
      return {assetId, kind: 'image', outcome}
    }
    if (isVideoFile(asset)) return handleFile(asset, 'video')
    if (typeof asset.mimeType === 'string' && asset.mimeType.startsWith('image/')) return handleFile(asset, 'image-file')
    return {assetId, kind: 'unsupported'}
  }

  // --- The event's own upload ---------------------------------------------------------------
  const outcomes: UploadOutcome[] = []
  let extractedRemoved = false
  let wait: WaitEnd | undefined
  const handled = new Set<string>()

  /**
   * Location and EXIF Sanity extracted on request go at once (the asset document is public), with
   * a warning: the upload's first revision keeps them in the History API.
   */
  async function removeExtracted(id: string): Promise<'patched' | 'unchanged' | 'missing'> {
    let keys: string[] = []
    const removed = await update(id, (doc) => {
      keys = EXTRACTED_PERSONAL_KEYS.filter((key) => doc.metadata?.[key] !== undefined)
      return keys.length > 0 ? {unset: keys.map((key) => `metadata.${key}`)} : null
    })
    if (removed === 'patched') {
      extractedRemoved = true
      log(`${id}: removed the location and EXIF data extracted into the asset document`)
      warn(
        `${id}: the upload asked Sanity to extract ${keys.join(', ')} (the Studio never does). Its first revision keeps that data, and the History API of a public dataset serves it without a token for the dataset's history retention period: removing it from the asset document cannot change that revision, only deleting and creating the dataset again does (docs/sanity-migration/reports/dataset-recreate.md, fix round 1). Never ask an upload for location, exif or image (@sanity/client's extract, the HTTP API's meta parameter).`,
      )
    }
    return removed
  }

  /**
   * Waits up to GRACE_SECONDS for a document to use the upload or for a Function to take it. A
   * reference query that shows a use ends the wait for good: one more query right after is only
   * recorded (`recheck`), because a query can briefly miss a draft written a moment before. An
   * upload not readable yet is waited for (its extracted data is removed once it is readable).
   */
  async function waitForUse(id: string, readable: boolean): Promise<WaitEnd> {
    const started = now().getTime()
    const waitUntil = started + GRACE_SECONDS * 1000
    const seconds = () => (now().getTime() - started) / 1000
    let seen = readable
    for (;;) {
      const asset = (await store.getDocument(id)) as AssetDoc | null
      if (asset) {
        if (!seen) await removeExtracted(id)
        seen = true
        if (asset[PRIVACY_FIELD] !== undefined || asset[LEASE_FIELD] !== undefined) return {kind: 'taken', seconds: seconds()}
        const by = (await store.referencing(id)).length
        if (by > 0) return {kind: 'referenced', seconds: seconds(), by, recheck: (await store.referencing(id)).length}
      } else if (seen) {
        return {kind: 'deleted', seconds: seconds()}
      }
      if (now().getTime() >= waitUntil) return {kind: seen ? 'unused' : 'never-readable', seconds: seconds()}
      await sleep(POLL_SECONDS * 1000)
    }
  }

  if (event.operation === 'create' && isAssetType(event.type)) {
    const id = event.id
    handled.add(id)
    const removed = await removeExtracted(id)
    // Wait for a document to use the upload, or for a Function to take it.
    wait = await waitForUse(id, removed !== 'missing')
    log(`${id}: ${describeWait(wait)}`)
    if (wait.kind === 'referenced') {
      // Seen in use: the content Functions handle it, whatever a later query says.
      outcomes.push({assetId: id, kind: 'in-use'})
    } else {
      try {
        outcomes.push(await handleUpload(id))
      } catch (error) {
        unexpected.push(error)
        log(`${id}: stopped by an error (${errorText(error)})`)
      }
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
  return {extractedRemoved, ...(wait ? {wait} : {}), outcomes}
}

export function describeWait(wait: WaitEnd): string {
  const after = `${wait.seconds.toFixed(1)} s`
  switch (wait.kind) {
    case 'referenced':
      return (
        `wait ended after ${after}: used by ${wait.by} document(s)` +
        (wait.recheck === 0 ? '; a second reference query right after found none (the query index lagged), so the first answer is kept' : '')
      )
    case 'taken':
      return `wait ended after ${after}: a Function took the upload`
    case 'deleted':
      return `wait ended after ${after}: the upload was deleted meanwhile`
    case 'never-readable':
      return `wait ended after ${after}: the upload was never readable`
    case 'unused':
      return `wait ended after ${after}: no document used the upload`
  }
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
