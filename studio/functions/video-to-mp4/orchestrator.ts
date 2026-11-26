/**
 * What one run of the video-to-mp4 Function does for one document event, independent of the
 * Sanity client and of ffmpeg (both are passed in), so it can be tested with an in-memory store.
 *
 * 1. Read the document and pick its first video block that needs work (trigger.ts). One block
 *    per run; marking it `processing` causes an update event that starts a run for the next one.
 * 2. Take the lease on the upload's asset document (patches.ts, LEASE_FIELD), so no two runs ever
 *    convert the same upload at the same time, even for different documents. If another run holds
 *    it, mark the block `processing` ("waiting") and stop: the holder delivers its result to every
 *    waiting block when it is done.
 * 3. Mark the block `processing`, then produce the MP4: adopt the file if it already is an MP4
 *    converted with the current settings, swap an MP4 made with older settings back to its
 *    original upload (converted by the next run), reuse an earlier conversion of the same upload
 *    with the current settings (asset `source` and CONVERTED_ASSET_SETTINGS_FIELD), or convert and
 *    upload a new one.
 * 4. Deliver the result to the block and to every other draft or published block that uses the
 *    same upload (a draft published mid-conversion is converted in its published document without
 *    a second conversion), release the lease, then deliver once more to blocks that started
 *    waiting while the lease was held.
 *
 * Every document write is a patch addressed by block `_key` and guarded by the document revision
 * that was read (ifRevisionID), retried after re-reading on a conflict, so a concurrent edit is
 * never overwritten and a block that changed meanwhile is left alone.
 */
import {
  CONVERTED_ASSET_SETTINGS_FIELD,
  CONVERTED_ASSET_SOURCE_NAME,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
} from './settings'
import {
  documentResultOps,
  LEASE_FIELD,
  blocksWaitingFor,
  leaseHeldByOther,
  newLease,
  processingOps,
  type ConversionResult,
  type Lease,
  type PatchOps,
} from './patches'
import {
  fileAssetId,
  isFailedForCurrentFile,
  isFreshProcessing,
  needsConversion,
  nextPendingVideo,
  RETRY_NOTE,
  videoBlocks,
  type SanityDocumentLike,
} from './trigger'

export type StoredDocument = SanityDocumentLike & {_rev: string}

/** The asset document of an upload (`sanity.fileAsset`). */
export interface AssetDocument {
  _id: string
  _type: string
  _rev: string
  url?: string
  size?: number
  mimeType?: string
  originalFilename?: string
  sha1hash?: string
  source?: {name?: string; id?: string; url?: string}
  /** On a converted MP4: the SETTINGS_VERSION it was made with. */
  [CONVERTED_ASSET_SETTINGS_FIELD]?: unknown
  [LEASE_FIELD]?: unknown
}

/** The Content Lake operations a run needs. */
export interface ContentStore {
  /** The document with this exact id (drafts included), or null. Strongly consistent. */
  getDocument(id: string): Promise<StoredDocument | null>
  /** Applies the patch only if the document still has `revision`. */
  patchIfRevision(id: string, revision: string, ops: PatchOps): Promise<'ok' | 'conflict'>
  /** Ids of draft and published documents with a video block whose `file` is this asset. */
  documentsUsingFile(assetId: string): Promise<string[]>
  /**
   * The oldest MP4 asset with source {name: "video-to-mp4", id: sourceAssetId} made with the
   * current settings (CONVERTED_ASSET_SETTINGS_FIELD == SETTINGS_VERSION), or null.
   */
  findConvertedAsset(sourceAssetId: string): Promise<AssetDocument | null>
}

/**
 * A conversion that failed because of the video itself (not a video, too long, cannot be
 * decoded, ...). Recorded as `failed`, final until the file changes.
 */
export class ConversionFailure extends Error {
  override name = 'ConversionFailure'
}

/**
 * A conversion that failed for a reason that is not the video's fault (the converter's setup, a
 * download, ...). Recorded as `pending` and retried after RETRY_DELAY_SECONDS.
 */
export class RetryableConversionError extends Error {
  override name = 'RetryableConversionError'
}

export interface Converter {
  /** Converts the upload to MP4 and uploads it. Throws ConversionFailure for expected failures. */
  convert(source: AssetDocument): Promise<{outputAssetId: string; message: string}>
}

export interface RunOptions {
  store: ContentStore
  converter: Converter
  documentId: string
  /** Unique per invocation; recorded as the lease holder. */
  runId: string
  now?: () => Date
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

export interface Origin {
  documentId: string
  field: string
  key: string
}

export type RunOutcome =
  | {kind: 'document-missing'}
  | {kind: 'nothing-to-do'}
  | {kind: 'waiting'; assetId: string; holder: string}
  | {kind: 'no-target'; assetId: string}
  | {kind: 'done'; assetId: string; result: ConversionResult; patchedDocuments: string[]}

/**
 * Raised after the result was recorded (as `pending`, to be retried) when the conversion hit an
 * unexpected error, so it shows in the Function logs.
 */
export class UnexpectedConversionError extends Error {
  override name = 'UnexpectedConversionError'
}

const MAX_PATCH_ATTEMPTS = 10
const MAX_LEASE_ROUNDS = 3

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The draft and published ids of a document id. */
export function draftAndPublishedIds(id: string): [string, string] {
  const published = id.startsWith('drafts.') ? id.slice('drafts.'.length) : id
  return [`drafts.${published}`, published]
}

export async function runVideoToMp4(options: RunOptions): Promise<RunOutcome> {
  const {store, converter, documentId, runId} = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => undefined)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  /**
   * Re-reads the document and applies `compute`'s patch if it still has the revision read,
   * retrying on conflicts. 'unchanged' means compute found nothing to do.
   */
  async function updateDocument(
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
    throw new Error(
      `${id}: gave up after ${MAX_PATCH_ATTEMPTS} attempts, the document kept changing between read and patch`,
    )
  }

  async function readLease(
    assetId: string,
  ): Promise<
    {kind: 'missing'} | {kind: 'held'; lease: Lease} | {kind: 'free'; asset: AssetDocument}
  > {
    const asset = (await store.getDocument(assetId)) as AssetDocument | null
    if (!asset) return {kind: 'missing'}
    const lease = asset[LEASE_FIELD]
    if (leaseHeldByOther(lease, runId, now())) return {kind: 'held', lease}
    return {kind: 'free', asset}
  }

  async function acquireLease(
    assetId: string,
  ): Promise<{kind: 'missing'} | {kind: 'held'; lease: Lease} | {kind: 'acquired'}> {
    for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
      const state = await readLease(assetId)
      if (state.kind !== 'free') return state
      const lease = newLease(runId, documentId, now())
      const outcome = await store.patchIfRevision(assetId, state.asset._rev, {
        set: {[LEASE_FIELD]: lease},
      })
      if (outcome === 'ok') return {kind: 'acquired'}
      await sleep(100 * attempt + Math.floor(Math.random() * 100))
    }
    throw new Error(`${assetId}: could not take the conversion lease (asset kept changing)`)
  }

  async function releaseLease(assetId: string): Promise<void> {
    const outcome = await updateDocument(assetId, (asset) => {
      const lease = (asset as AssetDocument)[LEASE_FIELD] as Partial<Lease> | undefined
      return lease?.holder === runId ? {unset: [LEASE_FIELD]} : null
    })
    if (outcome === 'patched') log(`${assetId}: lease released`)
  }

  /** Marks the origin block processing; false if it no longer waits for this upload. */
  async function markProcessing(
    origin: Origin,
    assetId: string,
    message: string,
    overwriteFresh: boolean,
  ): Promise<boolean> {
    const outcome = await updateDocument(origin.documentId, (doc) => {
      const video = videoBlocks(doc).find((v) => v.field === origin.field && v.key === origin.key)
      if (!video) return null
      if (fileAssetId(video.block.file) !== assetId) return null
      if (!needsConversion(video.block) || isFailedForCurrentFile(video.block)) return null
      if (!overwriteFresh && isFreshProcessing(video.block, now())) return null
      return processingOps(video, assetId, message, now())
    })
    return outcome === 'patched'
  }

  async function candidateDocuments(assetId: string, origin: Origin): Promise<string[]> {
    const ids = new Set<string>(draftAndPublishedIds(origin.documentId))
    for (const id of await store.documentsUsingFile(assetId)) ids.add(id)
    return [...ids].sort()
  }

  async function anyBlockWaiting(assetId: string, origin: Origin): Promise<boolean> {
    for (const id of await candidateDocuments(assetId, origin)) {
      const doc = await store.getDocument(id)
      if (doc && blocksWaitingFor(doc, assetId).length > 0) return true
    }
    return false
  }

  async function deliver(result: ConversionResult, origin: Origin): Promise<string[]> {
    const patched: string[] = []
    for (const id of await candidateDocuments(result.fileAssetId, origin)) {
      const outcome = await updateDocument(id, (doc) =>
        documentResultOps(doc, result, origin, now()),
      )
      if (outcome === 'patched') patched.push(id)
    }
    return patched
  }

  async function produceResult(
    assetId: string,
  ): Promise<{result: ConversionResult; unexpected?: unknown}> {
    const failed = (message: string): ConversionResult => ({
      status: 'failed',
      fileAssetId: assetId,
      message,
    })
    const retry = (reason: string): ConversionResult => ({
      status: 'retry',
      fileAssetId: assetId,
      message: `Could not convert yet: ${reason}. ${RETRY_NOTE}`,
    })
    const asset = (await store.getDocument(assetId)) as AssetDocument | null
    if (!asset) {
      return {result: failed('The uploaded file no longer exists. Upload the video again.')}
    }
    if (asset._type !== 'sanity.fileAsset') {
      return {result: failed(`${assetId} is a ${asset._type}, not an uploaded file.`)}
    }

    if (asset.source?.name === CONVERTED_ASSET_SOURCE_NAME && asset.mimeType === OUTPUT_MIME_TYPE) {
      const originalId = typeof asset.source.id === 'string' ? asset.source.id : undefined
      const original = originalId ? await store.getDocument(originalId) : null
      const madeWith = asset[CONVERTED_ASSET_SETTINGS_FIELD]
      if (madeWith === SETTINGS_VERSION) {
        // The editor picked an MP4 this converter made with the current settings: use it as it is.
        return {
          result: {
            status: 'ready',
            fileAssetId: assetId,
            sourceAssetId: originalId ?? assetId,
            outputAssetId: assetId,
            original: original && originalId ? {assetId: originalId} : null,
            settingsVersion: SETTINGS_VERSION,
            message: 'This file is already an MP4 made by the converter; it was used as it is.',
          },
        }
      }
      if (original && originalId && original._type === 'sanity.fileAsset') {
        // An MP4 made with older settings: convert its original again rather than the MP4 itself.
        return {
          result: {
            status: 'restart',
            fileAssetId: assetId,
            originalAssetId: originalId,
            message: `${assetId} was made with older settings (${typeof madeWith === 'string' ? madeWith : 'not recorded'}); its original upload is converted again.`,
          },
        }
      }
      // An old MP4 whose original is gone is converted like any other upload.
      log(
        `${assetId}: an MP4 made with older settings (${typeof madeWith === 'string' ? madeWith : 'not recorded'}) whose original no longer exists; converting it`,
      )
    }

    const existing = await store.findConvertedAsset(assetId)
    if (existing) {
      log(`${assetId}: reusing the earlier conversion ${existing._id}`)
      return {
        result: {
          status: 'ready',
          fileAssetId: assetId,
          sourceAssetId: assetId,
          outputAssetId: existing._id,
          original: 'current-file',
          settingsVersion: SETTINGS_VERSION,
          message: `Reused the MP4 converted earlier from this upload (${existing.originalFilename ?? existing._id}).`,
        },
      }
    }

    try {
      const output = await converter.convert(asset)
      return {
        result: {
          status: 'ready',
          fileAssetId: assetId,
          sourceAssetId: assetId,
          outputAssetId: output.outputAssetId,
          original: 'current-file',
          settingsVersion: SETTINGS_VERSION,
          message: output.message,
        },
      }
    } catch (error) {
      if (error instanceof ConversionFailure) return {result: failed(error.message)}
      if (error instanceof RetryableConversionError) return {result: retry(error.message)}
      return {
        result: retry(`unexpected error while converting (${errorText(error)})`),
        unexpected: error,
      }
    }
  }

  const doc = await store.getDocument(documentId)
  if (!doc) return {kind: 'document-missing'}
  const video = nextPendingVideo(doc, now())
  if (!video) return {kind: 'nothing-to-do'}
  const assetId = fileAssetId(video.block.file) as string
  const origin: Origin = {documentId, field: video.field, key: video.key}
  log(`${documentId}: ${video.field}[_key=="${video.key}"] needs ${assetId} converted`)

  for (let round = 1; round <= MAX_LEASE_ROUNDS; round++) {
    const lease = await acquireLease(assetId)

    if (lease.kind === 'missing') {
      const result: ConversionResult = {
        status: 'failed',
        fileAssetId: assetId,
        message: 'The uploaded file no longer exists. Upload the video again.',
      }
      return {kind: 'done', assetId, result, patchedDocuments: await deliver(result, origin)}
    }

    if (lease.kind === 'held') {
      // Mark first, then look at the lease again: if the holder releases after this second look,
      // its final delivery (after the release) sees this mark and completes the block.
      await markProcessing(
        origin,
        assetId,
        `Waiting for another conversion of this upload (started ${lease.lease.acquiredAt}).`,
        false,
      )
      const again = await readLease(assetId)
      if (again.kind === 'held') {
        log(`${assetId}: being converted by run ${again.lease.holder}; this block waits for it`)
        return {kind: 'waiting', assetId, holder: again.lease.holder}
      }
      continue
    }

    log(`${assetId}: lease taken (round ${round})`)
    let produced: {result: ConversionResult; unexpected?: unknown} | undefined
    const patched = new Set<string>()
    let failure: unknown
    try {
      const marked = await markProcessing(origin, assetId, 'Converting to MP4.', true)
      if (marked || (await anyBlockWaiting(assetId, origin))) {
        produced = await produceResult(assetId)
        for (const id of await deliver(produced.result, origin)) patched.add(id)
      }
    } catch (error) {
      failure = error
    }
    try {
      await releaseLease(assetId)
    } catch (releaseError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, releaseError],
          `${assetId}: run failed and the lease could not be released`,
        )
      }
      throw releaseError
    }
    if (failure !== undefined) throw failure

    if (produced) {
      for (const id of await deliver(produced.result, origin)) patched.add(id)
      const outcome: RunOutcome = {
        kind: 'done',
        assetId,
        result: produced.result,
        patchedDocuments: [...patched].sort(),
      }
      if (produced.unexpected !== undefined) {
        throw new UnexpectedConversionError(
          `${assetId}: conversion failed unexpectedly (recorded as pending, to be retried): ${errorText(produced.unexpected)}`,
          {cause: produced.unexpected},
        )
      }
      return outcome
    }
    if (!(await anyBlockWaiting(assetId, origin))) return {kind: 'no-target', assetId}
    log(`${assetId}: a block started waiting while the lease was held; taking it again`)
  }
  throw new Error(`${assetId}: gave up after ${MAX_LEASE_ROUNDS} lease rounds`)
}
