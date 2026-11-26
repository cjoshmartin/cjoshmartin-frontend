/**
 * Step: privacy (after extract, before assets).
 *
 * Owner decision (2026-11-26): no asset the public datasets serve may carry location or other
 * personal metadata, and nothing is re-encoded. The rules are in src/privacy/rules.ts (version 2:
 * the same policy as the image-privacy and video-to-mp4 Functions apply to new uploads). This step:
 *
 * 1. Scans every bucket content file (src/privacy/scan.ts: exiftool -ee, the Functions' own
 *    strippers' analysis, the track list and container check of videos, the header of STL models)
 *    and makes a verified copy without the personal metadata of each file that has some, with the
 *    Functions' strippers: images keep their coded image, orientation and ICC profile byte for byte
 *    (studio/functions/privacy/image-strip.ts), videos are edited in place and keep every audio and
 *    video packet byte for byte (studio/functions/privacy/isobmff-video.ts). Copies live in
 *    privacy/stripped/ and are listed in privacy/privacy-map.json, which the assets and videos steps
 *    require: they upload the copy, never a file with personal metadata.
 * 2. Inventories every asset of the dataset (images and files): its bytes (the local copy with the
 *    same sha1, or a download), the scan, `metadata.location`/`metadata.exif` and the documents
 *    that use it. Writes privacy/inventory-<dataset>.json (local only; tag names, never values).
 * 3. For every asset with personal metadata: uploads the stripped copy with the same title,
 *    description, file name and source (without `source.url`, which names the unstripped bucket
 *    object) and a `privacy` field (src/privacy/marker.ts) that the
 *    image-privacy and video-to-mp4 Functions read as "already stripped"; moves every use of the old
 *    asset in every document (raw perspective: published, drafts, release versions) to the copy in
 *    one transaction (references keep their crop, hotspot, alt text and caption; a video block's
 *    `original` and `conversion.sourceAssetId` move together and its MP4 stays; the MP4 asset's
 *    `source.id` follows); then deletes the old asset once nothing uses it. An MP4 made by
 *    video-to-mp4 with personal metadata stops the step (it would have to be converted again).
 *    A copy made by an earlier version of this step is replaced by the current copy of the same
 *    bucket original (never by a copy of the copy), so every dataset and every rerun ends with the
 *    same asset ids, and its `privacy.strippedFromDigest` is the keyed digest of the Wagtail
 *    upload's id (never the id: it names the deleted upload's CDN URL).
 * 4. Brings the state the later steps read up to date (the asset, video and ASCII-art maps and the
 *    NDJSON, by running the assets, videos, ascii and transform logic, which find everything in
 *    place and upload nothing), and moves the import record's entries of the documents it patched
 *    to their new revisions, when they were unchanged since the last import and now equal the
 *    transform's output. Without that, the next import would take this step's patches for Studio
 *    edits.
 *
 * Rerunnable: a second run finds nothing to replace and changes nothing.
 */
import {existsSync, readFileSync, rmSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'

import type {SanityClient} from '@sanity/client'

import {CONVERTED_ASSET_SOURCE_NAME} from '../../../../studio/functions/video-to-mp4/settings'
import {ASSET_SOURCE_NAME, type Dataset, type DataPaths, type Secrets} from '../config'
import {updateRecordAfterPatch, type StoredDocument} from '../import-guard'
import {copyPath, ensureStrippedCopy, readPrivacyMap, stripperVersions, toolVersions, withoutUrl, writePrivacyMap, type PrivacyMap, type StrippedCopy} from '../privacy/copies'
import {downloadAsset} from '../privacy/download'
import {assetIdWithSha1, migrationUploadDigest, PRIVACY_FIELD, strippedMarker} from '../privacy/marker'
import {findAssetIdOccurrences, replacementSet, applyReplacementSet, type Occurrence} from '../privacy/repoint'
import {classifyTag, PRIVACY_RULES_VERSION, type Finding} from '../privacy/rules'
import {scanLocalFile, type FileScan} from '../privacy/scan'
import {mapLimit, sanityClient} from '../sanity'
import {hashFile, log, readJson, stableStringify, writeJson} from '../util'
import {uploadAssets} from './assets'
import {generateAsciiArt} from './ascii'
import {readMp4Map} from './convert'
import type {Inventory} from './extract'
import {fileSha256, importRecordPath, readImportRecord} from './import'
import {ndjsonPath, readNdjson, transform} from './transform'
import {uploadVideos} from './videos'

type Doc = StoredDocument

export interface AssetDocument {
  _id: string
  _type: 'sanity.imageAsset' | 'sanity.fileAsset'
  _rev: string
  sha1hash: string
  originalFilename?: string
  mimeType?: string
  extension?: string
  size?: number
  url?: string
  title?: string
  description?: string
  altText?: string
  creditLine?: string
  label?: string
  source?: {name?: string; id?: string; url?: string}
  metadata?: Record<string, unknown>
  [PRIVACY_FIELD]?: Record<string, unknown>
  [field: string]: unknown
}

/** Fields Sanity sets on an asset from its bytes and its upload. */
const INTRINSIC_ASSET_FIELDS = new Set([
  '_id', '_type', '_rev', '_createdAt', '_updatedAt', '_system', 'assetId', 'extension', 'mimeType', 'path',
  'sha1hash', 'size', 'uploadId', 'url', 'metadata',
])

/** Fields describing an asset that a stripped copy takes over from the asset it replaces. */
export const DESCRIPTIVE_ASSET_FIELDS = ['title', 'description', 'altText', 'creditLine', 'label', 'source', 'originalFilename'] as const

/**
 * Fields a replaced asset may carry that the copy does not take over: its own `privacy` status and
 * the video-to-mp4 Function's lease on an upload being converted (`videoToMp4Lease`).
 */
const NOT_COPIED_FIELDS = new Set([PRIVACY_FIELD, 'videoToMp4Lease'])

/** Sanity's metadata keys -> the `extract` option that produces them. Never exif or location. */
const EXTRACTABLE_METADATA: Readonly<Record<string, 'blurhash' | 'lqip' | 'palette' | 'thumbhash'>> = {
  blurHash: 'blurhash',
  lqip: 'lqip',
  palette: 'palette',
  thumbHash: 'thumbhash',
}
/** Metadata keys Sanity always writes for images. */
const ALWAYS_PRESENT_METADATA = new Set(['_type', 'dimensions', 'hasAlpha', 'isOpaque'])

export interface InventoryEntry {
  assetId: string
  type: string
  sha1: string
  originalFilename: string | null
  mimeType: string | null
  size: number | null
  source: AssetDocument['source'] | null
  /** Where the scanned bytes came from: a bucket file, a stripped copy, an MP4 of the convert step, or a download. */
  bytesFrom: string
  kind: FileScan['kind']
  fileType: string | null
  findings: Finding[]
  unreadable: string | null
  dataTracks: string[]
  stlHeader?: string
  metadataLocation: boolean
  /** Personal keys in `metadata.exif` (Sanity's extracted EXIF), if any. */
  metadataExifPersonal: string[]
  metadataExif: boolean
  privacy: Record<string, unknown> | null
  referencedBy: string[]
}

export interface DatasetInventory {
  dataset: string
  rulesVersion: string
  tools: PrivacyMap['tools']
  takenAt: string
  assets: InventoryEntry[]
  summary: {assets: number; images: number; files: number; withPersonalMetadata: number; withMetadataLocation: number; unreadable: number}
}

export function inventoryPath(paths: DataPaths, dataset: Dataset): string {
  return path.join(paths.privacy, `inventory-${dataset}.json`)
}

function pendingRecordPath(paths: DataPaths, dataset: Dataset): string {
  return path.join(paths.privacy, `pending-record-update-${dataset}.json`)
}

/** Every document of the dataset, raw perspective (published, drafts, versions, assets). */
async function fetchAllDocuments(client: SanityClient): Promise<Doc[]> {
  return client.fetch<Doc[]>(`*[!(_id in path("_.**"))]`)
}

/** Every `_ref` in a value. */
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, into))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '_ref' && typeof child === 'string') into.add(child)
      else collectRefs(child, into)
    }
  }
}

/** asset id -> ids of the documents that reference it. */
export function referencesByAsset(docs: readonly Doc[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const doc of docs) {
    const refs = new Set<string>()
    collectRefs(doc, refs)
    for (const ref of refs) result.set(ref, [...(result.get(ref) ?? []), doc._id])
  }
  return result
}

/** Personal keys in Sanity's extracted `metadata.exif` (classified like exiftool's EXIF tags). */
export function personalMetadataExifKeys(exif: unknown): string[] {
  if (!exif || typeof exif !== 'object') return []
  return Object.keys(exif)
    .filter((key) => !key.startsWith('_') && classifyTag(`EXIF:ExifIFD:Main:${key}`, (exif as Record<string, unknown>)[key]) !== null)
    .sort()
}

/** Scans every bucket file and makes the verified copies (part 1). */
export async function prepareBucketCopies(paths: DataPaths): Promise<PrivacyMap> {
  const inventory = readJson<Inventory>(path.join(paths.state, 'inventory.json'))
  const tools = await toolVersions()
  const strippers = stripperVersions()
  const previous = readPrivacyMap(paths)
  // New rules or stripper code can change any copy; start over rather than mix copies made under
  // two of them. A copy that comes out with the same bytes keeps the time it was first made, so
  // its asset and its `privacy` field stay as they are.
  const reuse = previous !== null && previous.rulesVersion === PRIVACY_RULES_VERSION && previous.strippers?.sourceSha256 === strippers.sourceSha256
  const map: PrivacyMap = reuse
    ? {...previous, tools, strippers, bucket: {}}
    : {rulesVersion: PRIVACY_RULES_VERSION, strippers, tools, updatedAt: new Date().toISOString(), bucket: {}, copies: {}}
  if (previous && !reuse) log('privacy: the rules or the stripper code changed since the last run; every copy is made again')
  log(`privacy: scanning ${inventory.files.length} bucket files (exiftool ${tools.exiftool}, rules ${PRIVACY_RULES_VERSION})`)
  const scans = await mapLimit(inventory.files, 6, async (file) => {
    const local = path.join(paths.gcs, file.path)
    const sha1 = await hashFile(local, 'sha1')
    if (sha1 !== file.sha1) throw new Error(`privacy: ${file.path} has sha1 ${sha1}, the extract inventory says ${file.sha1}; run the extract step again`)
    return {file, local, scan: await scanLocalFile(local)}
  })
  for (const {file, scan} of scans) {
    if (scan.unreadable) throw new Error(`privacy: ${file.path} cannot be checked: ${scan.unreadable}`)
    map.bucket[file.path] = {sha1: file.sha1, kind: scan.kind, findings: scan.findings}
  }
  const flagged = new Map<string, (typeof scans)[number]>()
  for (const entry of scans) if (entry.scan.findings.length && !flagged.has(entry.file.sha1)) flagged.set(entry.file.sha1, entry)
  for (const {file, local, scan} of flagged.values()) {
    const copy = await ensureStrippedCopy(paths, map, {file: local, sha1: file.sha1, filename: path.posix.basename(file.path), kind: scan.kind, findings: scan.findings})
    const earlier = previous?.copies[file.sha1]
    if (!reuse && earlier && earlier.sha1 === copy.sha1) copy.strippedAt = earlier.strippedAt
    log(`  ${file.path}: ${describeFindings(scan.findings)} -> stripped copy ${copy.sha1.slice(0, 12)} (${copy.removed.join(', ')}), verified`)
  }
  map.updatedAt = new Date().toISOString()
  writePrivacyMap(paths, map)
  log(`privacy: ${flagged.size} of ${new Set(inventory.files.map((f) => f.sha1)).size} distinct bucket files have personal metadata; each has a verified copy without it`)
  return map
}

export function describeFindings(findings: readonly Finding[]): string {
  const byCategory = new Map<string, number>()
  for (const f of findings) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1)
  return [...byCategory].map(([category, count]) => `${count} ${category}`).join(', ')
}

/** Local bytes for every asset of the dataset, by sha1, and the scan of each (part 2). */
async function inventoryDataset(
  paths: DataPaths,
  dataset: Dataset,
  token: string,
  map: PrivacyMap,
  assets: readonly AssetDocument[],
  docs: readonly Doc[],
): Promise<{inventory: DatasetInventory; localFiles: Map<string, string>; scans: Map<string, FileScan>}> {
  const inventoryFiles = readJson<Inventory>(path.join(paths.state, 'inventory.json')).files
  const bySha1 = new Map<string, {file: string; from: string}>()
  for (const file of inventoryFiles) bySha1.set(file.sha1, {file: path.join(paths.gcs, file.path), from: `bucket:${file.path}`})
  for (const copy of Object.values(map.copies)) bySha1.set(copy.sha1, {file: copyPath(paths, copy), from: `stripped copy:${copy.file}`})
  if (existsSync(path.join(paths.state, 'video-mp4.json'))) {
    for (const video of Object.values(readMp4Map(paths).videos)) bySha1.set(video.output.sha1, {file: path.join(paths.root, video.output.path), from: `convert step:${video.output.path}`})
  }
  const downloads = path.join(paths.privacy, 'downloads', dataset)
  const refs = referencesByAsset(docs)
  const localFiles = new Map<string, string>()
  const scans = new Map<string, FileScan>()
  const entries = await mapLimit(assets, 6, async (asset): Promise<InventoryEntry> => {
    let local = bySha1.get(asset.sha1hash)
    if (local && (await hashFile(local.file, 'sha1')) !== asset.sha1hash) local = undefined
    if (!local) local = {file: await downloadAsset(asset, downloads, token), from: 'download'}
    localFiles.set(asset._id, local.file)
    const scan = await scanLocalFile(local.file, {convertedMp4: asset.source?.name === CONVERTED_ASSET_SOURCE_NAME})
    scans.set(asset._id, scan)
    const metadata = asset.metadata ?? {}
    return {
      assetId: asset._id,
      type: asset._type,
      sha1: asset.sha1hash,
      originalFilename: asset.originalFilename ?? null,
      mimeType: asset.mimeType ?? null,
      size: asset.size ?? null,
      source: asset.source ?? null,
      bytesFrom: local.from,
      kind: scan.kind,
      fileType: scan.fileType,
      findings: scan.findings,
      unreadable: scan.unreadable,
      dataTracks: scan.findings.filter((f) => f.category === 'data-track').map((f) => f.tag),
      ...(scan.stlHeader ? {stlHeader: scan.stlHeader.text} : {}),
      metadataLocation: metadata.location !== undefined && metadata.location !== null,
      metadataExif: metadata.exif !== undefined && metadata.exif !== null,
      metadataExifPersonal: personalMetadataExifKeys(metadata.exif),
      privacy: (asset[PRIVACY_FIELD] as Record<string, unknown> | undefined) ?? null,
      referencedBy: [...(refs.get(asset._id) ?? [])].sort(),
    }
  })
  entries.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0))
  const inventory: DatasetInventory = {
    dataset,
    rulesVersion: PRIVACY_RULES_VERSION,
    tools: map.tools,
    takenAt: new Date().toISOString(),
    assets: entries,
    summary: {
      assets: entries.length,
      images: entries.filter((e) => e.type === 'sanity.imageAsset').length,
      files: entries.filter((e) => e.type === 'sanity.fileAsset').length,
      withPersonalMetadata: entries.filter((e) => e.findings.length > 0).length,
      withMetadataLocation: entries.filter((e) => e.metadataLocation).length,
      unreadable: entries.filter((e) => e.unreadable !== null).length,
    },
  }
  return {inventory, localFiles, scans}
}

/** The metadata `extract` list that reproduces an image asset's metadata, never exif or location. */
export function extractOptionsFor(asset: Pick<AssetDocument, '_id' | 'metadata'>): ('blurhash' | 'lqip' | 'palette' | 'thumbhash')[] {
  const options: ('blurhash' | 'lqip' | 'palette' | 'thumbhash')[] = []
  for (const key of Object.keys(asset.metadata ?? {})) {
    if (ALWAYS_PRESENT_METADATA.has(key)) continue
    if (key === 'location' || key === 'exif') continue // never extracted again
    const option = EXTRACTABLE_METADATA[key]
    if (!option) throw new Error(`${asset._id} has metadata.${key}, which the privacy step does not know how to extract again`)
    options.push(option)
  }
  return options.sort()
}

/** The descriptive fields of `asset` that a copy takes over; throws for fields it does not know. */
export function descriptiveFields(asset: AssetDocument): Record<string, unknown> {
  const unknown = Object.keys(asset).filter(
    (key) => !INTRINSIC_ASSET_FIELDS.has(key) && !NOT_COPIED_FIELDS.has(key) && !(DESCRIPTIVE_ASSET_FIELDS as readonly string[]).includes(key),
  )
  if (unknown.length) throw new Error(`${asset._id} has fields the privacy step does not know how to carry over: ${unknown.join(', ')}`)
  const fields: Record<string, unknown> = {}
  for (const key of DESCRIPTIVE_ASSET_FIELDS) if (asset[key] !== undefined && asset[key] !== null) fields[key] = asset[key]
  // A copy never links to where its unstripped original is (the public bucket object).
  if (asset.source) fields.source = withoutUrl(asset.source)
  return fields
}

interface Replacement {
  old: AssetDocument
  copy: StrippedCopy
  newId: string
  /**
   * The asset id of the upload the copy was made from (the marker records its digest): the Wagtail
   * upload's id for a copy of a bucket file, otherwise the old asset itself.
   */
  uploadId: string
}

async function uploadCopy(client: SanityClient, paths: DataPaths, replacement: Replacement, existing: AssetDocument | undefined): Promise<AssetDocument> {
  const {old, copy} = replacement
  const fields = descriptiveFields(old)
  const marker = strippedMarker({kind: copy.kind, removed: copy.removed, uploadId: replacement.uploadId, strippedAt: copy.strippedAt})
  let current = existing
  if (!current) {
    const body = await readFile(copyPath(paths, copy))
    const uploaded = await client.assets.upload(old._type === 'sanity.imageAsset' ? 'image' : 'file', body, {
      filename: old.originalFilename ?? path.basename(copy.file),
      ...(old.mimeType ? {contentType: old.mimeType} : {}),
      ...(typeof old.title === 'string' ? {title: old.title} : {}),
      ...(typeof old.description === 'string' ? {description: old.description} : {}),
      ...(old.source ? {source: {name: String(old.source.name), id: String(old.source.id)}} : {}),
      ...(old._type === 'sanity.imageAsset' ? {extract: extractOptionsFor(old)} : {}),
    })
    current = uploaded as unknown as AssetDocument
    log(`  uploaded ${copy.file} -> ${current._id}`)
  }
  if (current._id !== replacement.newId) throw new Error(`Sanity stored the copy of ${old._id} as ${current._id}, expected ${replacement.newId}`)
  if (current.sha1hash !== copy.sha1) throw new Error(`Sanity stored ${current._id} with sha1 ${current.sha1hash}, the copy has ${copy.sha1}`)
  const set: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) if (stableStringify(current[key]) !== stableStringify(value)) set[key] = value
  if (stableStringify(current[PRIVACY_FIELD]) !== stableStringify(marker)) set[PRIVACY_FIELD] = marker
  if (Object.keys(set).length) {
    const patched = await client.patch(current._id).set(set).commit()
    log(`  set ${Object.keys(set).join(', ')} on ${current._id}`)
    current = patched as unknown as AssetDocument
  }
  return current
}

/**
 * The bucket file an asset's bytes come from: the file with the asset's sha1, or, for a copy this
 * step made (source "wagtail", `privacy` stripped), the file whose upload id has the copy's
 * `privacy.strippedFromDigest` (the upload id is the copy's id with the bucket file's sha1). Copies
 * made before the digest (round 1) named the upload in `privacy.strippedFrom`; that is read too, so
 * the next run can mark them with the digest. Null for assets that did not come from the bucket.
 */
export function bucketOrigin(
  asset: Pick<AssetDocument, '_id' | 'sha1hash' | 'source' | typeof PRIVACY_FIELD>,
  bucketBySha1: ReadonlyMap<string, {sha1: string; path: string}>,
  digest: (uploadId: string) => string = migrationUploadDigest(),
): {sha1: string; path: string} | null {
  const own = bucketBySha1.get(asset.sha1hash)
  if (own) return own
  const privacy = asset[PRIVACY_FIELD] as {status?: unknown; strippedFrom?: unknown; strippedFromDigest?: unknown} | undefined
  if (asset.source?.name !== ASSET_SOURCE_NAME || privacy?.status !== 'stripped') return null
  if (typeof privacy.strippedFromDigest === 'string') {
    for (const file of bucketBySha1.values()) {
      if (digest(assetIdWithSha1(asset._id, asset.sha1hash, file.sha1)) === privacy.strippedFromDigest) return file
    }
    return null
  }
  if (typeof privacy.strippedFrom !== 'string') return null
  const match = /^(?:image|file)-([0-9a-f]{40})-/.exec(privacy.strippedFrom)
  return match ? (bucketBySha1.get(match[1]!) ?? null) : null
}

export interface PrivacyPlan {
  dataset: Dataset
  map: PrivacyMap
  inventory: DatasetInventory
  assets: AssetDocument[]
  replacements: Replacement[]
  patches: {doc: Doc; set: Record<string, string>; occurrences: Occurrence[]}[]
}

/**
 * Parts 1 to 3 without writing to the dataset: the local copies, the inventory and what would be
 * replaced and patched. Throws, before anything is written, for anything the step cannot handle.
 */
export async function planPrivacy(paths: DataPaths, dataset: Dataset, secrets: Secrets): Promise<PrivacyPlan> {
  const map = await prepareBucketCopies(paths)
  const client = sanityClient(dataset, secrets)

  // --- 2. Inventory ----------------------------------------------------------------------
  const docs = await fetchAllDocuments(client)
  const assets = docs.filter((d): d is AssetDocument => d._type === 'sanity.imageAsset' || d._type === 'sanity.fileAsset')
  log(`privacy: inventory of ${dataset}: ${assets.length} assets`)
  const {inventory, localFiles, scans} = await inventoryDataset(paths, dataset, secrets.sanityWriteToken, map, assets, docs)
  writeJson(inventoryPath(paths, dataset), inventory)
  writeJson(path.join(paths.privacy, 'runs', `inventory-${dataset}-${inventory.takenAt.replace(/[:.]/g, '-')}.json`), inventory)
  log(`privacy: ${inventory.summary.withPersonalMetadata} of ${inventory.summary.assets} assets in ${dataset} have personal metadata, ${inventory.summary.withMetadataLocation} have metadata.location (${inventoryPath(paths, dataset)})`)

  // --- 3. Plan: copies, the documents to patch, nothing unknown -------------------------------
  const problems: string[] = []
  const replacements: Replacement[] = []
  const bucketBySha1 = new Map(readJson<Inventory>(path.join(paths.state, 'inventory.json')).files.map((f) => [f.sha1, f]))
  for (const asset of assets) {
    const scan = scans.get(asset._id)!
    const entry = inventory.assets.find((e) => e.assetId === asset._id)!
    if (scan.unreadable) {
      problems.push(`${asset._id} cannot be checked: ${scan.unreadable}`)
      continue
    }
    if (!scan.findings.length) {
      if (entry.metadataLocation || entry.metadataExifPersonal.length) {
        problems.push(`${asset._id} has no personal metadata in its file but metadata.location or personal metadata.exif keys on the document; upload it again without extracting them`)
      }
      continue
    }
    if (asset.source?.name === CONVERTED_ASSET_SOURCE_NAME) {
      problems.push(
        `${asset._id} is an MP4 made by ${CONVERTED_ASSET_SOURCE_NAME} and has personal metadata (${describeFindings(scan.findings)}). ` +
          'The MP4 settings copy no metadata, so it was not made by them: convert its stripped original again with the current settings.',
      )
      continue
    }
    try {
      descriptiveFields(asset)
      if (asset._type === 'sanity.imageAsset') extractOptionsFor(asset)
      const origin = bucketOrigin(asset, bucketBySha1)
      let copy: StrippedCopy
      let uploadId: string
      if (origin) {
        // A bucket file, or a copy an earlier version of this step made of one: the current copy of
        // that bucket file (made and verified against it in part 1), never a copy of a copy.
        const current = map.copies[origin.sha1]
        if (!current) {
          problems.push(`${asset._id} comes from the bucket file ${origin.path}, which has no stripped copy although ${asset._id} has personal metadata (${describeFindings(scan.findings)})`)
          continue
        }
        copy = current
        uploadId = assetIdWithSha1(asset._id, asset.sha1hash, origin.sha1)
      } else {
        copy = await ensureStrippedCopy(paths, map, {
          file: localFiles.get(asset._id)!,
          sha1: asset.sha1hash,
          filename: asset.originalFilename ?? `${asset.sha1hash}.${asset.extension ?? 'bin'}`,
          kind: scan.kind,
          findings: scan.findings,
        })
        uploadId = asset._id
      }
      if (copy.sha1 === asset.sha1hash) {
        problems.push(`${asset._id} is the current stripped copy of its original but the scan finds personal metadata in it (${describeFindings(scan.findings)})`)
        continue
      }
      const newId = assetIdWithSha1(asset._id, asset.sha1hash, copy.sha1)
      replacements.push({old: asset, copy, newId, uploadId})
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  writePrivacyMap(paths, map)

  const replacementIds = new Map(replacements.map((r) => [r.old._id, r.newId]))
  const oldIds = new Set(replacementIds.keys())
  const patches: {doc: Doc; set: Record<string, string>; occurrences: Occurrence[]}[] = []
  for (const doc of docs) {
    if (oldIds.has(doc._id)) continue
    const {known, unknown} = findAssetIdOccurrences(doc, oldIds)
    for (const u of unknown) problems.push(`${doc._id}: ${u.path} holds the asset id ${u.id} in a field the privacy step does not know; move it by hand`)
    if (known.length) patches.push({doc, set: replacementSet(known, replacementIds), occurrences: known})
  }
  if (problems.length) throw new Error(`privacy: nothing was written to ${dataset}:\n- ${problems.join('\n- ')}`)
  return {dataset, map, inventory, assets, replacements, patches}
}

export async function runPrivacy(paths: DataPaths, dataset: Dataset, secrets: Secrets, options: {discardStudioEdits: boolean}): Promise<void> {
  const {assets, replacements, patches} = await planPrivacy(paths, dataset, secrets)
  const client = sanityClient(dataset, secrets)
  const oldIds = new Set(replacements.map((r) => r.old._id))

  // --- 3b. Upload the copies ---------------------------------------------------------------
  if (replacements.length) {
    log(`privacy: replacing ${replacements.length} assets in ${dataset}; ${patches.length} documents use them`)
    const byId = new Map(assets.map((a) => [a._id, a]))
    for (const replacement of replacements) {
      const stored = await uploadCopy(client, paths, replacement, byId.get(replacement.newId))
      byId.set(stored._id, stored)
    }

    // --- 3c. Move every use, all documents in one transaction --------------------------------
    // Saved first, so a run interrupted after the transaction still updates the import record, and
    // kept (local only, it holds draft content) as the record of what this run replaced.
    // A pending file left by an interrupted run keeps its documents: they hold the revision the
    // import record knows.
    const savedAt = new Date().toISOString()
    const pendingBefore = existsSync(pendingRecordPath(paths, dataset)) ? readJson<{before: Doc[]}>(pendingRecordPath(paths, dataset)).before : []
    const pendingIds = new Set(pendingBefore.map((d) => d._id))
    writeJson(pendingRecordPath(paths, dataset), {dataset, savedAt, before: [...pendingBefore, ...patches.map((p) => p.doc).filter((d) => !pendingIds.has(d._id))]})
    writeJson(path.join(paths.privacy, 'runs', `replaced-${dataset}-${savedAt.replace(/[:.]/g, '-')}.json`), {
      dataset,
      savedAt,
      replacements: replacements.map((r) => ({old: r.old, newId: r.newId, copy: r.copy.file, removed: r.copy.removed})),
      patches: patches.map((p) => ({id: p.doc._id, rev: p.doc._rev, set: p.set})),
      documentsBefore: patches.map((p) => p.doc),
    })
    const tx = client.transaction()
    for (const {doc, set, occurrences} of patches) {
      const after = applyReplacementSet(doc, set)
      const left = findAssetIdOccurrences(after, oldIds)
      if (left.known.length || left.unknown.length) throw new Error(`privacy: the patch of ${doc._id} would leave ${[...left.known, ...left.unknown].map((o) => o.path).join(', ')}`)
      tx.patch(doc._id, {set, ifRevisionID: String(doc._rev)})
      log(`  ${doc._id}: ${occurrences.map((o) => `${o.path} (${o.kind})`).join(', ')}`)
    }
    if (patches.length) await tx.commit({visibility: 'sync'})

    // --- 3d. Delete the replaced assets once nothing uses them --------------------------------
    const docs = await fetchAllDocuments(client)
    const stillUsed: string[] = []
    for (const doc of docs) {
      if (oldIds.has(doc._id)) continue
      const {known, unknown} = findAssetIdOccurrences(doc, oldIds)
      for (const o of [...known, ...unknown]) stillUsed.push(`${doc._id} ${o.path} -> ${o.id}`)
    }
    for (const id of oldIds) {
      const count = await client.fetch<number>(`count(*[references($id)])`, {id})
      if (count !== 0) stillUsed.push(`${count} documents reference ${id}`)
    }
    if (stillUsed.length) throw new Error(`privacy: the replaced assets are still used, nothing deleted:\n- ${stillUsed.join('\n- ')}`)
    const deletion = client.transaction()
    for (const id of oldIds) deletion.delete(id)
    await deletion.commit({visibility: 'sync'})
    const left = await client.fetch<string[]>(`*[_id in $ids]._id`, {ids: [...oldIds]})
    if (left.length) throw new Error(`privacy: ${left.join(', ')} still exist after the delete`)
    for (const r of replacements) log(`  deleted ${r.old._id} (${r.old.originalFilename ?? ''}), replaced by ${r.newId}`)
  } else {
    log(`privacy: no asset in ${dataset} has personal metadata; nothing to replace`)
  }

  // --- 4. State the later steps read, and the import record -----------------------------------
  const pending = existsSync(pendingRecordPath(paths, dataset))
    ? readJson<{before: Doc[]}>(pendingRecordPath(paths, dataset)).before
    : null
  const stateIsStale = mapsReferToMissingAssets(paths, dataset, new Set((await client.fetch<string[]>(`*[_type in ["sanity.imageAsset", "sanity.fileAsset"]]._id`))))
  if (pending || stateIsStale) {
    log('privacy: bringing the asset, video and ASCII-art maps and the NDJSON up to date')
    await uploadAssets(paths, dataset, secrets, options)
    await uploadVideos(paths, dataset, secrets, options)
    await generateAsciiArt(paths, dataset)
    await transform(paths, dataset)
    if (mapsReferToMissingAssets(paths, dataset, new Set(await client.fetch<string[]>(`*[_type in ["sanity.imageAsset", "sanity.fileAsset"]]._id`)))) {
      throw new Error('privacy: the asset or video map still names assets that are not in the dataset')
    }
  }
  if (pending) {
    const record = readImportRecord(paths, dataset)
    // Asset documents (the MP4s whose source moved) are not imported, so the record has none.
    const patchedDocuments = pending.filter((d) => d._type !== 'sanity.imageAsset' && d._type !== 'sanity.fileAsset')
    if (record) {
      const expected = readNdjson(ndjsonPath(paths, dataset))
      const after = await client.getDocuments<Doc>(patchedDocuments.map((d) => d._id))
      const update = updateRecordAfterPatch({
        record,
        before: patchedDocuments,
        after: after.filter((d): d is NonNullable<typeof d> => d !== null) as unknown as Doc[],
        expected,
        ndjsonSha256: fileSha256(ndjsonPath(paths, dataset)),
      })
      writeJson(importRecordPath(paths, dataset), update.record)
      log(`privacy: import record: ${update.updated.length} entries moved to the patched revisions${update.kept.length ? `; kept: ${update.kept.map((k) => `${k.id} (${k.reason})`).join(', ')}` : ''}`)
    } else {
      log(`privacy: ${dataset} has no import record; nothing to update`)
    }
    rmSync(pendingRecordPath(paths, dataset))
  }
}

/** Whether the asset or video map of the dataset names an asset id that is not in the dataset. */
function mapsReferToMissingAssets(paths: DataPaths, dataset: Dataset, present: ReadonlySet<string>): boolean {
  const ids = new Set<string>()
  for (const file of [`assets-${dataset}.json`, `videos-${dataset}.json`, `ascii-${dataset}.json`]) {
    const full = path.join(paths.state, file)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8')
    for (const match of text.matchAll(/"((?:image|file)-[0-9a-f]{40}-[A-Za-z0-9-]+)"/g)) ids.add(match[1]!)
  }
  return [...ids].some((id) => !present.has(id))
}
