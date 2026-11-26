/**
 * Step 2: assets.
 *
 * Uploads every content file of the bucket mirror to the target dataset: every original image
 * (including ones no record or page uses), every document file (including the one without a
 * record) and the media thumbnails. Videos are converted to MP4 (steps/convert.ts) and uploaded
 * together with their originals by the videos step (steps/videos.ts), which uses the same
 * metadata check.
 *
 * Sanity names assets by content (image-<sha1>-<w>x<h>-<ext>, file-<sha1>-<ext>), so files with
 * identical bytes become one asset and reruns never create duplicates. Before uploading, the step
 * looks the sha1 up in the dataset and only uploads what is missing; then it makes title,
 * description, originalFilename and source {name: "wagtail", id, url} match the Wagtail records
 * (patching assets that already exist, for example the testimonial photos WP2 uploaded).
 *
 * A bucket file with personal metadata is never uploaded: the privacy step (src/steps/privacy.ts)
 * made a copy without it, listed in privacy/privacy-map.json, and this step uploads that copy (same
 * title, description, file name and source) with the `privacy` field the Functions read
 * (src/privacy/marker.ts). The step refuses to run when the privacy map does not cover every bucket
 * file.
 *
 * Writes state/assets-<dataset>.json: bucket path, Wagtail image/document id and media id (for
 * thumbnails) -> Sanity asset id, and per asset the metadata the step left on it. That file is also
 * the record that protects later edits: before writing anything, the step refuses when an asset's
 * metadata differs from what it would set and from what the last run left (someone changed it since,
 * for example with a media plugin or the API), unless the run is told to discard those changes.
 * Without a record, metadata an earlier run wrote (source "wagtail") counts as changed too, because
 * edits cannot be told apart; other existing assets are adopted as before.
 */
import {createReadStream, existsSync} from 'node:fs'
import path from 'node:path'

import {ASSET_SOURCE_NAME, gcsPublicUrl, type Dataset, type DataPaths, type Secrets} from '../config'
import {copyFor, requirePrivacyMap, withStrippedCopy, type PrivacyMap, type StrippedSource} from '../privacy/copies'
import {assetIdWithSha1, PRIVACY_FIELD, strippedMarker} from '../privacy/marker'
import {mapLimit, sanityClient} from '../sanity'
import {groupBy, log, readJson, stableStringify, writeJson} from '../util'
import {loadExport, type WagtailDocument, type WagtailImage, type WagtailMedia} from '../wagtail'
import type {Inventory, InventoryFile} from './extract'

export interface AssetSource {
  name: string
  id: string
  /** Where the bytes came from. Converted MP4s have none: they were made by the migration. */
  url?: string
}

export interface PlannedAsset {
  type: 'image' | 'file'
  sha1: string
  /** Bucket paths with these bytes. */
  paths: string[]
  primaryPath: string
  originalFilename: string
  title: string
  description?: string
  source: AssetSource
  /** Wagtail records whose bytes this asset holds. */
  records: string[]
  /**
   * Set when the bucket file has personal metadata: the upload is this stripped copy, and `sha1` is
   * the copy's.
   */
  strippedCopy?: StrippedSource
}

export interface AssetMap {
  dataset: string
  /** bucket path -> asset id */
  files: Record<string, string>
  /** Wagtail image id -> asset id (records whose file is missing are absent) */
  images: Record<string, string>
  /** Wagtail document id -> asset id */
  documents: Record<string, string>
  /** Wagtail media id -> asset id of its thumbnail image */
  mediaThumbnails: Record<string, string>
  /** asset id -> what was uploaded */
  assets: Record<string, PlannedAsset & {assetId: string}>
}

/** Metadata Sanity extracts for images. No exif/location: originals are phone photos. */
const IMAGE_METADATA = ['blurhash', 'lqip', 'palette'] as const

function assetTypeForFolder(folder: string): 'image' | 'file' {
  if (folder === 'original_images' || folder === 'media_thumbnails') return 'image'
  if (folder === 'documents') return 'file'
  throw new Error(`No Sanity asset type for bucket folder ${folder}`)
}

/** Decides one asset per distinct (type, sha1) with its Wagtail metadata. */
export function planAssets(
  files: InventoryFile[],
  images: WagtailImage[],
  documents: WagtailDocument[],
  media: WagtailMedia[],
): PlannedAsset[] {
  const uploadable = files.filter((f) => f.folder !== 'media')
  const groups = groupBy(uploadable, (f) => `${assetTypeForFolder(f.folder)}:${f.sha1}`)
  const planned: PlannedAsset[] = []
  for (const [key, group] of groups) {
    const [type, sha1] = key.split(':') as ['image' | 'file', string]
    const paths = group.map((f) => f.path).sort()
    const pathSet = new Set(paths)
    const imageRecords = images.filter((i) => pathSet.has(i.file))
    const documentRecords = documents.filter((d) => pathSet.has(d.file))
    const thumbnailOf = media.filter((m) => m.thumbnail && pathSet.has(m.thumbnail))
    const records = [
      ...imageRecords.map((i) => `image:${i.id}`),
      ...documentRecords.map((d) => `document:${d.id}`),
      ...thumbnailOf.map((m) => `media-thumbnail:${m.id}`),
    ].sort((a, b) => a.localeCompare(b, 'en', {numeric: true}))

    let primaryPath: string
    let title: string
    let description: string | undefined
    if (imageRecords.length > 0) {
      // The record whose upload wrote these bytes (newest with a matching hash) describes them.
      const matching = imageRecords.filter((i) => i.file_hash === sha1).sort((a, b) => b.id - a.id)
      const primary = matching[0] ?? [...imageRecords].sort((a, b) => a.id - b.id)[0]!
      primaryPath = primary.file
      title = primary.title
      description = primary.description.trim() || undefined
    } else if (documentRecords.length > 0) {
      const primary = [...documentRecords].sort((a, b) => a.id - b.id)[0]!
      primaryPath = primary.file
      title = primary.title
    } else if (thumbnailOf.length > 0) {
      const primary = [...thumbnailOf].sort((a, b) => a.id - b.id)[0]!
      primaryPath = primary.thumbnail as string
      title = `${primary.title} (video thumbnail)`
    } else {
      primaryPath = paths[0]!
      title = path.posix.basename(primaryPath)
    }
    planned.push({
      type,
      sha1,
      paths,
      primaryPath,
      originalFilename: path.posix.basename(primaryPath),
      title,
      ...(description ? {description} : {}),
      source: {
        name: ASSET_SOURCE_NAME,
        id: records.length > 0 ? records.join(',') : `bucket:${primaryPath}`,
        url: gcsPublicUrl(primaryPath),
      },
      records,
    })
  }
  return planned.sort((a, b) => a.primaryPath.localeCompare(b.primaryPath))
}

export interface ExistingAsset {
  _id: string
  _type: string
  sha1hash: string
  title?: string
  description?: string
  originalFilename?: string
  source?: {name?: string; id?: string; url?: string}
  [PRIVACY_FIELD]?: unknown
}

/** The asset fields this step sets. Only these are compared, written and recorded. */
const METADATA_FIELDS = ['title', 'description', 'originalFilename', 'source'] as const

export type AssetMetadataSource = Pick<ExistingAsset, (typeof METADATA_FIELDS)[number]>

/** The metadata this step sets, in a comparable form (missing fields are null). */
function metadataOf(asset: AssetMetadataSource): Record<(typeof METADATA_FIELDS)[number], unknown> {
  return {
    title: asset.title ?? null,
    description: asset.description ?? null,
    originalFilename: asset.originalFilename ?? null,
    source: asset.source ? {name: asset.source.name ?? null, id: asset.source.id ?? null, url: asset.source.url ?? null} : null,
  }
}

/** The metadata fields whose values differ between two assets. */
export function differingMetadata(a: AssetMetadataSource, b: AssetMetadataSource): string[] {
  const left = metadataOf(a)
  const right = metadataOf(b)
  return METADATA_FIELDS.filter((field) => stableStringify(left[field]) !== stableStringify(right[field]))
}

export interface AssetMetadataEdit {
  assetId: string
  /** Fields that differ from what this run would set. */
  fields: string[]
  reason: 'changed since the last run' | 'not set by this migration' | 'set by a run that left no record'
}

/**
 * The assets whose metadata this run would overwrite although this migration did not leave it so.
 * An asset whose metadata already equals the plan needs no write. One whose metadata still equals
 * what the last run left (`previous`) is the migration's own and may follow a changed plan.
 * Anything else changed outside this migration. Without a record, only metadata that names this
 * migration as its source counts, because the first run adopts assets uploaded by others (the
 * testimonial photos WP2 uploaded).
 *
 * `previous` is the state file of the step's last run: state/assets-<dataset>.json for this step,
 * state/videos-<dataset>.json for the videos step.
 */
export function findAssetMetadataEdits(
  planned: readonly PlannedAsset[],
  existingByKey: ReadonlyMap<string, ExistingAsset>,
  previous: {assets: Record<string, AssetMetadataSource>} | null,
): AssetMetadataEdit[] {
  const edits: AssetMetadataEdit[] = []
  for (const asset of planned) {
    const current = existingByKey.get(`${asset.type}:${asset.sha1}`)
    if (!current) continue
    const fields = differingMetadata(current, asset)
    if (!fields.length) continue
    if (previous) {
      const recorded = previous.assets[current._id]
      if (!recorded) edits.push({assetId: current._id, fields, reason: 'not set by this migration'})
      else if (differingMetadata(current, recorded).length) edits.push({assetId: current._id, fields, reason: 'changed since the last run'})
    } else if (current.source?.name === ASSET_SOURCE_NAME) {
      edits.push({assetId: current._id, fields, reason: 'set by a run that left no record'})
    }
  }
  return edits.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0))
}

/**
 * The `privacy` field a stripped copy must carry (src/privacy/marker.ts); null for an upload of a
 * bucket file without personal metadata.
 */
export function expectedPrivacyMarker(map: PrivacyMap, asset: Pick<PlannedAsset, 'sha1' | 'strippedCopy'>, assetId: string): unknown {
  if (!asset.strippedCopy) return null
  const copy = copyFor(map, asset.strippedCopy)
  return strippedMarker({
    kind: copy.kind,
    removed: copy.removed,
    strippedFrom: assetIdWithSha1(assetId, asset.sha1, copy.originalSha1),
    strippedAt: copy.strippedAt,
  })
}

/** Sets the `privacy` field of a stripped copy when it differs; returns whether it wrote. */
export async function ensurePrivacyMarker(
  client: ReturnType<typeof sanityClient>,
  map: PrivacyMap,
  asset: Pick<PlannedAsset, 'sha1' | 'strippedCopy'>,
  current: {_id: string; [PRIVACY_FIELD]?: unknown},
): Promise<boolean> {
  const marker = expectedPrivacyMarker(map, asset, current._id)
  if (marker === null || stableStringify(current[PRIVACY_FIELD] ?? null) === stableStringify(marker)) return false
  await client.patch(current._id).set({[PRIVACY_FIELD]: marker}).commit()
  log(`  set ${PRIVACY_FIELD} on ${current._id} (stripped copy)`)
  return true
}

export function assetMapPath(paths: DataPaths, dataset: Dataset): string {
  return path.join(paths.state, `assets-${dataset}.json`)
}

/** The map the last successful run of this step wrote for `dataset`, or null. */
export function readAssetMap(paths: DataPaths, dataset: Dataset): AssetMap | null {
  const file = assetMapPath(paths, dataset)
  if (!existsSync(file)) return null
  const map = readJson<AssetMap>(file)
  if (map.dataset !== dataset) throw new Error(`${file} is the asset map of dataset ${map.dataset}, not ${dataset}`)
  return map
}

export async function uploadAssets(
  paths: DataPaths,
  dataset: Dataset,
  secrets: Secrets,
  options: {discardStudioEdits: boolean},
): Promise<AssetMap> {
  const inventory = readJson<Inventory>(path.join(paths.state, 'inventory.json'))
  const data = loadExport(paths.exportJson)
  const client = sanityClient(dataset, secrets)
  const privacy = requirePrivacyMap(paths, inventory.files)
  const planned = planAssets(inventory.files, data.images, data.documents, data.media).map((asset) => withStrippedCopy(asset, privacy))
  log(
    `assets: ${planned.length} distinct assets from ${inventory.files.filter((f) => f.folder !== 'media').length} files ` +
      `(${planned.filter((a) => a.strippedCopy).length} of them as copies without personal metadata)`,
  )

  const existing = await client.fetch<ExistingAsset[]>(
    `*[_type in ["sanity.imageAsset", "sanity.fileAsset"]]{_id, _type, sha1hash, title, description, originalFilename, source, ${PRIVACY_FIELD}}`,
  )
  const existingByKey = new Map(
    existing.map((a) => [`${a._type === 'sanity.imageAsset' ? 'image' : 'file'}:${a.sha1hash}`, a]),
  )

  // Nothing is uploaded or patched before this check.
  const previous = readAssetMap(paths, dataset)
  const edits = findAssetMetadataEdits(planned, existingByKey, previous)
  if (edits.length) {
    const list = edits.map((e) => `- ${e.assetId} (${e.fields.join(', ')}): ${e.reason}`).join('\n')
    if (!options.discardStudioEdits) {
      throw new Error(
        `assets: refusing to change asset metadata in ${dataset}; this migration did not leave these values ` +
          `(record: ${previous ? assetMapPath(paths, dataset) : 'none'}):\n${list}\n` +
          'Pass --discard-studio-edits to overwrite them on purpose.',
      )
    }
    log(`assets: WARNING --discard-studio-edits overwrites the metadata of these assets in ${dataset}:\n${list}`)
  }

  let uploaded = 0
  let patched = 0
  const results = await mapLimit(planned, 4, async (asset) => {
    let current = existingByKey.get(`${asset.type}:${asset.sha1}`)
    if (!current) {
      const doc = await client.assets.upload(
        asset.type,
        createReadStream(asset.strippedCopy ? path.join(paths.privacy, asset.strippedCopy.file) : path.join(paths.gcs, asset.primaryPath)),
        {
          filename: asset.originalFilename,
          title: asset.title,
          ...(asset.description ? {description: asset.description} : {}),
          source: asset.source,
          ...(asset.type === 'image' ? {extract: [...IMAGE_METADATA]} : {}),
        },
      )
      uploaded++
      current = {
        _id: doc._id,
        _type: doc._type,
        sha1hash: doc.sha1hash,
        title: (doc as {title?: string}).title,
        description: (doc as {description?: string}).description,
        originalFilename: doc.originalFilename,
        source: (doc as {source?: ExistingAsset['source']}).source,
      }
      log(`  uploaded ${asset.strippedCopy ? `the stripped copy of ${asset.primaryPath}` : asset.primaryPath} -> ${doc._id}`)
    }
    if (current.sha1hash !== asset.sha1) {
      throw new Error(`Sanity stored ${asset.primaryPath} with sha1 ${current.sha1hash}, expected ${asset.sha1}`)
    }
    const wanted = {
      title: asset.title,
      description: asset.description,
      originalFilename: asset.originalFilename,
    }
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    for (const [field, value] of Object.entries(wanted)) {
      const have = current[field as keyof typeof wanted]
      if (value === undefined) {
        if (have !== undefined && have !== null) unset.push(field)
      } else if (have !== value) {
        set[field] = value
      }
    }
    const src = current.source
    if (!src || src.name !== asset.source.name || src.id !== asset.source.id || src.url !== asset.source.url) {
      set.source = {...asset.source}
    }
    if (Object.keys(set).length || unset.length) {
      await client.patch(current._id).set(set).unset(unset).commit()
      patched++
      log(`  updated metadata of ${current._id} (${[...Object.keys(set), ...unset.map((u) => `-${u}`)].join(', ')})`)
    }
    if (await ensurePrivacyMarker(client, privacy, asset, current)) patched++
    return {...asset, assetId: current._id}
  })

  const map: AssetMap = {dataset, files: {}, images: {}, documents: {}, mediaThumbnails: {}, assets: {}}
  for (const asset of results) {
    map.assets[asset.assetId] = asset
    for (const p of asset.paths) map.files[p] = asset.assetId
  }
  const assetFor = (p: string) => {
    const id = map.files[p]
    if (!id) throw new Error(`No asset for bucket path ${p}`)
    return id
  }
  for (const [id, p] of Object.entries(inventory.imageFiles)) map.images[id] = assetFor(p)
  for (const [id, p] of Object.entries(inventory.documentFiles)) map.documents[id] = assetFor(p)
  for (const [id, p] of Object.entries(inventory.mediaThumbnails)) map.mediaThumbnails[id] = assetFor(p)
  for (const [id, assetId] of Object.entries(map.documents)) {
    if (!assetId.startsWith('file-')) throw new Error(`Document ${id} became ${assetId}, expected a file asset`)
  }

  writeJson(assetMapPath(paths, dataset), map)
  log(`assets: ${results.length} assets ready (${uploaded} uploaded, ${results.length - uploaded} already in ${dataset}, ${patched} metadata updates)`)
  return map
}
