/**
 * When the image-privacy Function runs, and which images it works on.
 *
 * The trigger is the content documents, not the asset documents. A Studio upload creates the asset
 * document first and patches the reference into the draft a moment later; a run started by the
 * asset could find no reference yet, and deleting an asset the Studio is about to reference makes
 * the Studio's patch fail. When a content document's event arrives, the reference already exists.
 *
 * The state lives on the image's asset document, in `privacy` (privacy/constants.ts, AssetPrivacy):
 * `clean` (checked, nothing personal, left as it is), `stripped` (a copy made by this Function or
 * the video one), `replaced` (an upload whose stripped copy is `replacementAssetId`), `processing`
 * (also the lease), `pending` (retried later) or `failed`. The event filter follows each image
 * reference to its asset (`asset->`, which deployed Function filters support) and matches a
 * document with at least one image whose asset still needs work:
 * - no `privacy` (never checked) or a `privacy.version` other than IMAGE_STRIP_VERSION, or
 * - `replaced` (a document still references the unstripped upload, e.g. a draft published while
 *   it was being stripped), or
 * - `processing` older than STALE_PROCESSING_SECONDS (a run that died), or
 * - `pending` older than RETRY_DELAY_SECONDS (a retry that is due).
 * `clean`, `stripped` and `failed` with the current version do not match.
 *
 * Only images uploaded since UPLOADED_SINCE are the Function's: the Wagtail migration's images were
 * all uploaded before it, and the migration's privacy step strips them (and marks its copies
 * `stripped`), so the Function never races that step over the same asset.
 *
 * Recursion guard: a run marks the stripped copy `stripped` before it points any reference at it,
 * and marks every checked upload `clean`, `replaced` or `failed`, so the update events caused by its
 * own patches match no image again. Marks on asset documents are not content documents' events.
 */
import {IMAGE_STRIP_VERSION, PRIVACY_FIELD, type AssetPrivacy} from '../privacy/constants'

/** Datasets the Function works in. */
export const IMAGE_PRIVACY_DATASETS = ['production', 'staging'] as const

/** Blueprint `timeout` of the Function, in seconds. */
export const FUNCTION_TIMEOUT_SECONDS = 300

/**
 * Images uploaded at or after this time are checked by the Function. Every image of the Wagtail
 * migration was uploaded before it (2026-11-25); those are handled by the migration's privacy step
 * (migration/wagtail-to-sanity, `privacy`).
 *
 * Since the datasets were recreated from exports (2026-11-26), every asset's `_createdAt` is its
 * import time: the asset service sets it at the upload, and it cannot be patched. So this date no
 * longer tells the migration's images from new ones. A `privacy` mark with the current version
 * does: the migration's copies are `stripped`, and its other images were checked with this
 * Function's stripper and marked `clean` (`npm run recreate -- mark-unchecked-images`; recreate fix
 * round 1, finding 2), so the filter matches none of them.
 */
export const UPLOADED_SINCE = '2026-11-26T00:00:00Z'

/** A `processing` mark older than this belongs to a run that can no longer be alive. */
export const STALE_PROCESSING_SECONDS = FUNCTION_TIMEOUT_SECONDS + 5 * 60

/** A `pending` mark (a retryable problem) is retried by the first event this long after it. */
export const RETRY_DELAY_SECONDS = 10 * 60

/**
 * The fields of every watched document type that can hold an image (directly or as a Portable Text
 * image block), from studio/schemaTypes/documents. A test compares them with the schema.
 */
export const IMAGE_FIELDS_BY_TYPE = {
  blogPost: ['heroMedia', 'contentImage', 'body'],
  project: ['heroMedia', 'contentImage', 'previewImage', 'body'],
  flexPage: ['body'],
  testimonial: ['image', 'body'],
  homePage: ['bio'],
  person: ['image', 'bio'],
  service: ['image', 'description'],
} as const satisfies Record<string, readonly string[]>

export type ImageDocumentType = keyof typeof IMAGE_FIELDS_BY_TYPE

export const IMAGE_DOCUMENT_TYPES = Object.keys(IMAGE_FIELDS_BY_TYPE) as ImageDocumentType[]

export function isImageDocumentType(type: unknown): type is ImageDocumentType {
  return typeof type === 'string' && Object.hasOwn(IMAGE_FIELDS_BY_TYPE, type)
}

const ALL_FIELDS = [...new Set(Object.values(IMAGE_FIELDS_BY_TYPE).flat())]
/** Fields that hold arrays (image arrays and Portable Text); the others hold one image. */
const ARRAY_FIELDS = new Set(['heroMedia', 'body', 'bio', 'description'])

const groqList = (values: readonly string[]) => `[${values.map((v) => JSON.stringify(v)).join(', ')}]`

/**
 * GROQ predicate for one image value (`@`) whose asset still needs work. Mirrors
 * assetNeedsWork below.
 */
export const IMAGE_NEEDS_WORK_PREDICATE = [
  'defined(asset._ref)',
  'asset->_type == "sanity.imageAsset"',
  `dateTime(asset->_createdAt) >= dateTime(${JSON.stringify(UPLOADED_SINCE)})`,
  '!(' +
    `(asset->${PRIVACY_FIELD}.version == ${JSON.stringify(IMAGE_STRIP_VERSION)} && asset->${PRIVACY_FIELD}.status in ["clean", "stripped", "failed"])` +
    ' || ' +
    `(asset->${PRIVACY_FIELD}.status == "processing" && coalesce(dateTime(asset->${PRIVACY_FIELD}.updatedAt) > dateTime(now()) - ${STALE_PROCESSING_SECONDS}, false))` +
    ' || ' +
    `(asset->${PRIVACY_FIELD}.status == "pending" && coalesce(dateTime(asset->${PRIVACY_FIELD}.updatedAt) > dateTime(now()) - ${RETRY_DELAY_SECONDS}, false))` +
    ')',
].join(' && ')

/** Every image value of the watched fields (single images and array members), as one array. */
const IMAGE_VALUES = [
  `[${ALL_FIELDS.filter((f) => !ARRAY_FIELDS.has(f)).join(', ')}]`,
  ...ALL_FIELDS.filter((f) => ARRAY_FIELDS.has(f)).map((f) => `coalesce(${f}, [])`),
].join(' + ')

/** GROQ filter body for the Function's create and update events. */
export const IMAGE_PRIVACY_FILTER = [
  `_type in ${groqList(IMAGE_DOCUMENT_TYPES)}`,
  `sanity::dataset() in ${groqList(IMAGE_PRIVACY_DATASETS)}`,
  `count((${IMAGE_VALUES})[${IMAGE_NEEDS_WORK_PREDICATE}]) > 0`,
].join(' && ')

/** The handler reads the document itself (it needs the latest revision), so the event only names it. */
export const IMAGE_PRIVACY_PROJECTION = '{_id, _type, _rev}'

export interface ImageEventData {
  _id: string
  _type: string
  _rev: string
}

// ---------------------------------------------------------------------------------------------
// The same rule in TypeScript.

export interface ImageAssetDocument {
  _id: string
  _type: string
  _rev: string
  _createdAt?: string
  url?: string
  size?: number
  mimeType?: string
  originalFilename?: string
  sha1hash?: string
  extension?: string
  metadata?: {dimensions?: {width?: number; height?: number}; location?: unknown; exif?: unknown; image?: unknown}
  source?: {name?: string; id?: string}
  [PRIVACY_FIELD]?: AssetPrivacy
}

function isFresh(time: string | undefined, now: Date, maxAgeSeconds: number): boolean {
  const parsed = typeof time === 'string' ? Date.parse(time) : Number.NaN
  return !Number.isNaN(parsed) && parsed > now.getTime() - maxAgeSeconds * 1000
}

/** Mirrors IMAGE_NEEDS_WORK_PREDICATE for one asset document. */
export function assetNeedsWork(asset: ImageAssetDocument | null | undefined, now: Date): boolean {
  if (!asset || asset._type !== 'sanity.imageAsset') return false
  const created = typeof asset._createdAt === 'string' ? Date.parse(asset._createdAt) : Number.NaN
  if (Number.isNaN(created) || created < Date.parse(UPLOADED_SINCE)) return false
  const privacy = asset[PRIVACY_FIELD]
  if (privacy?.version === IMAGE_STRIP_VERSION && ['clean', 'stripped', 'failed'].includes(privacy.status ?? '')) {
    return false
  }
  if (privacy?.status === 'processing' && isFresh(privacy.updatedAt, now, STALE_PROCESSING_SECONDS)) return false
  if (privacy?.status === 'pending' && isFresh(privacy.updatedAt, now, RETRY_DELAY_SECONDS)) return false
  return true
}

/** Whether the asset is a stripped copy made with the current image stripper. */
export function isStrippedImage(asset: ImageAssetDocument | null | undefined): boolean {
  const privacy = asset?.[PRIVACY_FIELD]
  return asset?._type === 'sanity.imageAsset' && privacy?.status === 'stripped' && privacy.version === IMAGE_STRIP_VERSION
}

/** Image asset ids referenced by the watched fields of a document, in document order, once each. */
export function imageAssetIds(doc: Record<string, unknown> & {_type: string}): string[] {
  if (!isImageDocumentType(doc._type)) return []
  const ids: string[] = []
  const add = (value: unknown) => {
    const ref = (value as {asset?: {_ref?: unknown}} | null)?.asset?._ref
    if (typeof ref === 'string' && ref.startsWith('image-') && !ids.includes(ref)) ids.push(ref)
  }
  for (const field of IMAGE_FIELDS_BY_TYPE[doc._type]) {
    const value = doc[field]
    if (Array.isArray(value)) value.forEach(add)
    else add(value)
  }
  return ids
}

/**
 * The `set` that moves a document from asset `from` to asset `to`: every reference
 * (referencePaths) and the testimonial's `asciiArtSource` (the asset its ASCII art was made from,
 * a plain id). Moving both in one patch keeps the testimonial-ascii-art Function from making the
 * art again from the same pixels. Empty when the document does not use `from`.
 */
export function repointSet(doc: Record<string, unknown>, from: string, to: string): Record<string, string> {
  const set: Record<string, string> = Object.fromEntries(referencePaths(doc, from).map((p) => [p, to]))
  if (doc.asciiArtSource === from) set.asciiArtSource = to
  return set
}

/**
 * Patch paths of every reference to `assetId` anywhere in a document (`<path>._ref`), addressed by
 * `_key` in arrays (by index only for members without one). Crop, hotspot, alt text, caption and
 * layout are siblings of `asset` and are never touched.
 */
export function referencePaths(doc: Record<string, unknown>, assetId: string): string[] {
  const paths: string[] = []
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((member, index) => {
        const key = (member as {_key?: unknown} | null)?._key
        walk(member, typeof key === 'string' && key !== '' ? `${path}[_key==${JSON.stringify(key)}]` : `${path}[${index}]`)
      })
      return
    }
    if (typeof value !== 'object' || value === null) return
    const object = value as Record<string, unknown>
    if (object._ref === assetId && path !== '') paths.push(`${path}._ref`)
    for (const [name, child] of Object.entries(object)) {
      // System fields (_id, _type, _key, _ref, ...) hold no references to walk into.
      if (name.startsWith('_') || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue
      walk(child, path === '' ? name : `${path}.${name}`)
    }
  }
  walk(doc, '')
  return paths
}
