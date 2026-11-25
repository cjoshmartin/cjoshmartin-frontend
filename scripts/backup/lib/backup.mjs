import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import {gzipSync} from 'node:zlib'

import {countDocuments, sortById, toNdjson} from './documents.mjs'
import {computeFingerprint, FINGERPRINT_ALGORITHM} from './fingerprint.mjs'
import {
  formatTimestamp,
  markerKey,
  muxAssetKey,
  snapshotDataKey,
  snapshotManifestKey,
  snapshotPrefix,
  timestampFromMarkerKey,
  timestampToIso,
} from './layout.mjs'
import {MUX_METHOD, MUX_ORIGINAL_EXTENSION} from './mux.mjs'
import {describeAssetDocument, isAssetDocument} from './sanity-assets.mjs'
import {createBufferOnce, createFileOnce, formatBytes, runPool, sha256Hex} from './util.mjs'

export const MANIFEST_FORMAT_VERSION = 1
// "Fail if the bucket is larger than 4 GB" (plan §10). GCS bills in binary
// gigabytes, and the free tier is 5 GB-months, so the limit is 4 GiB.
export const DEFAULT_MAX_BUCKET_BYTES = 4 * 1024 ** 3
export const MUX_VIDEO_ASSET_TYPE = 'mux.videoAsset'

export class BucketTooLargeError extends Error {
  constructor(bytes, limit, when) {
    super(`The backup bucket holds ${formatBytes(bytes)} ${when}, which is over the ${formatBytes(limit)} limit. ` +
      'Review the bucket contents and either raise --max-bucket-bytes or move old snapshots elsewhere.')
    this.name = 'BucketTooLargeError'
    this.bytes = bytes
    this.limit = limit
  }
}

function parseMarker(buffer, key) {
  let marker
  try {
    marker = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw new Error(`Marker ${key} is not valid JSON: ${error.message}`)
  }
  if (!marker || typeof marker.fingerprint !== 'string' || typeof marker.dataset !== 'string' || typeof marker.projectId !== 'string') {
    throw new Error(`Marker ${key} is missing fingerprint, dataset or projectId`)
  }
  return marker
}

// Finds the newest marker (by lexicographic name, which is time order) that
// belongs to this project and dataset. Markers are small, and normally the
// newest one matches, so this usually reads a single object.
export async function findLatestMarker(storage, keys, {projectId, dataset} = {}) {
  const timestamps = keys.map(timestampFromMarkerKey).filter(Boolean).sort()
  for (let index = timestamps.length - 1; index >= 0; index--) {
    const timestamp = timestamps[index]
    const key = markerKey(timestamp)
    const marker = parseMarker(await storage.readBuffer(key), key)
    if (projectId !== undefined && marker.projectId !== projectId) continue
    if (dataset !== undefined && marker.dataset !== dataset) continue
    return {timestamp, key, marker}
  }
  return null
}

function planAssets(documents, existing) {
  const byKey = new Map()
  for (const doc of documents) {
    if (!isAssetDocument(doc)) continue
    const asset = describeAssetDocument(doc)
    const known = byKey.get(asset.key)
    if (known) {
      known.ids.push(asset.id)
      continue
    }
    byKey.set(asset.key, {...asset, ids: [asset.id], present: existing.has(asset.key)})
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
}

function planMux(documents, existing) {
  const byAssetId = new Map()
  const unavailable = []
  for (const doc of documents) {
    if (doc._type !== MUX_VIDEO_ASSET_TYPE) continue
    const assetId = typeof doc.assetId === 'string' && doc.assetId !== '' ? doc.assetId : null
    if (!assetId) {
      unavailable.push({
        documentIds: [doc._id],
        assetId: null,
        playbackId: doc.playbackId ?? null,
        key: null,
        status: 'unavailable',
        reason: 'The document has no Mux assetId (the upload never finished)',
      })
      continue
    }
    const known = byAssetId.get(assetId)
    if (known) {
      known.documentIds.push(doc._id)
      continue
    }
    const key = muxAssetKey(assetId, MUX_ORIGINAL_EXTENSION)
    byAssetId.set(assetId, {
      documentIds: [doc._id],
      assetId,
      playbackId: doc.playbackId ?? null,
      key,
      present: existing.has(key),
    })
  }
  const items = [...byAssetId.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))
  return {items, unavailable}
}

// One backup run (plan §10, "Run logic"):
//   1. fingerprint the export, 2. compare with the newest marker and stop if it
//   matches, 3. upload missing assets and Mux originals, then the snapshot
//   files, then the marker, 4. check the bucket size.
// Every write is create-only. Nothing is ever deleted or replaced.
export async function runBackup({
  projectId,
  dataset,
  storage,
  exportDocuments,
  downloadAsset,
  muxArchiver,
  now = () => new Date(),
  tmpDir,
  log,
  dryRun = false,
  maxBucketBytes = DEFAULT_MAX_BUCKET_BYTES,
  concurrency = 4,
  tool = {name: 'cjoshmartin-sanity-backup', version: 'unknown'},
}) {
  const warnings = []
  const warn = (message) => {
    warnings.push(message)
    log.warn(message)
  }

  log.info(`Backing up ${projectId}/${dataset} to ${storage.describe()}${dryRun ? ' (dry run: nothing is written)' : ''}`)
  const listing = await storage.list('')
  const existing = new Map(listing.map((object) => [object.key, object.size]))
  const startBytes = listing.reduce((sum, object) => sum + object.size, 0)
  log.info(`Bucket holds ${listing.length} objects, ${formatBytes(startBytes)}`)
  if (startBytes > maxBucketBytes) throw new BucketTooLargeError(startBytes, maxBucketBytes, 'before this run')

  const documents = await exportDocuments()
  const fingerprint = computeFingerprint(documents)
  const counts = countDocuments(documents)
  log.info(
    `Exported ${counts.total} documents (${counts.published} published, ${counts.drafts} drafts, ` +
      `${counts.versions} release versions, ${counts.system} system); fingerprint ${fingerprint}`,
  )

  const markerKeys = listing.map((object) => object.key).filter((key) => timestampFromMarkerKey(key) !== null)
  const previous = await findLatestMarker(storage, markerKeys, {projectId, dataset})
  if (previous) {
    const previousData = snapshotDataKey(previous.timestamp)
    if (!existing.has(previousData) || !existing.has(snapshotManifestKey(previous.timestamp))) {
      throw new Error(`Marker ${previous.key} exists but its snapshot files are missing from the bucket`)
    }
    log.info(`Newest snapshot for this dataset: ${previous.timestamp} (fingerprint ${previous.marker.fingerprint})`)
  } else {
    log.info('No earlier snapshot for this dataset')
  }

  if (previous && previous.marker.fingerprint === fingerprint) {
    log.info(`No changes since snapshot ${previous.timestamp}; nothing written`)
    return {status: 'no-change', fingerprint, previousTimestamp: previous.timestamp, counts, bucketBytes: startBytes, warnings}
  }

  const timestamp = formatTimestamp(now())
  const newestTimestamp = markerKeys.map(timestampFromMarkerKey).sort().at(-1)
  if (newestTimestamp && timestamp <= newestTimestamp) {
    throw new Error(`The clock says ${timestamp}, which is not after the newest marker ${newestTimestamp}; refusing to write an out-of-order snapshot`)
  }
  if (listing.some((object) => object.key.startsWith(snapshotPrefix(timestamp)))) {
    throw new Error(`Objects already exist under ${snapshotPrefix(timestamp)}; refusing to mix snapshots`)
  }

  const assets = planAssets(documents, existing)
  const assetsToStore = assets.filter((asset) => !asset.present)
  const mux = planMux(documents, existing)
  const muxToStore = mux.items.filter((item) => !item.present)
  for (const item of mux.unavailable) warn(`Mux video ${item.documentIds.join(', ')}: ${item.reason}`)

  const assetBytesEstimate = assetsToStore.reduce((sum, asset) => sum + (asset.size ?? 0), 0)
  log.info(
    `Assets: ${assets.length} in the dataset, ${assetsToStore.length} not yet in the bucket (about ${formatBytes(assetBytesEstimate)}); ` +
      `Mux videos: ${mux.items.length}, ${muxToStore.length} originals not yet in the bucket`,
  )

  if (dryRun) {
    const muxPlan = []
    for (const item of muxToStore) {
      if (!muxArchiver) {
        muxPlan.push({assetId: item.assetId, key: item.key, check: 'skipped: MUX_TOKEN_ID / MUX_TOKEN_SECRET not set'})
        continue
      }
      const inspection = await muxArchiver.inspect(item.assetId)
      if (!inspection.available) warn(`Mux asset ${item.assetId}: ${inspection.reason}`)
      muxPlan.push({assetId: item.assetId, key: item.key, check: inspection.available ? `status ${inspection.status}` : inspection.reason})
    }
    const plan = {
      timestamp,
      writes: [
        ...assetsToStore.map((asset) => asset.key),
        ...muxToStore.map((item) => item.key),
        snapshotDataKey(timestamp),
        snapshotManifestKey(timestamp),
        markerKey(timestamp),
      ],
      mux: muxPlan,
    }
    log.info(`Dry run: a real run would write ${plan.writes.length} objects, ending with ${markerKey(timestamp)}`)
    return {status: 'dry-run', fingerprint, previousTimestamp: previous?.timestamp ?? null, counts, bucketBytes: startBytes, plan, warnings}
  }

  if (muxToStore.length > 0 && !muxArchiver) {
    throw new Error(`${muxToStore.length} Mux video originals are not in the bucket yet; set MUX_TOKEN_ID and MUX_TOKEN_SECRET`)
  }

  const workDir = await mkdtemp(path.join(tmpDir, 'sanity-backup-'))
  try {
    let writtenBytes = 0

    await runPool(assetsToStore, concurrency, async (asset) => {
      const localPath = path.join(workDir, asset.kind, `${asset.hash}.${asset.extension}`)
      const downloaded = await downloadAsset(asset, localPath)
      const created = await createFileOnce(storage, asset.key, localPath, downloaded.size, {
        contentType: asset.mimeType ?? 'application/octet-stream',
        metadata: {sanityAssetId: asset.id, sha1: downloaded.sha1},
      })
      if (created) writtenBytes += downloaded.size
      asset.size = downloaded.size
      asset.verifiedBy = downloaded.verifiedBy
      asset.storedThisRun = created
      await rm(localPath)
      log.info(`${created ? 'Stored' : 'Already present'}: ${asset.key} (${formatBytes(downloaded.size)})`)
    })

    for (const item of mux.items) {
      if (item.present) {
        item.status = 'stored'
        item.size = existing.get(item.key)
        item.storedThisRun = false
        continue
      }
      const localPath = path.join(workDir, 'mux', `${item.assetId}.${MUX_ORIGINAL_EXTENSION}`)
      log.info(`Archiving the Mux original of ${item.assetId} (${item.documentIds.join(', ')})`)
      const result = await muxArchiver.downloadOriginal(item.assetId, localPath)
      if (result.status === 'unavailable') {
        item.status = 'unavailable'
        item.reason = result.reason
        warn(`Mux asset ${item.assetId} (${item.documentIds.join(', ')}): ${result.reason}`)
        continue
      }
      const created = await createFileOnce(storage, item.key, localPath, result.size, {
        contentType: 'video/mp4',
        metadata: {muxAssetId: item.assetId, sha256: result.sha256},
      })
      if (created) writtenBytes += result.size
      Object.assign(item, {status: 'stored', storedThisRun: created, size: result.size, sha256: result.sha256, details: result.details})
      await rm(localPath)
      log.info(`${created ? 'Stored' : 'Already present'}: ${item.key} (${formatBytes(result.size)})`)
    }

    const ndjson = Buffer.from(toNdjson(sortById(documents)), 'utf8')
    const data = gzipSync(ndjson, {level: 9})
    const dataKey = snapshotDataKey(timestamp)
    const manifestKey = snapshotManifestKey(timestamp)
    const manifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      timestamp,
      createdAt: timestampToIso(timestamp),
      projectId,
      dataset,
      previousTimestamp: previous?.timestamp ?? null,
      fingerprint: {algorithm: FINGERPRINT_ALGORITHM, value: fingerprint},
      documents: counts,
      data: {key: dataKey, sha256: sha256Hex(data), bytes: data.length, uncompressedBytes: ndjson.length},
      assets: assets.map((asset) => ({
        ids: asset.ids,
        type: asset.type,
        key: asset.key,
        size: asset.present ? existing.get(asset.key) : asset.size,
        sha1hash: asset.sha1hash,
        mimeType: asset.mimeType,
        storedThisRun: asset.present ? false : asset.storedThisRun,
        ...(asset.verifiedBy ? {verifiedBy: asset.verifiedBy} : {}),
      })),
      mux: {
        method: MUX_METHOD,
        extension: MUX_ORIGINAL_EXTENSION,
        items: [
          ...mux.items.map(({present, ...item}) => item),
          ...mux.unavailable,
        ],
      },
      warnings,
      tool: {...tool, node: process.version},
    }
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const marker = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      timestamp,
      createdAt: manifest.createdAt,
      projectId,
      dataset,
      fingerprint,
      documentCount: counts.total,
      snapshot: snapshotPrefix(timestamp),
      dataSha256: manifest.data.sha256,
      manifestSha256: sha256Hex(manifestBuffer),
      warningCount: warnings.length,
    }
    const markerBuffer = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8')

    if (await createBufferOnce(storage, dataKey, data, {contentType: 'application/gzip'})) writtenBytes += data.length
    if (await createBufferOnce(storage, manifestKey, manifestBuffer, {contentType: 'application/json'})) writtenBytes += manifestBuffer.length
    // The marker is written last: a snapshot without a marker is incomplete.
    if (await createBufferOnce(storage, markerKey(timestamp), markerBuffer, {contentType: 'application/json'})) writtenBytes += markerBuffer.length
    log.info(`Snapshot ${timestamp} complete: ${dataKey} (${formatBytes(data.length)}), ${manifestKey}, ${markerKey(timestamp)}`)

    const bucketBytes = startBytes + writtenBytes
    log.info(`Wrote ${formatBytes(writtenBytes)}; the bucket now holds ${formatBytes(bucketBytes)}`)
    if (bucketBytes > maxBucketBytes) throw new BucketTooLargeError(bucketBytes, maxBucketBytes, 'after this run')

    return {
      status: 'snapshot',
      timestamp,
      fingerprint,
      previousTimestamp: previous?.timestamp ?? null,
      counts,
      bucketBytes,
      writtenBytes,
      storedAssets: assets.filter((asset) => asset.storedThisRun).length,
      storedMux: mux.items.filter((item) => item.storedThisRun).length,
      warnings,
    }
  } finally {
    await rm(workDir, {recursive: true, force: true})
  }
}
