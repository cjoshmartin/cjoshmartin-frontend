import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {createGzip, gunzipSync} from 'node:zlib'

import {packTar} from 'modern-tar/fs'

import {findLatestMarker, MANIFEST_FORMAT_VERSION, parseMarker} from './backup.mjs'
import {isImportableSystemDocumentId, isSystemDocumentId, sortById, toNdjson} from './documents.mjs'
import {computeFingerprint} from './fingerprint.mjs'
import {isTimestamp, markerKey, MARKERS_PREFIX, snapshotDataKey, snapshotManifestKey} from './layout.mjs'
import {describeAssetDocument, isAssetDocument, parseAssetId} from './sanity-assets.mjs'
import {parseExportNdjson} from './sanity-export.mjs'
import {runPool, sha256Hex} from './util.mjs'

// Same exclusions as @sanity/export when it writes assets.json: these fields
// describe the stored binary or its location and are recreated by the upload.
const ASSET_MAP_EXCLUDED_FIELDS = new Set(['_id', '_type', 'assetId', 'extension', 'mimeType', 'path', 'uploadId', 'url'])
// Asset document fields that are never restored or compared. They are the
// assets.json exclusions above plus what @sanity/import strips before it
// patches a fresh upload with assets.json (its NON_RESTORABLE_ASSET_FIELDS):
// the asset service derives them from the stored blob, its location and the
// upload itself. Replaying another dataset's uploadId would even make the
// asset impossible to delete. Every other field (metadata, originalFilename,
// source, title, description, altText, creditLine, ...) is restorable.
const ASSET_DERIVED_FIELDS = new Set([...ASSET_MAP_EXCLUDED_FIELDS, '_rev', '_createdAt', '_updatedAt', 'sha1hash', 'size'])
const OTHER_ASSET_TYPE_PATTERN = /^sanity\.[a-zA-Z]+Asset$/

// Rewrites every `{asset: {_ref: "image-…" | "file-…"}}` object into the
// import directive `{_sanityAsset: "image@file://./images/<sha1>.<ext>"}`,
// exactly like `sanity datasets export` does. `sanity datasets import`
// resolves "./" against the folder holding data.ndjson, uploads the file (or
// reuses an identical asset already in the target) and sets the reference.
export function rewriteAssetReferences(value, referencedAssetIds = new Set()) {
  if (Array.isArray(value)) return value.map((item) => rewriteAssetReferences(item, referencedAssetIds))
  if (!value || typeof value !== 'object') return value
  const ref = value.asset?._ref
  const parsed = typeof ref === 'string' ? parseAssetId(ref) : null
  if (parsed) {
    referencedAssetIds.add(ref)
    const {asset: _asset, ...rest} = value
    const rewritten = {_sanityAsset: `${parsed.type}@file://./${parsed.kind}/${parsed.hash}.${parsed.extension}`}
    for (const [key, child] of Object.entries(rest)) rewritten[key] = rewriteAssetReferences(child, referencedAssetIds)
    return rewritten
  }
  const copy = {}
  for (const [key, child] of Object.entries(value)) copy[key] = rewriteAssetReferences(child, referencedAssetIds)
  return copy
}

// Splits a snapshot into what goes into data.ndjson and what does not:
// - system documents other than release/variant definitions are dropped
//   (Sanity manages them; the import would skip them anyway),
// - sanity.imageAsset / sanity.fileAsset documents are dropped, because the
//   import recreates them from the binaries in images/ and files/,
// - every other document is kept, including drafts, release versions,
//   mux.videoAsset documents and any other asset type, with asset
//   references rewritten to _sanityAsset directives.
export function prepareImportDocuments(documents) {
  const importDocuments = []
  const assetDocuments = []
  const otherAssetDocuments = []
  const droppedSystemIds = []
  const referencedAssetIds = new Set()
  for (const doc of sortById(documents)) {
    if (isSystemDocumentId(doc._id) && !isImportableSystemDocumentId(doc._id)) {
      droppedSystemIds.push(doc._id)
      continue
    }
    if (isAssetDocument(doc)) {
      assetDocuments.push(doc)
      continue
    }
    if (OTHER_ASSET_TYPE_PATTERN.test(doc._type)) otherAssetDocuments.push(doc)
    importDocuments.push(rewriteAssetReferences(doc, referencedAssetIds))
  }
  return {importDocuments, assetDocuments, otherAssetDocuments, droppedSystemIds, referencedAssetIds}
}

export function assetMapEntry(assetDoc) {
  const entry = {}
  for (const [key, value] of Object.entries(assetDoc)) {
    if (!ASSET_MAP_EXCLUDED_FIELDS.has(key)) entry[key] = value
  }
  return entry
}

// `--allow-assets-in-different-dataset` is only needed when the import file
// still contains asset documents (any sanity.*Asset type this tool does not
// turn back into binaries) whose URL points at another project or dataset.
export function needsAllowAssetsInDifferentDataset(otherAssetDocuments, {projectId, dataset}) {
  return otherAssetDocuments.some((doc) => {
    const location = String(doc.path || doc.url || '').replace(/^https:\/\/cdn\.sanity\.[a-z]+\//, '')
    const [, assetProject, assetDataset] = location.split('/')
    return assetProject !== projectId || assetDataset !== dataset
  })
}

// Picks the snapshot to restore. `sourceDataset` is the dataset the snapshot
// must have been taken of: restore.mjs passes --from-dataset, which defaults
// to the target --dataset, so a snapshot of one dataset is only ever imported
// into another when the command says so. --latest considers only that
// dataset's snapshots (staging and production share one bucket), and
// --snapshot is refused when its marker names another dataset. Only a
// --build-only run of an explicit --snapshot may leave it undefined.
export async function resolveSnapshot(storage, {snapshot, latest, sourceDataset}) {
  if (snapshot && latest) throw new Error('Pass either --snapshot <ts> or --latest, not both')
  if (!snapshot && !latest) throw new Error('Pass --snapshot <ts> or --latest')
  if (snapshot) {
    if (!isTimestamp(snapshot)) throw new Error(`--snapshot must look like 20261129T090000Z, got ${snapshot}`)
    const exists = await storage.stat(markerKey(snapshot))
    if (!exists) throw new Error(`No marker ${markerKey(snapshot)}: that snapshot does not exist or never completed`)
    if (sourceDataset !== undefined) {
      const marker = parseMarker(await storage.readBuffer(markerKey(snapshot)), markerKey(snapshot))
      if (marker.dataset !== sourceDataset) {
        throw new Error(
          `Snapshot ${snapshot} is of dataset ${marker.dataset}, not ${sourceDataset}. ` +
            `To restore it into another dataset on purpose, pass --from-dataset ${marker.dataset}`,
        )
      }
    }
    return snapshot
  }
  if (sourceDataset === undefined) {
    throw new Error('--latest needs the dataset the snapshot was taken of: pass --from-dataset <name> (it defaults to --dataset)')
  }
  const keys = (await storage.list(MARKERS_PREFIX)).map((object) => object.key)
  const found = await findLatestMarker(storage, keys, {dataset: sourceDataset})
  if (!found) throw new Error(`No completed snapshots of dataset ${sourceDataset} in ${storage.describe()}`)
  return found.timestamp
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

// Loads and verifies a snapshot: the marker must exist, the manifest and data
// must match the hashes recorded in the marker, and the documents must
// reproduce the marker's fingerprint.
export async function loadSnapshot(storage, timestamp) {
  const marker = parseJson(await storage.readBuffer(markerKey(timestamp)), markerKey(timestamp))
  if (marker.formatVersion !== MANIFEST_FORMAT_VERSION) throw new Error(`Unsupported marker format ${marker.formatVersion}`)
  const manifestBuffer = await storage.readBuffer(snapshotManifestKey(timestamp))
  if (sha256Hex(manifestBuffer) !== marker.manifestSha256) throw new Error(`Manifest of ${timestamp} does not match the hash in its marker`)
  const manifest = parseJson(manifestBuffer, snapshotManifestKey(timestamp))
  const data = await storage.readBuffer(snapshotDataKey(timestamp))
  if (sha256Hex(data) !== manifest.data.sha256 || manifest.data.sha256 !== marker.dataSha256) {
    throw new Error(`data.ndjson.gz of ${timestamp} does not match the hash in its manifest`)
  }
  const documents = parseExportNdjson(gunzipSync(data).toString('utf8'))
  const fingerprint = computeFingerprint(documents)
  if (fingerprint !== marker.fingerprint) throw new Error(`Documents of ${timestamp} do not reproduce the marker fingerprint`)
  return {marker, manifest, documents}
}

// Builds a standard Sanity import tarball from a snapshot:
//   <dataset>-<ts>/data.ndjson, assets.json, images/<sha1>.<ext>, files/<sha1>.<ext>
// Every asset document in the snapshot is included, referenced or not, the
// way `sanity datasets export` includes them.
export async function buildRestoreArchive({storage, timestamp, workDir, tarballPath, allowFailingAssets = false, concurrency = 4, log}) {
  const {marker, manifest, documents} = await loadSnapshot(storage, timestamp)
  const prepared = prepareImportDocuments(documents)
  const rootName = `${marker.dataset}-${timestamp}`
  // A fresh directory per build, so two builds in one work directory never mix files.
  const archiveDir = await mkdtemp(path.join(workDir, 'archive-'))
  const baseDir = path.join(archiveDir, rootName)
  await mkdir(path.join(baseDir, 'images'), {recursive: true})
  await mkdir(path.join(baseDir, 'files'), {recursive: true})

  const assets = prepared.assetDocuments.map((doc) => ({doc, info: describeAssetDocument(doc)}))
  const available = new Set()
  const assetMap = {}
  const sha1Mismatches = []
  await runPool(assets, concurrency, async ({doc, info}) => {
    const destPath = path.join(baseDir, info.kind, `${info.hash}.${info.extension}`)
    const exists = await storage.stat(info.key)
    if (!exists) {
      if (allowFailingAssets) {
        log.warn(`Asset ${info.id} is not in the bucket (${info.key}); the import will skip it (--allow-failing-assets)`)
        return
      }
      throw new Error(`Asset ${info.id} is listed in the snapshot but ${info.key} is not in the bucket`)
    }
    await storage.downloadToFile(info.key, destPath)
    const sha1 = createHash('sha1').update(await readFile(destPath)).digest('hex')
    if (info.sha1hash && sha1 !== info.sha1hash) sha1Mismatches.push(info.id)
    const entry = assetMapEntry(doc)
    if (Object.keys(entry).length > 0) assetMap[`${info.type}-${sha1}`] = entry
    available.add(info.id)
  })
  for (const id of sha1Mismatches) {
    log.warn(`Asset ${id}: stored bytes differ from the document's sha1hash (Sanity rewrites some files, e.g. SVGs). The import uploads the stored bytes.`)
  }

  const missing = [...prepared.referencedAssetIds].filter((id) => !available.has(id)).sort()
  if (missing.length > 0 && !allowFailingAssets) {
    throw new Error(`Documents reference ${missing.length} assets that are not in the snapshot: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`)
  }

  await writeFile(path.join(baseDir, 'data.ndjson'), toNdjson(prepared.importDocuments))
  await writeFile(path.join(baseDir, 'assets.json'), `${JSON.stringify(assetMap)}\n`)
  await mkdir(path.dirname(tarballPath), {recursive: true})
  await pipeline(packTar(archiveDir), createGzip(), createWriteStream(tarballPath, {flags: 'wx'}))

  return {
    marker,
    manifest,
    documents,
    prepared,
    rootName,
    tarballPath,
    assetCount: available.size,
    missingAssetIds: missing,
  }
}

// --exact: which target documents to delete so the target holds the same
// documents as the snapshot. System documents (_.*) are never deleted: Sanity
// manages them, and releases must be archived from the Studio.
export function planExactDeletions({prepared, targetDocuments}) {
  const expectedIds = new Set(prepared.importDocuments.map((doc) => doc._id))
  const expectedAssetIds = new Set(prepared.assetDocuments.map((doc) => doc._id))
  const expectedAssetHashes = new Set(prepared.assetDocuments.map((doc) => doc.sha1hash).filter(Boolean))
  const deleteDocumentIds = []
  const deleteAssetIds = []
  const keptSystemIds = []
  for (const doc of targetDocuments) {
    if (isSystemDocumentId(doc._id)) {
      if (!expectedIds.has(doc._id) && isImportableSystemDocumentId(doc._id)) keptSystemIds.push(doc._id)
      continue
    }
    if (isAssetDocument(doc)) {
      if (!expectedAssetIds.has(doc._id) && !expectedAssetHashes.has(doc.sha1hash)) deleteAssetIds.push(doc._id)
      continue
    }
    if (!expectedIds.has(doc._id)) deleteDocumentIds.push(doc._id)
  }
  return {deleteDocumentIds: deleteDocumentIds.sort(), deleteAssetIds: deleteAssetIds.sort(), keptSystemIds: keptSystemIds.sort()}
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
  return out
}

// _rev and _updatedAt change on every write. _createdAt cannot always be
// reproduced: `sanity datasets import --replace` keeps the target's own value
// for documents that already exist there (documents it creates get the
// snapshot's value), and a re-created release definition gets the time of
// the import. compareWithSnapshot counts those differences separately instead
// of failing on them.
function withoutVolatileFields(doc) {
  const {_rev, _updatedAt, _createdAt, ...rest} = doc
  return rest
}

function firstDifference(a, b, pathSoFar = '') {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return pathSoFar || '(root)'
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of [...keys].sort()) {
    const childPath = Array.isArray(a) ? `${pathSoFar}[${key}]` : `${pathSoFar}${pathSoFar ? '.' : ''}${key}`
    const diff = firstDifference(a[key], b[key], childPath)
    if (diff) return diff
  }
  return null
}

// The fields of an asset document that a restore reproduces: everything
// except ASSET_DERIVED_FIELDS.
export function restorableAssetFields(doc) {
  const fields = {}
  for (const [key, value] of Object.entries(doc)) {
    if (!ASSET_DERIVED_FIELDS.has(key)) fields[key] = value
  }
  return fields
}

// The import matches assets by content: it reuses a target asset document
// with the same sha1hash, and asset ids are content-addressed, so the target
// document normally has the snapshot's id too.
function indexTargetAssets(targetDocuments) {
  const byId = new Map()
  const byHash = new Map()
  for (const doc of targetDocuments) {
    if (!isAssetDocument(doc)) continue
    byId.set(doc._id, doc)
    if (doc.sha1hash) byHash.set(`${doc._type}:${doc.sha1hash}`, doc)
  }
  return (assetDoc) => byId.get(assetDoc._id) ?? byHash.get(`${assetDoc._type}:${assetDoc.sha1hash}`) ?? null
}

// `sanity datasets import` only applies assets.json to assets it uploads.
// An asset that already exists in the target with the same content is reused
// as it is, so its metadata (for example image metadata generated by a newer
// asset pipeline, or an edited title, description or source) would silently
// stay different from the snapshot. With --replace, restore.mjs therefore
// patches every target asset document whose restorable fields differ: it sets
// each differing top-level field to the snapshot's value and unsets
// restorable fields the snapshot does not have.
export function planAssetMetadataPatches({prepared, targetDocuments}) {
  const findTarget = indexTargetAssets(targetDocuments)
  const patches = []
  for (const doc of prepared.assetDocuments) {
    const target = findTarget(doc)
    if (!target) continue
    const expected = restorableAssetFields(doc)
    const actual = restorableAssetFields(target)
    const set = {}
    for (const [key, value] of Object.entries(expected)) {
      if (firstDifference(canonical(value), canonical(actual[key]))) set[key] = value
    }
    const unset = Object.keys(actual).filter((key) => !(key in expected)).sort()
    if (Object.keys(set).length > 0 || unset.length > 0) patches.push({id: target._id, set, unset})
  }
  return patches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Compares the target dataset with the snapshot after an import. Documents are
// compared field by field, ignoring _rev and _updatedAt (plan §10) and
// _createdAt, whose differences are returned separately. Asset documents are
// matched by id or sha1hash and compared on their restorable fields, because
// url, path and uploadId name the dataset and upload the binary belongs to.
export function compareWithSnapshot({documents, prepared, targetDocuments}) {
  const target = new Map(targetDocuments.map((doc) => [doc._id, doc]))
  const missing = []
  const changed = []
  const createdAtDiffers = []
  const original = new Map(documents.map((doc) => [doc._id, doc]))
  for (const doc of prepared.importDocuments) {
    const actual = target.get(doc._id)
    if (!actual) {
      missing.push(doc._id)
      continue
    }
    const snapshotDoc = original.get(doc._id)
    const diff = firstDifference(canonical(withoutVolatileFields(snapshotDoc)), canonical(withoutVolatileFields(actual)))
    if (diff) changed.push({id: doc._id, path: diff})
    if (snapshotDoc._createdAt !== actual._createdAt) createdAtDiffers.push(doc._id)
  }
  const findTarget = indexTargetAssets(targetDocuments)
  const missingAssets = []
  for (const doc of prepared.assetDocuments) {
    const actual = findTarget(doc)
    if (!actual) {
      missingAssets.push(doc._id)
      continue
    }
    const diff = firstDifference(canonical(restorableAssetFields(doc)), canonical(restorableAssetFields(actual)))
    if (diff) changed.push({id: actual._id, path: diff})
  }
  const expectedIds = new Set([...prepared.importDocuments, ...prepared.assetDocuments].map((doc) => doc._id))
  const snapshotAssetKeys = new Set(prepared.assetDocuments.map((doc) => `${doc._type}:${doc.sha1hash}`))
  const extra = targetDocuments
    .filter((doc) => !expectedIds.has(doc._id) && !isSystemDocumentId(doc._id))
    .filter((doc) => !(isAssetDocument(doc) && snapshotAssetKeys.has(`${doc._type}:${doc.sha1hash}`)))
    .map((doc) => doc._id)
  return {missing, changed, missingAssets, extra, createdAtDiffers}
}
