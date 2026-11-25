// Tests for the code that talks to Sanity and Mux, using fake fetch functions.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {test} from 'node:test'

import {fetchWithRetry, HttpError} from '../lib/http.mjs'
import {createMuxArchiver, MuxClient} from '../lib/mux.mjs'
import {assetDownloadRequest, describeAssetDocument, downloadSanityAsset, parseAssetId} from '../lib/sanity-assets.mjs'
import {exportDataset, parseExportNdjson} from '../lib/sanity-export.mjs'
import {fileAsset, imageAsset, makeTempDir} from './helpers.mjs'

const noSleep = async () => {}

function respond(body, {status = 200, headers = {}} = {}) {
  return new Response(body, {status, headers})
}

test('export parsing returns every document and rejects error, cursor and malformed lines', () => {
  const docs = parseExportNdjson('{"_id":"a","_type":"t","_rev":"1"}\n\n{"_id":"drafts.a","_type":"t","_rev":"2","error":"a field named error is fine"}\n')
  assert.deepEqual(docs.map((doc) => doc._id), ['a', 'drafts.a'])
  assert.throws(
    () => parseExportNdjson('{"_id":"a","_type":"t","_rev":"1"}\n{"error":{"description":"Internal server error","type":"internalError"}}\n'),
    /ended with an error \(internalError\): Internal server error/,
  )
  assert.throws(() => parseExportNdjson('{"nextCursor":"abc"}\n'), /cursor/)
  assert.throws(() => parseExportNdjson('{"_id":"a","_type":"t"\n'), /line 1 is not valid JSON/)
  assert.throws(() => parseExportNdjson('{"_type":"t"}\n'), /no string _id/)
})

test('exportDataset calls the Export API with the token and a current API version', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({url, init})
    return respond('{"_id":"a","_type":"t","_rev":"1"}\n')
  }
  const docs = await exportDataset({projectId: 'j3vdh6ti', dataset: 'production', token: 'tok', fetchImpl})
  assert.equal(docs.length, 1)
  assert.equal(requests[0].url, 'https://j3vdh6ti.api.sanity.io/v2025-02-19/data/export/production?tag=sanity.backup')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer tok')

  await assert.rejects(exportDataset({projectId: 'j3vdh6ti', dataset: 'production', token: '', fetchImpl}), /Viewer role/)
  await assert.rejects(exportDataset({projectId: 'J3!', dataset: 'production', token: 't', fetchImpl}), /Invalid Sanity project id/)
  await assert.rejects(
    exportDataset({projectId: 'j3vdh6ti', dataset: 'production', token: 'bad', fetchImpl: async () => respond('{"error":"Unauthorized"}', {status: 401})}),
    (error) => error instanceof HttpError && error.status === 401,
  )
})

test('fetchWithRetry retries 5xx and network errors but not other 4xx', async () => {
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    if (calls === 2) return respond('busy', {status: 503})
    return respond('ok')
  }
  const response = await fetchWithRetry('https://example.test/x', {fetchImpl: flaky, sleep: noSleep})
  assert.equal(await response.text(), 'ok')
  assert.equal(calls, 3)

  let forbiddenCalls = 0
  await assert.rejects(
    fetchWithRetry('https://example.test/secret?signature=abc', {
      label: 'Thing',
      fetchImpl: async () => {
        forbiddenCalls++
        return respond('nope', {status: 403})
      },
      sleep: noSleep,
    }),
    (error) => error.status === 403 && !error.message.includes('signature'),
  )
  assert.equal(forbiddenCalls, 1)
})

test('asset ids parse into kind, hash and extension; images use dlRaw with the token', () => {
  const image = imageAsset(Buffer.from('i'), {extension: 'jpg'})
  const file = fileAsset(Buffer.from('f'), {extension: 'mp3'})
  assert.deepEqual(parseAssetId(image._id), {type: 'image', kind: 'images', hash: image.sha1hash, extension: 'jpg'})
  assert.deepEqual(parseAssetId(file._id), {type: 'file', kind: 'files', hash: file.sha1hash, extension: 'mp3'})
  assert.equal(parseAssetId('mux-video-12'), null)
  assert.equal(describeAssetDocument(file).key, `assets/files/${file.sha1hash}.mp3`)
  assert.throws(() => describeAssetDocument({...image, url: undefined}), /has no url/)
  assert.throws(() => describeAssetDocument({...image, _type: 'sanity.fileAsset'}), /expected sanity.imageAsset/)

  const imageRequest = assetDownloadRequest(describeAssetDocument(image), 'tok')
  assert.equal(new URL(imageRequest.url).searchParams.get('dlRaw'), 'true')
  assert.equal(imageRequest.headers.Authorization, 'Bearer tok')
  const fileRequest = assetDownloadRequest(describeAssetDocument(file), 'tok')
  assert.equal(fileRequest.url, file.url)
  assert.equal(fileRequest.headers.Authorization, undefined)
})

test('asset downloads are verified against sha1hash, CDN hash headers, and Content-Length', async (t) => {
  const dir = await makeTempDir(t)
  const bytes = Buffer.from('real image bytes')
  const asset = describeAssetDocument(imageAsset(bytes))

  const ok = await downloadSanityAsset({asset, token: 't', destPath: path.join(dir, 'a'), fetchImpl: async () => respond(bytes)})
  assert.equal(ok.verifiedBy, 'sha1hash')
  assert.deepEqual(await readFile(path.join(dir, 'a')), bytes)

  // Sanitized SVG case: bytes differ from sha1hash but the CDN vouches for them.
  const sanitized = Buffer.from('sanitized bytes')
  const sanitizedSha1 = createHash('sha1').update(sanitized).digest('hex')
  const viaHeader = await downloadSanityAsset({
    asset,
    destPath: path.join(dir, 'b'),
    fetchImpl: async () => respond(sanitized, {headers: {'x-sanity-sha1': sanitizedSha1}}),
  })
  assert.equal(viaHeader.verifiedBy, 'cdn-sha1-header')

  await assert.rejects(
    downloadSanityAsset({asset, destPath: path.join(dir, 'c'), fetchImpl: async () => respond(Buffer.from('corrupt'))}),
    /failed verification/,
  )
  await assert.rejects(
    downloadSanityAsset({asset, destPath: path.join(dir, 'd'), fetchImpl: async () => respond(bytes, {headers: {'content-length': String(bytes.length + 10)}})}),
    /expected \d+ bytes, received/,
  )
  await assert.rejects(
    downloadSanityAsset({asset, destPath: path.join(dir, 'e'), fetchImpl: async () => respond('gone', {status: 404})}),
    /missing on the Sanity CDN \(HTTP 404\)/,
  )
})

// A fake Mux API: the asset starts with master access off, the PUT turns it
// on, and the master becomes ready after `pollsUntilReady` GETs.
function fakeMux({status = 'ready', pollsUntilReady = 2, masterBytes = Buffer.from('MP4 master'), exists = true, masterStatus = 'ready'} = {}) {
  const log = []
  let masterAccess = 'none'
  let pollsSinceEnable = 0
  const asset = () => ({
    id: 'Abc123',
    status,
    duration: 12.5,
    resolution_tier: '1080p',
    max_resolution_tier: '1080p',
    video_quality: 'basic',
    master_access: masterAccess,
    ...(masterAccess === 'temporary'
      ? {master: pollsSinceEnable >= pollsUntilReady ? {status: masterStatus, ...(masterStatus === 'ready' ? {url: 'https://mezzanine.mux.example/Abc123/mezzanine.mp4?signature=s'} : {})} : {status: 'preparing'}}
      : {}),
  })
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    log.push(`${method} ${url.split('?')[0]}`)
    if (url.startsWith('https://mezzanine.mux.example/')) return respond(masterBytes)
    assert.match(init.headers.Authorization, /^Basic /)
    if (!exists) return respond('{"error":{"type":"not_found"}}', {status: 404})
    if (method === 'PUT') {
      assert.deepEqual(JSON.parse(init.body), {master_access: 'temporary'})
      masterAccess = 'temporary'
      return respond(JSON.stringify({data: asset()}))
    }
    if (masterAccess === 'temporary') pollsSinceEnable++
    return respond(JSON.stringify({data: asset()}))
  }
  return {fetchImpl, log}
}

function archiverFor(fake, options = {}) {
  let clock = 0
  const sleeps = []
  const archiver = createMuxArchiver({
    client: new MuxClient({tokenId: 'id', tokenSecret: 'secret', fetchImpl: fake.fetchImpl, sleep: noSleep}),
    fetchImpl: fake.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    pollIntervalMs: 5_000,
    timeoutMs: 60_000,
    ...options,
  })
  return {archiver, sleeps}
}

test('Mux originals: enable temporary master access, poll until ready, download the MP4', async (t) => {
  const dir = await makeTempDir(t)
  const fake = fakeMux()
  const {archiver, sleeps} = archiverFor(fake)
  const result = await archiver.downloadOriginal('Abc123', path.join(dir, 'Abc123.mp4'))
  assert.equal(result.status, 'downloaded')
  assert.equal(result.method, 'master-access')
  assert.equal(result.extension, 'mp4')
  assert.equal(result.sha256, createHash('sha256').update('MP4 master').digest('hex'))
  assert.deepEqual(result.details, {durationSeconds: 12.5, resolutionTier: '1080p', maxResolutionTier: '1080p', videoQuality: 'basic'})
  assert.equal(await readFile(path.join(dir, 'Abc123.mp4'), 'utf8'), 'MP4 master')
  assert.deepEqual(fake.log, [
    'GET https://api.mux.com/video/v1/assets/Abc123',
    'PUT https://api.mux.com/video/v1/assets/Abc123/master-access',
    'GET https://api.mux.com/video/v1/assets/Abc123',
    'GET https://api.mux.com/video/v1/assets/Abc123',
    'GET https://mezzanine.mux.example/Abc123/mezzanine.mp4',
  ])
  assert.deepEqual(sleeps, [5_000])
})

test('Mux originals: a master that never becomes ready times out', async (t) => {
  const dir = await makeTempDir(t)
  const {archiver} = archiverFor(fakeMux({pollsUntilReady: Number.POSITIVE_INFINITY}), {timeoutMs: 30_000})
  await assert.rejects(archiver.downloadOriginal('Abc123', path.join(dir, 'x.mp4')), /Timed out after 30 s waiting for the master file/)
})

test('Mux originals: errored masters fail; deleted or errored assets are reported unavailable', async (t) => {
  const dir = await makeTempDir(t)
  await assert.rejects(
    archiverFor(fakeMux({masterStatus: 'errored', pollsUntilReady: 1})).archiver.downloadOriginal('Abc123', path.join(dir, 'a.mp4')),
    /could not prepare the master/,
  )
  const missing = await archiverFor(fakeMux({exists: false})).archiver.downloadOriginal('Abc123', path.join(dir, 'b.mp4'))
  assert.deepEqual(missing, {status: 'unavailable', reason: 'Mux asset not found (HTTP 404)'})
  const errored = await archiverFor(fakeMux({status: 'errored'})).archiver.downloadOriginal('Abc123', path.join(dir, 'c.mp4'))
  assert.equal(errored.status, 'unavailable')
  assert.match(errored.reason, /errored/)
})

test('Mux inspect is read-only', async () => {
  const fake = fakeMux()
  const result = await archiverFor(fake).archiver.inspect('Abc123')
  assert.deepEqual(result, {available: true, status: 'ready', masterAccess: 'none'})
  assert.deepEqual(fake.log, ['GET https://api.mux.com/video/v1/assets/Abc123'])
})
