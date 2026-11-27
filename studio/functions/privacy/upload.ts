/**
 * The one way this repository uploads an asset that can be an image (recreate fix round 2,
 * finding 2). Sanity writes whatever an upload asks it to extract (@sanity/client's `extract`, the
 * HTTP API's `meta`) into the asset document's first revision, and the History API of a public
 * dataset serves that revision without a token for the history retention period. upload-privacy
 * removes the data from the asset document within seconds, but cannot change that revision (fix
 * round 1, finding 1). So an image upload may extract only IMAGE_METADATA_OPTIONS, never
 * `location`, `exif` or `image`:
 *
 * - TypeScript: `extract` takes only IMAGE_METADATA_OPTIONS values.
 * - At run time, for JavaScript callers, casts and lists built at run time: any other value, an
 *   `extract` on a file upload, and any option this module does not list are refused before a
 *   request is made.
 * - An image upload without `extract` asks for IMAGE_METADATA_OPTIONS explicitly, so it does not
 *   depend on Sanity's default.
 *
 * File uploads may also call @sanity/client directly: a file asset gets no image metadata. Every
 * upload that can be an image (the type `'image'`, or a type known only at run time) goes through
 * here. studio/test/upload-metadata.test.ts checks that, and sends this module's requests to a
 * local server to read the `meta` parameters @sanity/client builds from them.
 *
 * No package dependency: it calls the client it is given, so the Functions, the Studio's scripts
 * and the migration share it whatever their @sanity/client version.
 */
import {IMAGE_METADATA_OPTIONS} from './constants'

export type ImageMetadataOption = (typeof IMAGE_METADATA_OPTIONS)[number]

/** @sanity/client's `assets.upload` options that an upload here may set; `extract` is limited. */
export interface AssetUploadOptions {
  filename?: string
  contentType?: string
  title?: string
  description?: string
  label?: string
  creditLine?: string
  source?: {id: string; name: string; url?: string}
  tag?: string
  timeout?: number
  preserveFilename?: boolean
  /** Images only. Default: IMAGE_METADATA_OPTIONS. */
  extract?: readonly ImageMetadataOption[]
}

/** The names of AssetUploadOptions, for the run-time check. */
const UPLOAD_OPTION_NAMES: ReadonlySet<string> = new Set([
  'filename',
  'contentType',
  'title',
  'description',
  'label',
  'creditLine',
  'source',
  'tag',
  'timeout',
  'preserveFilename',
  'extract',
])

export type UploadBody = Buffer | NodeJS.ReadableStream

/**
 * The part of @sanity/client that an upload needs, typed structurally so that every package's
 * client version fits. `R` is what the client's upload resolves to.
 */
export interface AssetUploadClient<R> {
  assets: {upload(assetType: 'image' | 'file', body: never, options?: object): Promise<R>}
}

/** The `extract` list of an image upload: `extract` itself when every value is allowed. */
export function imageExtract(extract: readonly string[] = IMAGE_METADATA_OPTIONS): ImageMetadataOption[] {
  if (!Array.isArray(extract)) throw new TypeError(`\`extract\` must be a list, not ${typeof extract}`)
  const allowed: readonly string[] = IMAGE_METADATA_OPTIONS
  const refused = extract.filter((option) => !allowed.includes(option))
  if (refused.length > 0) {
    throw new Error(
      `an image upload may extract only ${IMAGE_METADATA_OPTIONS.join(', ')}; refused: ${refused.map(String).join(', ')}. ` +
        'Whatever an upload extracts stays readable without a token in the History API of a public dataset.',
    )
  }
  return [...extract] as ImageMetadataOption[]
}

/** The options passed to @sanity/client for an upload of type `kind`, checked as described above. */
export function uploadOptions(kind: 'image' | 'file', options: AssetUploadOptions = {}): Omit<AssetUploadOptions, 'extract'> & {extract?: ImageMetadataOption[]} {
  if (kind !== 'image' && kind !== 'file') throw new Error(`unknown asset type ${String(kind)}`)
  const unknown = Object.keys(options).filter((name) => !UPLOAD_OPTION_NAMES.has(name))
  if (unknown.length > 0) throw new Error(`upload option(s) not allowed here: ${unknown.join(', ')}`)
  const {extract, ...rest} = options
  if (kind === 'file') {
    if (extract !== undefined) throw new Error('`extract` is for image uploads only; a file asset gets no image metadata')
    return rest
  }
  return {...rest, extract: imageExtract(extract)}
}

/** Uploads `body` as an asset of type `kind` with checked options (see the module comment). */
export function uploadAsset<R>(client: AssetUploadClient<R>, kind: 'image' | 'file', body: UploadBody, options: AssetUploadOptions = {}): Promise<R> {
  const checked = uploadOptions(kind, options)
  return client.assets.upload(kind, body as never, checked)
}
