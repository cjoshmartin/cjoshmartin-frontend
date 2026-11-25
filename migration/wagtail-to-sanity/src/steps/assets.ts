/**
 * Step 2: assets.
 *
 * Uploads every content file of the bucket mirror to the target dataset: every original image
 * (including ones no record or page uses), every document file (including the one without a
 * record) and the media thumbnails. Videos go to Mux instead (steps/mux.ts).
 *
 * Sanity names assets by content (image-<sha1>-<w>x<h>-<ext>, file-<sha1>-<ext>), so files with
 * identical bytes become one asset and reruns never create duplicates. Before uploading, the step
 * looks the sha1 up in the dataset and only uploads what is missing; then it makes title,
 * description, originalFilename and source {name: "wagtail", id, url} match the Wagtail records
 * (patching assets that already exist, for example the testimonial photos WP2 uploaded).
 *
 * Writes state/assets-<dataset>.json: bucket path, Wagtail image/document id and media id (for
 * thumbnails) -> Sanity asset id.
 */
import {createReadStream} from 'node:fs'
import path from 'node:path'

import {ASSET_SOURCE_NAME, gcsPublicUrl, type Dataset, type DataPaths, type Secrets} from '../config'
import {mapLimit, sanityClient} from '../sanity'
import {groupBy, log, readJson, writeJson} from '../util'
import {loadExport, type WagtailDocument, type WagtailImage, type WagtailMedia} from '../wagtail'
import type {Inventory, InventoryFile} from './extract'

export interface AssetSource {
  name: string
  id: string
  url: string
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

interface ExistingAsset {
  _id: string
  _type: string
  sha1hash: string
  title?: string
  description?: string
  originalFilename?: string
  source?: {name?: string; id?: string; url?: string}
}

export async function uploadAssets(paths: DataPaths, dataset: Dataset, secrets: Secrets): Promise<AssetMap> {
  const inventory = readJson<Inventory>(path.join(paths.state, 'inventory.json'))
  const data = loadExport(paths.exportJson)
  const client = sanityClient(dataset, secrets)
  const planned = planAssets(inventory.files, data.images, data.documents, data.media)
  log(`assets: ${planned.length} distinct assets from ${inventory.files.filter((f) => f.folder !== 'media').length} files`)

  const existing = await client.fetch<ExistingAsset[]>(
    `*[_type in ["sanity.imageAsset", "sanity.fileAsset"]]{_id, _type, sha1hash, title, description, originalFilename, source}`,
  )
  const existingByKey = new Map(
    existing.map((a) => [`${a._type === 'sanity.imageAsset' ? 'image' : 'file'}:${a.sha1hash}`, a]),
  )

  let uploaded = 0
  let patched = 0
  const results = await mapLimit(planned, 4, async (asset) => {
    let current = existingByKey.get(`${asset.type}:${asset.sha1}`)
    if (!current) {
      const doc = await client.assets.upload(
        asset.type,
        createReadStream(path.join(paths.gcs, asset.primaryPath)),
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
      log(`  uploaded ${asset.primaryPath} -> ${doc._id}`)
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

  writeJson(path.join(paths.state, `assets-${dataset}.json`), map)
  log(`assets: ${results.length} assets ready (${uploaded} uploaded, ${results.length - uploaded} already in ${dataset}, ${patched} metadata updates)`)
  return map
}
