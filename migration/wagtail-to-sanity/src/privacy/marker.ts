/**
 * The `privacy` field on the asset documents of stripped copies, in the shape the image-privacy and
 * video-to-mp4 Functions read (studio/functions/privacy/constants.ts, AssetPrivacy). An asset whose
 * `privacy.status` is `stripped` with the Functions' current version is left alone by them, so the
 * Functions never strip the migration's copies a second time.
 *
 * The values are deterministic (the time is when the local copy was made), so both datasets and
 * every rerun write the same field.
 */
import {
  IMAGE_STRIP_VERSION,
  PRIVACY_FIELD,
  VIDEO_STRIP_VERSION,
  type AssetPrivacy,
} from '../../../../studio/functions/privacy/constants'
import {PRIVACY_RULES_VERSION} from './rules'

export {PRIVACY_FIELD}

export interface StrippedCopyFacts {
  kind: 'image' | 'video'
  /** What was removed (group or box names, never values). */
  removed: readonly string[]
  /** The id the unstripped upload has (or would have) in a dataset: the asset it was made from. */
  strippedFrom: string
  /** When the local copy was made. */
  strippedAt: string
}

export function strippedMarker(copy: StrippedCopyFacts): AssetPrivacy {
  return {
    status: 'stripped',
    version: copy.kind === 'image' ? IMAGE_STRIP_VERSION : VIDEO_STRIP_VERSION,
    message:
      `Stripped by the Wagtail migration's privacy step (rules ${PRIVACY_RULES_VERSION}, ` +
      `${copy.kind === 'image' ? "the image-privacy Function's stripper" : 'in-place ISO BMFF box removal, as in the video-to-mp4 Function'}, no re-encoding).`,
    removed: [...copy.removed],
    strippedFrom: copy.strippedFrom,
    updatedAt: copy.strippedAt,
  }
}

/**
 * The id an asset with other bytes but the same kind, size and extension has: Sanity names assets
 * `image-<sha1>-<width>x<height>-<ext>` and `file-<sha1>-<ext>`, and a stripped copy differs from
 * its upload only in the sha1.
 */
export function assetIdWithSha1(assetId: string, fromSha1: string, toSha1: string): string {
  const match = /^(image|file)-([0-9a-f]{40})-(.+)$/.exec(assetId)
  if (!match || match[2] !== fromSha1) throw new Error(`${assetId} is not an asset id with sha1 ${fromSha1}`)
  return `${match[1]}-${toSha1}-${match[3]}`
}
