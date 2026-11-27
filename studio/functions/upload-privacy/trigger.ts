/**
 * When the upload-privacy Function runs, and which uploads it looks at.
 *
 * The image-privacy and video-to-mp4 Functions strip an upload when a document uses it, because
 * they start from content documents' events. An upload no document uses was never stripped or
 * deleted (privacy review: an abandoned upload, a video removed from its block before the
 * conversion, a draft or release discarded before the Function ran, an upload by an API client).
 * This Function closes that gap:
 *
 * - On the `create` of an image or file asset uploaded since UPLOADED_SINCE that no Function or the
 *   migration made: it removes any location or EXIF data Sanity extracted into the public asset
 *   document at once (an API client can ask for it), waits up to GRACE_SECONDS for a document to
 *   use the upload (the Studio sets the reference right after the upload; then the content
 *   Functions handle it), and strips an upload that is still unused: a copy without location and
 *   personal metadata is made and the upload deleted.
 * - On every event (each upload, and the `delete` of any draft, published document or release
 *   version: a publish, a discarded draft, an archived or published release), it sweeps up to
 *   SWEEP_LIMIT earlier uploads that no document uses and that still have their metadata (never
 *   checked, or `replaced` by a copy but not deleted, or a due retry): the same handling.
 *
 * There is no scheduled sweep: scheduled Functions need the Blueprint stack promoted to the
 * organization (one-way) and a robot token, which is the owner's call. Until then a leftover is
 * handled at the next upload or deletion in its dataset.
 */
import {
  IMAGE_PRIVACY_SOURCE_NAME,
  IMAGE_STRIP_VERSION,
  PRIVACY_FIELD,
  VIDEO_ORIGINAL_SOURCE_NAME,
  VIDEO_STRIP_VERSION,
} from '../privacy/constants'
import {IMAGE_DOCUMENT_TYPES, UPLOADED_SINCE} from '../image-privacy/trigger'
import {CONVERTED_ASSET_SOURCE_NAME} from '../video-to-mp4/settings'
import {VIDEO_DOCUMENT_TYPES} from '../video-to-mp4/trigger'

export {UPLOADED_SINCE}

/** Datasets the Function works in. */
export const UPLOAD_PRIVACY_DATASETS = ['production', 'staging'] as const

/** Blueprint `timeout` of the Function, in seconds (the maximum). */
export const FUNCTION_TIMEOUT_SECONDS = 900

/**
 * How long a new upload has to get its first reference before it counts as unused. The Studio
 * patches the reference in right after the upload response; a minute is far more than that.
 */
export const GRACE_SECONDS = 60

/** How often the wait looks at the upload again. */
export const POLL_SECONDS = 5

/** Earlier unused uploads handled per run, besides the event's own. */
export const SWEEP_LIMIT = 5

/** A `processing` mark older than this belongs to a run that can no longer be alive (any Function). */
export const STALE_PROCESSING_SECONDS = FUNCTION_TIMEOUT_SECONDS + 5 * 60

/** A `pending` mark (a retryable problem) is retried by a sweep this long after it. */
export const RETRY_DELAY_SECONDS = 10 * 60

/**
 * `source.name` of assets this Function never touches: the migration's uploads (it strips them
 * itself) and the copies and MP4s the Functions make.
 */
export const OWN_SOURCE_NAMES = ['wagtail', IMAGE_PRIVACY_SOURCE_NAME, VIDEO_ORIGINAL_SOURCE_NAME, CONVERTED_ASSET_SOURCE_NAME] as const

/** Content documents whose deletion can leave an upload unused. */
export const CONTENT_DOCUMENT_TYPES = [...new Set<string>([...IMAGE_DOCUMENT_TYPES, ...VIDEO_DOCUMENT_TYPES])].sort()

const groqList = (values: readonly string[]) => `[${values.map((v) => JSON.stringify(v)).join(', ')}]`

/** GROQ filter body (delta mode) for the Function's create and delete events. */
export const UPLOAD_PRIVACY_FILTER = [
  `sanity::dataset() in ${groqList(UPLOAD_PRIVACY_DATASETS)}`,
  '(' +
    [
      '(delta::operation() == "create"' +
        ' && after()._type in ["sanity.imageAsset", "sanity.fileAsset"]' +
        ` && dateTime(after()._createdAt) >= dateTime(${JSON.stringify(UPLOADED_SINCE)})` +
        ` && !defined(after().${PRIVACY_FIELD})` +
        ` && !(after().source.name in ${groqList(OWN_SOURCE_NAMES)}))`,
      `(delta::operation() == "delete" && before()._type in ${groqList(CONTENT_DOCUMENT_TYPES)})`,
    ].join(' || ') +
    ')',
].join(' && ')

/** What the handler gets: which operation, on which document. */
export const UPLOAD_PRIVACY_PROJECTION =
  '{"operation": delta::operation(), "id": coalesce(after()._id, before()._id), "type": coalesce(after()._type, before()._type)}'

export interface UploadEventData {
  operation: string
  id: string
  type: string
}

export function isAssetType(type: unknown): type is 'sanity.imageAsset' | 'sanity.fileAsset' {
  return type === 'sanity.imageAsset' || type === 'sanity.fileAsset'
}

/**
 * GROQ query for the sweep: uploads since UPLOADED_SINCE, older than the grace period, not made by
 * the migration or a Function, images or videos (image assets, and file assets of either kind),
 * used by no document, and still with their
 * metadata: never checked, `replaced` but not deleted, `failed` (its location data could not be
 * removed, so it is deleted; privacy review round 2, finding 2), a due retry, a stale `processing`
 * mark, or checked by an older stripper. Params: $since, $grace, $retry, $stale, $own, $exclude,
 * $imageVersion, $videoVersion (a slice takes constant numbers only, so SWEEP_LIMIT is written in).
 */
export const SWEEP_QUERY = `*[
  _type in ["sanity.imageAsset", "sanity.fileAsset"]
  && dateTime(_createdAt) >= dateTime($since)
  && dateTime(_createdAt) < dateTime(now()) - $grace
  && !(source.name in $own)
  && (_type == "sanity.imageAsset" || string::startsWith(coalesce(mimeType, ""), "video/") || string::startsWith(coalesce(mimeType, ""), "image/"))
  && !(_id in $exclude)
  && (
    !defined(${PRIVACY_FIELD})
    || ${PRIVACY_FIELD}.status == "replaced"
    || ${PRIVACY_FIELD}.status == "failed"
    || (${PRIVACY_FIELD}.status == "pending" && coalesce(dateTime(${PRIVACY_FIELD}.updatedAt) < dateTime(now()) - $retry, true))
    || (${PRIVACY_FIELD}.status == "processing" && coalesce(dateTime(${PRIVACY_FIELD}.updatedAt) < dateTime(now()) - $stale, true))
    || (_type == "sanity.imageAsset" && ${PRIVACY_FIELD}.status in ["clean", "stripped"] && ${PRIVACY_FIELD}.version != $imageVersion)
    || (_type == "sanity.fileAsset" && string::startsWith(coalesce(mimeType, ""), "video/") && ${PRIVACY_FIELD}.status in ["clean", "stripped"] && ${PRIVACY_FIELD}.version != $videoVersion)
    || (_type == "sanity.fileAsset" && string::startsWith(coalesce(mimeType, ""), "image/") && ${PRIVACY_FIELD}.status in ["clean", "stripped"] && ${PRIVACY_FIELD}.version != $imageVersion)
  )
  && count(*[references(^._id)]) == 0
] | order(_createdAt asc)[0...${SWEEP_LIMIT}]._id`

export function sweepParams(exclude: readonly string[]): Record<string, unknown> {
  return {
    since: UPLOADED_SINCE,
    grace: GRACE_SECONDS,
    retry: RETRY_DELAY_SECONDS,
    stale: STALE_PROCESSING_SECONDS,
    own: [...OWN_SOURCE_NAMES],
    exclude: [...exclude],
    imageVersion: IMAGE_STRIP_VERSION,
    videoVersion: VIDEO_STRIP_VERSION,
  }
}
