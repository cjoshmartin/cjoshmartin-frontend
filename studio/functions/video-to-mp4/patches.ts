/**
 * The patches the video-to-mp4 Function writes, and the per-asset lease that keeps two runs from
 * converting the same upload at the same time. Pure functions, no I/O.
 */
import {SETTINGS_VERSION} from './settings'
import {
  fileAssetId,
  isFailedForCurrentFile,
  isWaitingToRetry,
  needsConversion,
  STALE_PROCESSING_SECONDS,
  videoBlocks,
  type ConversionStatus,
  type ConversionValue,
  type FileValue,
  type LocatedVideo,
  type SanityDocumentLike,
} from './trigger'

/** `set` and `unset` of one Sanity patch mutation. */
export interface PatchOps {
  set?: Record<string, unknown>
  unset?: string[]
}

/** conversion.message is shown in the Studio; long ffmpeg output is cut to this length. */
export const MAX_MESSAGE_LENGTH = 600

export function truncateMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length <= MAX_MESSAGE_LENGTH
    ? oneLine
    : `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
}

/** Patch path of a block (or one of its fields) in a Portable Text field, addressed by `_key`. */
export function blockPath(field: string, key: string, child?: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new TypeError(`invalid field name ${field}`)
  const base = `${field}[_key==${JSON.stringify(key)}]`
  return child === undefined ? base : `${base}.${child}`
}

export function fileReference(assetId: string): FileValue {
  return {_type: 'file', asset: {_type: 'reference', _ref: assetId}}
}

/**
 * `conversion` with the given status. `settingsVersion` is the version of the settings that made
 * (or are making) the MP4: SETTINGS_VERSION unless a ready result names the version recorded on
 * the MP4 asset it uses.
 */
function conversionValue(
  status: ConversionStatus,
  fields: Omit<ConversionValue, 'status' | 'settingsVersion' | 'updatedAt'>,
  now: Date,
  settingsVersion: string = SETTINGS_VERSION,
): ConversionValue {
  return {
    status,
    ...fields,
    ...(fields.message === undefined ? {} : {message: truncateMessage(fields.message)}),
    settingsVersion,
    updatedAt: now.toISOString(),
  }
}

/** Merges patch operations for several blocks of one document. */
export function mergeOps(parts: PatchOps[]): PatchOps | null {
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const part of parts) {
    Object.assign(set, part.set ?? {})
    unset.push(...(part.unset ?? []))
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return null
  return {
    ...(Object.keys(set).length > 0 ? {set} : {}),
    ...(unset.length > 0 ? {unset} : {}),
  }
}

/**
 * Marks a block `processing` for `sourceAssetId`. An `original` left over from an earlier file
 * describes a video the block no longer uses, so it is removed; `original` is set again when the
 * new file is converted.
 */
export function processingOps(
  video: LocatedVideo,
  sourceAssetId: string,
  message: string,
  now: Date,
): PatchOps {
  const staleOriginal =
    video.block.original !== undefined && fileAssetId(video.block.original) !== sourceAssetId
  return {
    set: {
      [blockPath(video.field, video.key, 'conversion')]: conversionValue(
        'processing',
        {message, sourceAssetId},
        now,
      ),
    },
    ...(staleOriginal ? {unset: [blockPath(video.field, video.key, 'original')]} : {}),
  }
}

/** Result of converting (or reusing a conversion of) one upload. */
export type ConversionResult =
  | {
      status: 'ready'
      /** The upload `file` pointed at. Only blocks whose `file` is this asset are patched. */
      fileAssetId: string
      /** `conversion.sourceAssetId`: the original the MP4 was made from. */
      sourceAssetId: string
      outputAssetId: string
      /**
       * What `original` becomes: 'current-file' (the block's own `file` value, the usual case),
       * an asset id, or null to remove it (the original of an adopted MP4 no longer exists).
       */
      original: 'current-file' | {assetId: string} | null
      /** `conversion.settingsVersion`: the settings the MP4 was made with (recorded on its asset). */
      settingsVersion: string
      /**
       * `conversion.originalStripped` and `conversion.stripVersion`: whether `original` is a copy
       * without location and personal metadata (privacy/video-strip.ts), and its version.
       */
      originalStripped: boolean
      stripVersion?: string
      /**
       * The unstripped upload the block's `file` pointed at, deleted once nothing references it
       * (after `original` points at its stripped copy). Undefined when there is nothing to delete.
       */
      deleteUpload?: string
      message: string
    }
  /** The video cannot be converted with these settings; final until the file changes. */
  | {status: 'failed'; fileAssetId: string; message: string}
  /**
   * A problem that is not the video's fault (the converter's setup, a download, an API error):
   * recorded as `pending` and retried by the first event after RETRY_DELAY_SECONDS.
   */
  | {status: 'retry'; fileAssetId: string; message: string}
  /**
   * `file` is an MP4 this converter made with older settings and its original upload still exists:
   * `file` goes back to that original (and `conversion` and `original` are removed), so the next
   * run converts the original with the current settings, under the original's own lease.
   */
  | {status: 'restart'; fileAssetId: string; originalAssetId: string; message: string}

/**
 * Ready: `file` becomes the MP4, `original` the upload's copy without location and personal
 * metadata (or the upload, when it already is such a copy), `conversion` ready. Failed: only
 * `conversion` changes; `file` keeps pointing at the upload.
 */
export function resultOps(video: LocatedVideo, result: ConversionResult, now: Date): PatchOps {
  const path = (child: string) => blockPath(video.field, video.key, child)
  if (result.status === 'failed' || result.status === 'retry') {
    return {
      set: {
        [path('conversion')]: conversionValue(
          result.status === 'failed' ? 'failed' : 'pending',
          {message: result.message, sourceAssetId: result.fileAssetId},
          now,
        ),
      },
    }
  }
  if (result.status === 'restart') {
    return {
      set: {[path('file')]: fileReference(result.originalAssetId)},
      unset: [path('conversion'), path('original')],
    }
  }
  const set: Record<string, unknown> = {
    [path('file')]: fileReference(result.outputAssetId),
    [path('conversion')]: conversionValue(
      'ready',
      {
        message: result.message,
        sourceAssetId: result.sourceAssetId,
        outputAssetId: result.outputAssetId,
        originalStripped: result.originalStripped,
        ...(result.stripVersion === undefined ? {} : {stripVersion: result.stripVersion}),
      },
      now,
      result.settingsVersion,
    ),
  }
  const unset: string[] = []
  if (result.original === 'current-file') {
    if (result.outputAssetId !== result.fileAssetId) set[path('original')] = video.block.file
  } else if (result.original === null) {
    unset.push(path('original'))
  } else {
    set[path('original')] = fileReference(result.original.assetId)
  }
  return {set, ...(unset.length > 0 ? {unset} : {})}
}

/**
 * Whether `result` should be written to this block. A ready or restart result goes to every block
 * whose `file` is still that upload and not yet converted. A failure or retry only goes to the
 * block this run started from and to blocks that are waiting for this run (`processing` for the
 * same upload); other blocks with the same upload get their own run.
 */
export function shouldReceiveResult(
  video: LocatedVideo,
  result: ConversionResult,
  origin: {documentId: string; field: string; key: string},
  documentId: string,
  now: Date,
): boolean {
  if (fileAssetId(video.block.file) !== result.fileAssetId) return false
  if (!needsConversion(video.block)) return false
  if (result.status === 'ready' || result.status === 'restart') return true
  // Already recorded (by this run's first delivery, or another run): writing it again would only
  // cause another update event.
  if (isFailedForCurrentFile(video.block)) return false
  if (result.status === 'retry' && isWaitingToRetry(video.block, now)) return false
  const isOrigin =
    documentId === origin.documentId && video.field === origin.field && video.key === origin.key
  const conversion = video.block.conversion
  const isWaiting =
    conversion?.status === 'processing' && conversion.sourceAssetId === result.fileAssetId
  return isOrigin || isWaiting
}

/** All patch operations that deliver `result` to a document, or null if no block takes it. */
export function documentResultOps(
  doc: SanityDocumentLike,
  result: ConversionResult,
  origin: {documentId: string; field: string; key: string},
  now: Date,
): PatchOps | null {
  return mergeOps(
    videoBlocks(doc)
      .filter((video) => shouldReceiveResult(video, result, origin, doc._id, now))
      .map((video) => resultOps(video, result, now)),
  )
}

/**
 * Blocks in the document that use the upload and still wait for a conversion of it (pending or
 * processing, not failed with the current settings).
 */
export function blocksWaitingFor(doc: SanityDocumentLike, assetId: string): LocatedVideo[] {
  return videoBlocks(doc).filter(
    (video) =>
      fileAssetId(video.block.file) === assetId &&
      needsConversion(video.block) &&
      !isFailedForCurrentFile(video.block),
  )
}

// ---------------------------------------------------------------------------------------------
// Lease on the upload's asset document.

/**
 * Field on the uploaded file's asset document (`sanity.fileAsset`) that records which run is
 * converting it. Taken and released with revision-checked patches, so only one run can hold it.
 * It exists only while a conversion runs.
 */
export const LEASE_FIELD = 'videoToMp4Lease'

export interface Lease {
  holder: string
  documentId: string
  acquiredAt: string
  expiresAt: string
}

/** A lease lasts as long as a `processing` status is considered fresh. */
export const LEASE_SECONDS = STALE_PROCESSING_SECONDS

export function newLease(holder: string, documentId: string, now: Date): Lease {
  return {
    holder,
    documentId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
  }
}

/** Whether `lease` stops `holder` from converting now (held by another run and not expired). */
export function leaseHeldByOther(lease: unknown, holder: string, now: Date): lease is Lease {
  if (typeof lease !== 'object' || lease === null) return false
  const {holder: owner, expiresAt} = lease as Partial<Lease>
  if (typeof owner !== 'string' || owner === holder) return false
  const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN
  // A lease without a readable expiry cannot be checked; treat it as expired so it can never
  // block conversions forever.
  return !Number.isNaN(expires) && expires > now.getTime()
}
