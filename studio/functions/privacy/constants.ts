/**
 * Shared names and versions of the privacy stripping (owner decision 2026-11-26: strip location
 * and personal metadata from every asset the public datasets serve, without re-encoding).
 *
 * Used by the image-privacy and video-to-mp4 Functions, the Studio (schema, previews, status
 * inputs) and the tests. Plain TypeScript with no imports and only erasable syntax, so it runs
 * under the Functions bundler, tsx and Node's own type stripping. The contract is in
 * docs/sanity-migration/schema-contract.md, "Privacy".
 */

/**
 * Version of the image stripper (image-strip.ts and the format modules). Stored on every asset it
 * checked (`privacy.version`). Any change to what is removed or kept must change it; assets checked
 * with another version are checked again when a document that uses them changes.
 */
export const IMAGE_STRIP_VERSION = 'image-strip-v1'

/**
 * Version of the video stripper (isobmff-video.ts: in-place removal for QuickTime/MP4, with the
 * ffmpeg stream copy of video-strip.ts for other containers; their settings and checks). Stored on
 * every stripped original (`privacy.version`) and in `video.conversion.stripVersion`.
 * v1: ffmpeg stream copy only. v2: in-place removal (keeps the container byte for byte apart from
 * the metadata), unused mdat bytes zeroed, the stream copy only as a fallback.
 */
export const VIDEO_STRIP_VERSION = 'video-strip-v2'

/**
 * Field on asset documents (`sanity.imageAsset`, `sanity.fileAsset`) that records what the
 * privacy stripping found and did. See AssetPrivacy.
 */
export const PRIVACY_FIELD = 'privacy'

/**
 * `source.name` of a stripped image uploaded by the image-privacy Function (`source.id`: the
 * upload's digest, provenance.ts; never the upload's asset id).
 */
export const IMAGE_PRIVACY_SOURCE_NAME = 'image-privacy'

/**
 * `source.name` of a stripped video original uploaded by the video-to-mp4 Function (`source.id`:
 * the digest of the upload it was made from, provenance.ts; never the upload's asset id).
 */
export const VIDEO_ORIGINAL_SOURCE_NAME = 'video-to-mp4-original'

/**
 * Image formats the Studio accepts, by MIME type. Each one can be stripped losslessly by
 * image-strip.ts. SVG (free-form XML metadata), HEIC/HEIF (Sanity cannot process HEVC images:
 * upload fails with "Support for this compression format has not been built in: HEVC") and BMP
 * (rejected by Sanity) are not accepted.
 */
export const ACCEPTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
] as const

/** `options.accept` of every image field. */
export const IMAGE_ACCEPT = ACCEPTED_IMAGE_MIME_TYPES.join(',')

/**
 * `options.metadata` of every image field and `extract` of every upload by the Functions: the
 * placeholders and the palette, never `exif`, `image` (camera make and model) or `location`.
 * These are Sanity's defaults, set explicitly so a schema change cannot add location by accident.
 */
export const IMAGE_METADATA_OPTIONS = ['blurhash', 'thumbhash', 'lqip', 'palette'] as const

export const ASSET_PRIVACY_STATUSES = [
  'processing',
  'pending',
  'failed',
  'clean',
  'stripped',
  'replaced',
] as const

/**
 * - `processing`: a run is checking or stripping this upload (also the lease: `holder`, `expiresAt`).
 * - `pending`: the last attempt hit a problem that is not the file's fault; retried after
 *   RETRY_DELAY_SECONDS on the next event.
 * - `failed`: the file cannot be stripped with this `version` (unsupported or corrupt, too large, a
 *   check that fails); final until the version changes. Never kept once unused: video-to-mp4 takes
 *   a failed video upload out of its blocks and deletes it, the Studio shows an error on a failed
 *   image (the file is public while a document uses it), and upload-privacy deletes unused ones.
 * - `clean`: checked, no personal metadata; the asset is left as it is.
 * - `stripped`: a copy without personal metadata made by a Function or the migration
 *   (`strippedFromDigest`: the upload's digest, provenance.ts).
 * - `replaced`: an upload with personal metadata whose stripped copy is `replacementAssetId`; every
 *   reference is moved to the copy and this asset is deleted once nothing references it.
 */
export type AssetPrivacyStatus = (typeof ASSET_PRIVACY_STATUSES)[number]

export interface AssetPrivacy {
  status?: AssetPrivacyStatus | string
  /** IMAGE_STRIP_VERSION or VIDEO_STRIP_VERSION of the check. */
  version?: string
  message?: string
  /** What was (or would be) removed, e.g. "EXIF GPS", "XMP". */
  removed?: string[]
  /**
   * On `stripped`: the keyed digest of the asset `_id` of the upload it was made from
   * (provenance.ts, `hmac-sha256:<hex>`). Never the id itself: an id names the deleted upload's
   * URL, which the asset CDN may still serve. Absent when the copy was made without the key.
   */
  strippedFromDigest?: string
  /** On `replaced`: the asset `_id` of the stripped copy. */
  replacementAssetId?: string
  /** On `processing`: the run that holds the lease and when the lease ends. */
  holder?: string
  expiresAt?: string
  updatedAt?: string
}
