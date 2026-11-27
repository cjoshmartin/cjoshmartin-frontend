import {fetchWithRetry, HttpError, saveResponseToFile} from './http.mjs'
import {sanityAssetKey} from './layout.mjs'

// Sanity asset document ids are content-addressed:
//   image-<sha1>-<width>x<height>-<ext>   (sanity.imageAsset)
//   file-<sha1>-<ext>                     (sanity.fileAsset)
// A file's extension comes from its upload's file name. Every id seen so far is
// lowercase, but videos are often named IMG_0169.MOV or clip.MP4 and Sanity's
// docs do not say the extension is lowercased, so file ids accept either case:
// an id this parser rejected would fail every backup and break the restore.
const IMAGE_ID_PATTERN = /^image-([a-f0-9]{40})-(\d+x\d+)-([a-z0-9]+)$/
const FILE_ID_PATTERN = /^file-([a-f0-9]{40})-([A-Za-z0-9]+)$/

export const IMAGE_ASSET_TYPE = 'sanity.imageAsset'
export const FILE_ASSET_TYPE = 'sanity.fileAsset'

// A download, body included, must finish within this time: 5 minutes plus one
// second per 512 KiB of the asset's size, so a large video file still gets
// through on a slow connection (a 40 MB original gets 6 min 17 s, a 1 GiB
// file 39 min 8 s). The workflow's own limit is 90 minutes.
export const BASE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const MIN_DOWNLOAD_BYTES_PER_SECOND = 512 * 1024

export function downloadTimeoutMs(size) {
  const extraSeconds = Number.isFinite(size) && size > 0 ? Math.ceil(size / MIN_DOWNLOAD_BYTES_PER_SECOND) : 0
  return BASE_DOWNLOAD_TIMEOUT_MS + extraSeconds * 1000
}

export function isAssetDocument(doc) {
  return doc?._type === IMAGE_ASSET_TYPE || doc?._type === FILE_ASSET_TYPE
}

// Parses an asset id or reference. Returns null for anything that is not a
// standard Sanity image or file asset id.
export function parseAssetId(id) {
  if (typeof id !== 'string') return null
  const image = IMAGE_ID_PATTERN.exec(id)
  if (image) return {type: 'image', kind: 'images', hash: image[1], extension: image[3]}
  const file = FILE_ID_PATTERN.exec(id)
  if (file) return {type: 'file', kind: 'files', hash: file[1], extension: file[2]}
  return null
}

// File name used both in the bucket (assets/<kind>/<name>) and inside a
// restore tarball (<kind>/<name>).
export function assetFileName(id) {
  const parsed = parseAssetId(id)
  if (!parsed) throw new Error(`Not a Sanity asset id: ${id}`)
  return `${parsed.hash}.${parsed.extension}`
}

export function describeAssetDocument(doc) {
  const parsed = parseAssetId(doc._id)
  if (!parsed) throw new Error(`Asset document ${doc._id} does not have a standard content-addressed id`)
  const expectedType = parsed.type === 'image' ? IMAGE_ASSET_TYPE : FILE_ASSET_TYPE
  if (doc._type !== expectedType) {
    throw new Error(`Asset document ${doc._id} has type ${doc._type}, expected ${expectedType}`)
  }
  if (typeof doc.url !== 'string' || doc.url === '') {
    throw new Error(`Asset document ${doc._id} has no url, so its binary cannot be downloaded`)
  }
  return {
    id: doc._id,
    type: parsed.type,
    kind: parsed.kind,
    hash: parsed.hash,
    extension: parsed.extension,
    key: sanityAssetKey(parsed.kind, parsed.hash, parsed.extension),
    url: doc.url,
    size: typeof doc.size === 'number' ? doc.size : null,
    sha1hash: typeof doc.sha1hash === 'string' ? doc.sha1hash : null,
    mimeType: typeof doc.mimeType === 'string' ? doc.mimeType : null,
  }
}

// True for a described video file asset: the MP4 a video block plays, or the
// original upload it keeps. Videos are backed up like every other file; this
// only feeds the counts in the log.
export function isVideoAsset(asset) {
  return asset.type === 'file' && typeof asset.mimeType === 'string' && asset.mimeType.startsWith('video/')
}

// Images on cdn.sanity.io are requested with dlRaw=true and the token, the
// same way @sanity/export downloads them, so the original bytes come back
// rather than a processed rendition.
export function assetDownloadRequest(asset, token) {
  const url = new URL(asset.url)
  const headers = {'Accept-Encoding': 'identity'}
  const isSanityCdn = url.hostname === 'cdn.sanity.io' || url.hostname === 'cdn.sanity.work'
  if (asset.type === 'image' && isSanityCdn) {
    url.searchParams.set('dlRaw', 'true')
    if (token) headers.Authorization = `Bearer ${token}`
  }
  return {url: url.toString(), headers}
}

// Downloads one asset binary to destPath and checks it. The bytes are accepted
// when their sha1 equals the asset document's sha1hash, or when the CDN's
// x-sanity-sha1 / x-sanity-md5 headers vouch for them (Sanity rewrites some
// files after hashing, for example SVG sanitization). Anything else throws,
// because a snapshot must never contain a corrupt or truncated asset.
export async function downloadSanityAsset({asset, token, destPath, fetchImpl, timeoutMs = downloadTimeoutMs(asset.size)}) {
  const {url, headers} = assetDownloadRequest(asset, token)
  let response
  try {
    response = await fetchWithRetry(url, {label: `Download of asset ${asset.id}`, fetchImpl, headers, timeoutMs})
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
      throw new Error(
        `The binary for asset ${asset.id} is missing on the Sanity CDN (HTTP ${error.status}). ` +
          'The backup refuses to write a snapshot with a missing asset. Re-upload the file in the Studio, ' +
          'or delete the asset document if nothing uses it, then run the backup again.',
        {cause: error},
      )
    }
    throw error
  }
  const result = await saveResponseToFile(response, destPath, {label: `Download of asset ${asset.id}`})
  const headerSha1 = response.headers.get('x-sanity-sha1')
  const headerMd5 = response.headers.get('x-sanity-md5')
  let verifiedBy
  if (asset.sha1hash && result.sha1 === asset.sha1hash) verifiedBy = 'sha1hash'
  else if (headerSha1 && result.sha1 === headerSha1) verifiedBy = 'cdn-sha1-header'
  else if (headerMd5 && result.md5 === headerMd5) verifiedBy = 'cdn-md5-header'
  else {
    throw new Error(
      `Asset ${asset.id} failed verification: downloaded sha1 ${result.sha1} matches neither the document's ` +
        `sha1hash (${asset.sha1hash ?? 'missing'}) nor the CDN's hash headers`,
    )
  }
  return {...result, verifiedBy}
}
