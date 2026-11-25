// Object names used in the backup bucket. Plan §10 defines this layout:
//
//   snapshots/<ts>/data.ndjson.gz   full raw export, documents only
//   snapshots/<ts>/manifest.json    fingerprint, counts, asset list, Mux list
//   assets/images/<sha1>.<ext>      each Sanity image, stored once
//   assets/files/<sha1>.<ext>       each Sanity file, stored once
//   assets/mux/<muxAssetId>.<ext>   original of each mux.videoAsset, stored once
//   markers/<ts>.json               written last; the newest name is the latest snapshot
//
// <ts> is an ISO 8601 basic-format UTC timestamp (20261129T090000Z). It sorts
// lexicographically in time order and is safe in object names and file paths.

export const SNAPSHOTS_PREFIX = 'snapshots/'
export const MARKERS_PREFIX = 'markers/'
export const ASSETS_PREFIX = 'assets/'
export const MUX_PREFIX = 'assets/mux/'

const TIMESTAMP_PATTERN = /^\d{8}T\d{6}Z$/

export function formatTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('formatTimestamp needs a valid Date')
  }
  // 2026-11-29T09:00:00.123Z -> 20261129T090000Z
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '')
}

export function isTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value)
}

export function timestampToIso(ts) {
  if (!isTimestamp(ts)) throw new Error(`Not a backup timestamp: ${ts}`)
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`
}

export function snapshotPrefix(ts) {
  if (!isTimestamp(ts)) throw new Error(`Not a backup timestamp: ${ts}`)
  return `${SNAPSHOTS_PREFIX}${ts}/`
}

export function snapshotDataKey(ts) {
  return `${snapshotPrefix(ts)}data.ndjson.gz`
}

export function snapshotManifestKey(ts) {
  return `${snapshotPrefix(ts)}manifest.json`
}

export function markerKey(ts) {
  if (!isTimestamp(ts)) throw new Error(`Not a backup timestamp: ${ts}`)
  return `${MARKERS_PREFIX}${ts}.json`
}

// Returns the timestamp for a well-formed marker key, or null for anything else.
export function timestampFromMarkerKey(key) {
  if (typeof key !== 'string' || !key.startsWith(MARKERS_PREFIX) || !key.endsWith('.json')) {
    return null
  }
  const ts = key.slice(MARKERS_PREFIX.length, -'.json'.length)
  return isTimestamp(ts) ? ts : null
}

// kind is "images" or "files"; hash is the 40-char hex sha1 from the asset id.
export function sanityAssetKey(kind, hash, extension) {
  if (kind !== 'images' && kind !== 'files') throw new Error(`Unknown asset kind: ${kind}`)
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error(`Not a sha1 hex digest: ${hash}`)
  if (!/^[a-z0-9]+$/i.test(extension)) throw new Error(`Unsafe file extension: ${extension}`)
  return `${ASSETS_PREFIX}${kind}/${hash}.${extension}`
}

export function muxAssetKey(muxAssetId, extension) {
  // Mux asset ids are alphanumeric. Refuse anything that could escape the prefix.
  if (!/^[A-Za-z0-9]+$/.test(muxAssetId)) throw new Error(`Unexpected Mux asset id: ${muxAssetId}`)
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error(`Unsafe file extension: ${extension}`)
  return `${MUX_PREFIX}${muxAssetId}.${extension}`
}
