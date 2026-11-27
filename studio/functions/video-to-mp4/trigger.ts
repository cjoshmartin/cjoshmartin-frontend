/**
 * When the video-to-mp4 Function runs, and which video block it works on.
 *
 * The filter and projection are used by ../../sanity.blueprint.ts. The same rule is applied again
 * in code (findPendingVideos / nextPendingVideo), so the handler never relies on the event filter
 * alone. test/trigger.test.ts evaluates the filter with groq-js against the same cases.
 *
 * Video contract v2 (docs/sanity-migration/schema-contract.md, "Videos"): a `video` block NEEDS
 * CONVERSION when `file.asset._ref` is set and differs from `conversion.outputAssetId`. The
 * Function works on a block that needs conversion unless it is already being handled:
 * - `processing` for the current file, written less than STALE_PROCESSING_SECONDS ago (a
 *   conversion is running; an older one belongs to a run that died and is retried), or
 * - `pending` for the current file, written less than RETRY_DELAY_SECONDS ago: the last attempt
 *   hit a problem that was not the video's fault (the converter's setup, a download, an API
 *   error) and is retried by the first event after the delay, or
 * - `failed` for the current file with the current SETTINGS_VERSION: the video itself cannot be
 *   converted with these settings (retrying would fail the same way, and the failure patch itself
 *   must not trigger another run). Uploading another file, or removing the block and adding the
 *   video again, starts a new conversion.
 *
 * Nothing sends an event by itself when a `processing` or `pending` mark goes stale, or when
 * SETTINGS_VERSION changes after a failure. The Studio does: while the document's form is open, it
 * checks every minute and touches such a block, at most once per RETRY_DELAY_SECONDS (see
 * studio/components/VideoConversionWatcher.tsx, the form's root input), which starts the retry.
 *
 * Recursion guard: every patch the Function writes leaves each block it touches either converted
 * (`file` is the MP4), `processing` or freshly `pending` for the current file, `failed` for the
 * current file, or pointing at another file that does need conversion (an old conversion swapped
 * back to its original upload, which is converted by the next run), so the update event caused by
 * a patch matches a block at most once more.
 */
import {SETTINGS_VERSION} from './settings'

/** Datasets the Function converts videos in. */
export const VIDEO_TO_MP4_DATASETS = ['production', 'staging'] as const

/** Blueprint `timeout` of the Function, in seconds (the maximum Sanity Functions allow). */
export const FUNCTION_TIMEOUT_SECONDS = 900

/**
 * A `processing` status older than this belongs to a run that can no longer be alive (the
 * Function timeout plus 5 minutes for event delivery and clock skew), so the block is retried.
 */
export const STALE_PROCESSING_SECONDS = FUNCTION_TIMEOUT_SECONDS + 5 * 60

/**
 * A `pending` status (a retryable problem) is retried by the first event at least this long after
 * it was written. Long enough that the Function's own pending patch and quick re-saves do not
 * retry it in a loop, short enough that a redeploy or a passing network problem is retried soon.
 */
export const RETRY_DELAY_SECONDS = 10 * 60

/** Ends the message of a `pending` (retryable) status, so the editor knows nothing is needed. */
export const RETRY_NOTE = `It is retried automatically, ${RETRY_DELAY_SECONDS / 60} minutes after this attempt or later: on the next change to the document, or while the document is open in the Studio.`

/**
 * Every Portable Text field (type `blockContent`, which offers the `video` block) per document
 * type, from studio/schemaTypes/documents. A video can be added to any of them, and every upload
 * is converted, so all of them are watched.
 */
export const VIDEO_FIELDS_BY_TYPE = {
  blogPost: ['body'],
  project: ['body'],
  flexPage: ['body'],
  testimonial: ['body'],
  homePage: ['bio'],
  person: ['bio'],
  service: ['description'],
} as const satisfies Record<string, readonly string[]>

export type VideoDocumentType = keyof typeof VIDEO_FIELDS_BY_TYPE

export const VIDEO_DOCUMENT_TYPES = Object.keys(VIDEO_FIELDS_BY_TYPE) as VideoDocumentType[]

export function isVideoDocumentType(type: unknown): type is VideoDocumentType {
  return typeof type === 'string' && Object.hasOwn(VIDEO_FIELDS_BY_TYPE, type)
}

/** The document types that have the given field. */
function typesByField(): Map<string, VideoDocumentType[]> {
  const result = new Map<string, VideoDocumentType[]>()
  for (const type of VIDEO_DOCUMENT_TYPES) {
    for (const field of VIDEO_FIELDS_BY_TYPE[type]) {
      result.set(field, [...(result.get(field) ?? []), type])
    }
  }
  return result
}

const groqList = (values: readonly string[]) =>
  `[${values.map((v) => JSON.stringify(v)).join(', ')}]`

/**
 * GROQ predicate for one array member (`@`) that the Function should work on. Mirrors
 * isPendingVideo below.
 */
export const PENDING_VIDEO_PREDICATE = [
  '_type == "video"',
  'defined(file.asset._ref)',
  'file.asset._ref != conversion.outputAssetId',
  '!(conversion.sourceAssetId == file.asset._ref && (' +
    `(conversion.status == "failed" && conversion.settingsVersion == ${JSON.stringify(SETTINGS_VERSION)})` +
    ' || ' +
    `(conversion.status == "processing" && coalesce(dateTime(conversion.updatedAt) > dateTime(now()) - ${STALE_PROCESSING_SECONDS}, false))` +
    ' || ' +
    `(conversion.status == "pending" && coalesce(dateTime(conversion.updatedAt) > dateTime(now()) - ${RETRY_DELAY_SECONDS}, false))` +
    '))',
].join(' && ')

/** `(type matches && count(field[pending]) > 0) || ...` for every field. */
function pendingInAnyField(): string {
  return [...typesByField()]
    .map(([field, types]) => {
      const typeCheck =
        types.length === 1 ? `_type == ${JSON.stringify(types[0])}` : `_type in ${groqList(types)}`
      return `(${typeCheck} && count(${field}[${PENDING_VIDEO_PREDICATE}]) > 0)`
    })
    .join(' || ')
}

/**
 * GROQ filter body (no `*[...]`) for the Function's create and update events: a document of a
 * watched type, in production or staging, with at least one video block to work on.
 */
export const VIDEO_TO_MP4_FILTER = [
  `_type in ${groqList(VIDEO_DOCUMENT_TYPES)}`,
  `sanity::dataset() in ${groqList(VIDEO_TO_MP4_DATASETS)}`,
  `(${pendingInAnyField()})`,
].join(' && ')

/**
 * Projection for event.data. The handler always reads the current document itself (it needs the
 * latest revision for its conditional patches), so the event only names the document.
 */
export const VIDEO_TO_MP4_PROJECTION = '{_id, _type, _rev}'

/** Shape of event.data produced by VIDEO_TO_MP4_PROJECTION. */
export interface VideoEventData {
  _id: string
  _type: string
  _rev: string
}

// ---------------------------------------------------------------------------------------------
// The same rule in TypeScript.

export type ConversionStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface ConversionValue {
  status?: string
  message?: string
  sourceAssetId?: string
  outputAssetId?: string
  settingsVersion?: string
  /** True when `original` is a copy of the upload without location and personal metadata. */
  originalStripped?: boolean
  /** VIDEO_STRIP_VERSION of that copy. */
  stripVersion?: string
  updatedAt?: string
}

export interface FileValue {
  _type?: string
  asset?: {_type?: string; _ref?: string}
  [key: string]: unknown
}

export interface VideoBlock {
  _type: 'video'
  _key: string
  file?: FileValue
  original?: FileValue
  conversion?: ConversionValue
}

/** A video block and where it lives in its document. */
export interface LocatedVideo {
  field: string
  key: string
  block: VideoBlock
}

export type SanityDocumentLike = {_id: string; _type: string; _rev?: string} & Record<
  string,
  unknown
>

export function isVideoBlock(value: unknown): value is VideoBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as {_type?: unknown})._type === 'video' &&
    typeof (value as {_key?: unknown})._key === 'string' &&
    (value as {_key: string})._key !== ''
  )
}

export function fileAssetId(file: FileValue | undefined): string | undefined {
  const ref = file?.asset?._ref
  return typeof ref === 'string' && ref !== '' ? ref : undefined
}

/** The contract's rule (same as videoNeedsConversion in studio/schemaTypes/shared/video-conversion.ts). */
export function needsConversion(block: Pick<VideoBlock, 'file' | 'conversion'>): boolean {
  const current = fileAssetId(block.file)
  return current !== undefined && current !== block.conversion?.outputAssetId
}

/**
 * Whether `conversion.updatedAt` is a valid time less than `maxAgeSeconds` (by default
 * STALE_PROCESSING_SECONDS) before `now`.
 */
export function isFreshTimestamp(
  updatedAt: string | undefined,
  now: Date,
  maxAgeSeconds: number = STALE_PROCESSING_SECONDS,
): boolean {
  if (typeof updatedAt !== 'string') return false
  const time = Date.parse(updatedAt)
  if (Number.isNaN(time)) return false
  return time > now.getTime() - maxAgeSeconds * 1000
}

/** A conversion of the block's current file is running (processing, not stale). */
export function isFreshProcessing(
  block: Pick<VideoBlock, 'file' | 'conversion'>,
  now: Date,
): boolean {
  const current = fileAssetId(block.file)
  const conversion = block.conversion
  return (
    current !== undefined &&
    conversion?.sourceAssetId === current &&
    conversion.status === 'processing' &&
    isFreshTimestamp(conversion.updatedAt, now)
  )
}

/**
 * The last attempt for the current file hit a retryable problem less than RETRY_DELAY_SECONDS ago
 * (`pending` written by the Function), so the block waits before it is tried again.
 */
export function isWaitingToRetry(
  block: Pick<VideoBlock, 'file' | 'conversion'>,
  now: Date,
): boolean {
  const current = fileAssetId(block.file)
  const conversion = block.conversion
  return (
    current !== undefined &&
    conversion?.sourceAssetId === current &&
    conversion.status === 'pending' &&
    isFreshTimestamp(conversion.updatedAt, now, RETRY_DELAY_SECONDS)
  )
}

/** The current file failed to convert with the current settings. */
export function isFailedForCurrentFile(block: Pick<VideoBlock, 'file' | 'conversion'>): boolean {
  const current = fileAssetId(block.file)
  const conversion = block.conversion
  return (
    current !== undefined &&
    conversion?.sourceAssetId === current &&
    conversion.status === 'failed' &&
    conversion.settingsVersion === SETTINGS_VERSION
  )
}

/** Mirrors PENDING_VIDEO_PREDICATE: the Function should work on this block. */
export function isPendingVideo(block: VideoBlock, now: Date): boolean {
  return (
    needsConversion(block) &&
    !isFreshProcessing(block, now) &&
    !isWaitingToRetry(block, now) &&
    !isFailedForCurrentFile(block)
  )
}

/** Every video block of the document's watched fields, in document order. */
export function videoBlocks(doc: SanityDocumentLike): LocatedVideo[] {
  if (!isVideoDocumentType(doc._type)) return []
  const result: LocatedVideo[] = []
  for (const field of VIDEO_FIELDS_BY_TYPE[doc._type]) {
    const value = doc[field]
    if (!Array.isArray(value)) continue
    for (const member of value) {
      if (isVideoBlock(member)) result.push({field, key: member._key, block: member})
    }
  }
  return result
}

/** The blocks the Function should work on, in document order. */
export function findPendingVideos(doc: SanityDocumentLike, now: Date): LocatedVideo[] {
  return videoBlocks(doc).filter((video) => isPendingVideo(video.block, now))
}

/** One block per invocation: the first pending one. The next event handles the next block. */
export function nextPendingVideo(doc: SanityDocumentLike, now: Date): LocatedVideo | undefined {
  return findPendingVideos(doc, now)[0]
}

/** Document ids of release versions (`versions.<release>.<id>`). */
export function isVersionId(id: string): boolean {
  return id.startsWith('versions.')
}

/**
 * GROQ query (perspective raw) for every draft, published and release-version document in which
 * some video block has `file` = $assetId. Used to hand one conversion's result to every block that
 * uses the same upload, e.g. the published document after the draft was published mid-conversion,
 * or a version of the document in a release.
 */
export function documentsUsingFileQuery(): string {
  const fieldChecks = [...typesByField()]
    .map(([field, types]) => {
      const typeCheck =
        types.length === 1 ? `_type == ${JSON.stringify(types[0])}` : `_type in ${groqList(types)}`
      return `(${typeCheck} && count(${field}[_type == "video" && file.asset._ref == $assetId]) > 0)`
    })
    .join(' || ')
  return `*[_type in ${groqList(VIDEO_DOCUMENT_TYPES)} && (${fieldChecks})] | order(_id asc)._id`
}
