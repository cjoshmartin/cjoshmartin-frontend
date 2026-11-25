import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {LocalStorage} from '../lib/storage/local.mjs'

export const PROJECT_ID = 'testproj'
export const DATASET = 'production'

export function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex')
}

export async function makeTempDir(t, prefix = 'backup-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(dir, {recursive: true, force: true}))
  return dir
}

export function imageAsset(bytes, {width = 4, height = 3, extension = 'png', dataset = DATASET, rev = 'r1'} = {}) {
  const hash = sha1(bytes)
  return {
    _id: `image-${hash}-${width}x${height}-${extension}`,
    _type: 'sanity.imageAsset',
    _rev: rev,
    _createdAt: '2026-11-26T00:00:00Z',
    _updatedAt: '2026-11-26T00:00:00Z',
    assetId: hash,
    extension,
    mimeType: `image/${extension}`,
    originalFilename: `original-${hash.slice(0, 6)}.${extension}`,
    path: `images/${PROJECT_ID}/${dataset}/${hash}-${width}x${height}.${extension}`,
    url: `https://cdn.sanity.io/images/${PROJECT_ID}/${dataset}/${hash}-${width}x${height}.${extension}`,
    sha1hash: hash,
    size: bytes.length,
    uploadId: `upload-${hash.slice(0, 8)}`,
    metadata: {_type: 'sanity.imageMetadata', dimensions: {_type: 'sanity.imageDimensions', width, height, aspectRatio: width / height}},
  }
}

export function fileAsset(bytes, {extension = 'stl', mimeType = 'model/stl', dataset = DATASET, rev = 'r1'} = {}) {
  const hash = sha1(bytes)
  return {
    _id: `file-${hash}-${extension}`,
    _type: 'sanity.fileAsset',
    _rev: rev,
    _createdAt: '2026-11-26T00:00:00Z',
    _updatedAt: '2026-11-26T00:00:00Z',
    assetId: hash,
    extension,
    mimeType,
    originalFilename: `model.${extension}`,
    path: `files/${PROJECT_ID}/${dataset}/${hash}.${extension}`,
    url: `https://cdn.sanity.io/files/${PROJECT_ID}/${dataset}/${hash}.${extension}`,
    sha1hash: hash,
    size: bytes.length,
    uploadId: `upload-${hash.slice(0, 8)}`,
  }
}

export function imageRef(asset, extra = {}) {
  return {_type: 'image', asset: {_type: 'reference', _ref: asset._id}, ...extra}
}

// A small dataset that exercises every kind of document the backup sees:
// system documents, a release with a version, published documents, drafts,
// image and file assets (one unreferenced), and a Mux video document.
export function buildDataset() {
  const binaries = new Map()
  const heroBytes = Buffer.from('hero image bytes')
  const avatarBytes = Buffer.from('avatar image bytes')
  const unusedBytes = Buffer.from('unreferenced image bytes')
  const stlBytes = Buffer.from('solid cube\nendsolid cube\n')
  const hero = imageAsset(heroBytes, {width: 1200, height: 800, extension: 'jpg'})
  const avatar = imageAsset(avatarBytes)
  const unused = imageAsset(unusedBytes, {extension: 'webp'})
  const stl = fileAsset(stlBytes)
  for (const [asset, bytes] of [[hero, heroBytes], [avatar, avatarBytes], [unused, unusedBytes], [stl, stlBytes]]) {
    binaries.set(asset.url, bytes)
  }

  const documents = [
    {_id: '_.groups.administrator', _type: 'system.group', _rev: 'g1', grants: []},
    {_id: '_.retention._maximum_project', _type: 'system.retention', _rev: 'g1', days: 3},
    {_id: '_.releases.rSpring', _type: 'system.release', _rev: 'rel1', name: 'rSpring', metadata: {title: 'Spring'}},
    {_id: 'person-1', _type: 'person', _rev: 'p1', firstName: 'Josh', image: imageRef(avatar, {alt: 'Josh', hotspot: {x: 0.5, y: 0.5}})},
    {
      _id: 'blogPost-7',
      _type: 'blogPost',
      _rev: 'b1',
      title: 'Hello',
      author: {_type: 'reference', _ref: 'person-1'},
      heroMedia: [{_key: 'h1', ...imageRef(hero, {_type: 'imageWithAlt', alt: 'Hero'})}],
      body: [
        {
          _key: 'blk1',
          _type: 'block',
          children: [{_key: 's1', _type: 'span', text: 'Download the model', marks: ['fl1']}],
          markDefs: [{_key: 'fl1', _type: 'fileLink', file: {_type: 'file', asset: {_type: 'reference', _ref: stl._id}}}],
        },
        {_key: 'img1', ...imageRef(hero, {_type: 'imageBlock', alt: 'Inline', layout: 'left'})},
        {_key: 'vid1', _type: 'video', asset: {_type: 'mux.video', asset: {_type: 'reference', _weak: true, _ref: 'mux-video-12'}}},
      ],
      legacy: {wagtailId: 7},
    },
    {_id: 'drafts.blogPost-7', _type: 'blogPost', _rev: 'b2', title: 'Hello (draft)', heroMedia: [{_key: 'h1', ...imageRef(avatar, {_type: 'imageWithAlt'})}]},
    {_id: 'versions.rSpring.blogPost-7', _type: 'blogPost', _rev: 'v1', title: 'Hello (spring release)'},
    {
      _id: 'mux-video-12',
      _type: 'mux.videoAsset',
      _rev: 'm1',
      assetId: 'MuxAsset12abc',
      playbackId: 'Playback12',
      status: 'ready',
      filename: 'clip.mov',
    },
    hero,
    avatar,
    unused,
    stl,
  ]
  return {documents, binaries, assets: {hero, avatar, unused, stl}}
}

// A downloader that serves binaries from memory and records every call.
export function fakeAssetDownloader(binaries) {
  const calls = []
  async function download(asset, destPath) {
    calls.push(asset.id)
    const bytes = binaries.get(asset.url)
    if (!bytes) throw new Error(`fake downloader has no bytes for ${asset.url}`)
    await mkdir(path.dirname(destPath), {recursive: true})
    await writeFile(destPath, bytes, {flag: 'wx'})
    return {size: bytes.length, sha1: sha1(bytes), verifiedBy: 'sha1hash'}
  }
  download.calls = calls
  return download
}

export function fakeMuxArchiver({unavailable = new Map()} = {}) {
  const calls = []
  return {
    calls,
    async inspect(assetId) {
      calls.push(`inspect:${assetId}`)
      if (unavailable.has(assetId)) return {available: false, reason: unavailable.get(assetId)}
      return {available: true, status: 'ready', masterAccess: 'none'}
    },
    async downloadOriginal(assetId, destPath) {
      calls.push(`download:${assetId}`)
      if (unavailable.has(assetId)) return {status: 'unavailable', reason: unavailable.get(assetId)}
      const bytes = Buffer.from(`mp4 master of ${assetId}`)
      await mkdir(path.dirname(destPath), {recursive: true})
      await writeFile(destPath, bytes, {flag: 'wx'})
      return {
        status: 'downloaded',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        extension: 'mp4',
        method: 'master-access',
        details: {durationSeconds: 12.5, resolutionTier: '1080p', maxResolutionTier: '1080p', videoQuality: 'basic'},
      }
    },
  }
}

// Wraps a storage adapter and records every create call in order.
export function recordingStorage(inner) {
  const writes = []
  return {
    writes,
    describe: () => inner.describe(),
    list: (prefix) => inner.list(prefix),
    stat: (key) => inner.stat(key),
    readBuffer: (key) => inner.readBuffer(key),
    downloadToFile: (key, dest) => inner.downloadToFile(key, dest),
    async createFromBuffer(key, buffer, options) {
      writes.push(key)
      return inner.createFromBuffer(key, buffer, options)
    },
    async createFromFile(key, srcPath, options) {
      writes.push(key)
      return inner.createFromFile(key, srcPath, options)
    },
  }
}

export function quietLog() {
  const messages = {info: [], warn: []}
  return {
    messages,
    info: (message) => messages.info.push(message),
    warn: (message) => messages.warn.push(message),
    error: (message) => messages.warn.push(message),
  }
}

export async function newLocalStorage(t) {
  const dir = await makeTempDir(t, 'backup-bucket-')
  return {dir, storage: new LocalStorage(dir)}
}

// A clock that advances one minute per call, starting at a fixed time.
export function steppingClock(start = '2026-11-29T09:00:00.000Z') {
  let current = new Date(start).getTime()
  return () => {
    const value = new Date(current)
    current += 60_000
    return value
  }
}
