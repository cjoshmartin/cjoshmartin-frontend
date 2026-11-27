/**
 * Privacy of uploaded images in the Studio (owner decision 2026-11-26; contract in
 * docs/sanity-migration/schema-contract.md, "Privacy"): every image field accepts only the formats
 * the image-privacy Function can strip losslessly, never asks Sanity to extract EXIF, camera or
 * location data into the asset document, and shows what the Function found.
 * Pure helpers (only a type import and the plain constants module), so tests and validation can use
 * them without the Studio.
 */
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  IMAGE_ACCEPT,
  IMAGE_METADATA_OPTIONS,
  IMAGE_STRIP_VERSION,
  type AssetPrivacy,
} from '../../functions/privacy/constants'

/** `options` of every image field and type: hotspot, the accepted formats, no EXIF or location. */
export const PRIVATE_IMAGE_OPTIONS = {
  hotspot: true,
  accept: IMAGE_ACCEPT,
  metadata: [...IMAGE_METADATA_OPTIONS],
}

const FORMAT_NAMES = 'JPEG, PNG, WebP, GIF, AVIF or TIFF'

/** Error for an asset whose format the Function cannot strip (SVG, HEIC, ...), or null. */
export function imageFormatProblem(mimeType: string | undefined): string | null {
  if (mimeType && (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return null
  return `This image's format (${mimeType || 'unknown'}) cannot be used: its location and camera data cannot be removed without changing the image. Upload it as ${FORMAT_NAMES}.`
}

export type ImagePrivacyState =
  | {kind: 'unchecked'}
  | {kind: 'processing'}
  | {kind: 'clean'}
  | {kind: 'stripped'}
  | {kind: 'replaced'}
  | {kind: 'pending'; message: string}
  | {kind: 'failed'; message: string}

/** Where the image-privacy Function stands with an asset (its `privacy` field). */
export function imagePrivacyState(privacy: AssetPrivacy | undefined | null): ImagePrivacyState {
  const message = privacy?.message?.trim() || 'no message was recorded'
  switch (privacy?.status) {
    case 'processing':
      return {kind: 'processing'}
    case 'replaced':
      return {kind: 'replaced'}
    case 'pending':
      return {kind: 'pending', message}
    case 'clean':
      return privacy.version === IMAGE_STRIP_VERSION ? {kind: 'clean'} : {kind: 'unchecked'}
    case 'stripped':
      return {kind: 'stripped'}
    case 'failed':
      // A failure under another stripper version is checked again on the next change.
      return privacy.version === IMAGE_STRIP_VERSION ? {kind: 'failed', message} : {kind: 'unchecked'}
    default:
      return {kind: 'unchecked'}
  }
}

/**
 * The validation error for an image whose location and camera data the Function cannot remove
 * (null otherwise). An error, so the document cannot be published with it: the uploaded file is
 * public with that data for as long as a document uses it (the plain CDN URL even serves some
 * files, GIFs for example, exactly as stored). Once no document uses it, the upload-privacy
 * Function deletes it.
 */
export function imagePrivacyError(state: ImagePrivacyState): string | null {
  if (state.kind !== 'failed') return null
  return `Location and camera data could not be removed from this image: ${state.message} The uploaded file stays public, with that data, for as long as a document uses it. Replace it with another file (${FORMAT_NAMES}); the unused upload is then deleted.`
}

/**
 * The validation warning for an image whose metadata could not be removed yet (null when there is
 * nothing to warn about). Not an error: the Function retries or finishes it, also in published
 * documents.
 */
export function imagePrivacyWarning(state: ImagePrivacyState): string | null {
  switch (state.kind) {
    case 'pending':
      return `Removing location and camera data from this image is waiting to be retried: ${state.message}`
    case 'replaced':
      return 'This document still uses the upload with location data; it is switched to the copy without it automatically.'
    default:
      return null
  }
}

/** One-line status under the image input, or null for none. */
export function imagePrivacyLabel(
  state: ImagePrivacyState,
  recentlyUploaded: boolean,
): {tone: 'default' | 'primary' | 'positive' | 'caution' | 'critical'; text: string} | null {
  switch (state.kind) {
    case 'unchecked':
      return recentlyUploaded ? {tone: 'primary', text: 'Checking this image for location and camera data...'} : null
    case 'processing':
      return {tone: 'primary', text: 'Removing location and camera data from this image...'}
    case 'replaced':
      return {tone: 'caution', text: 'Switching to the copy without location and camera data...'}
    case 'stripped':
      return {tone: 'positive', text: 'Location and camera data removed. The pixels, orientation and colour profile are unchanged.'}
    case 'clean':
      return null
    case 'pending':
      return {tone: 'caution', text: imagePrivacyWarning(state) as string}
    case 'failed':
      return {tone: 'critical', text: imagePrivacyError(state) as string}
  }
}
