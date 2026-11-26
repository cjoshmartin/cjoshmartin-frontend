// Tests for the code that talks to Sanity, using fake fetch functions.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {test} from 'node:test'

import {fetchWithRetry, HttpError} from '../lib/http.mjs'
import {
  assetDownloadRequest,
  BASE_DOWNLOAD_TIMEOUT_MS,
  describeAssetDocument,
  downloadSanityAsset,
  downloadTimeoutMs,
  isVideoAsset,
  parseAssetId,
} from '../lib/sanity-assets.mjs'
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
  assert.equal(parseAssetId('blogPost-7'), null)
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

test('video files are plain file assets: parsed, keyed under assets/files/ and downloaded without dlRaw or a token', () => {
  const mp4 = fileAsset(Buffer.from('mp4'), {extension: 'mp4', mimeType: 'video/mp4'})
  const original = fileAsset(Buffer.from('mov'), {extension: 'mov', mimeType: 'video/quicktime'})
  const webm = fileAsset(Buffer.from('webm'), {extension: 'webm', mimeType: 'video/webm'})
  assert.deepEqual(parseAssetId(mp4._id), {type: 'file', kind: 'files', hash: mp4.sha1hash, extension: 'mp4'})
  assert.equal(describeAssetDocument(original).key, `assets/files/${original.sha1hash}.mov`)
  assert.equal(describeAssetDocument(webm).key, `assets/files/${webm.sha1hash}.webm`)
  // An upper-case extension from a file name like IMG_0169.MOV is kept as it is.
  const upper = fileAsset(Buffer.from('MOV'), {extension: 'MOV', mimeType: 'video/quicktime'})
  assert.deepEqual(parseAssetId(upper._id), {type: 'file', kind: 'files', hash: upper.sha1hash, extension: 'MOV'})
  assert.equal(describeAssetDocument(upper).key, `assets/files/${upper.sha1hash}.MOV`)
  assert.equal(parseAssetId(`file-${upper.sha1hash}-M.OV`), null)
  assert.equal(parseAssetId(`image-${upper.sha1hash}-4x3-PNG`), null, 'image extensions come from the detected format and are lowercase')
  const request = assetDownloadRequest(describeAssetDocument(mp4), 'tok')
  assert.equal(request.url, mp4.url)
  assert.equal(request.headers.Authorization, undefined)

  assert.equal(isVideoAsset(describeAssetDocument(mp4)), true)
  assert.equal(isVideoAsset(describeAssetDocument(original)), true)
  assert.equal(isVideoAsset(describeAssetDocument(fileAsset(Buffer.from('stl')))), false)
  assert.equal(isVideoAsset(describeAssetDocument(imageAsset(Buffer.from('gif'), {extension: 'gif'}))), false)
  assert.equal(isVideoAsset({...describeAssetDocument(mp4), mimeType: null}), false)
})

test('the download time limit grows with the asset size, so large videos are not cut off', () => {
  assert.equal(BASE_DOWNLOAD_TIMEOUT_MS, 5 * 60_000)
  assert.equal(downloadTimeoutMs(null), BASE_DOWNLOAD_TIMEOUT_MS)
  assert.equal(downloadTimeoutMs(0), BASE_DOWNLOAD_TIMEOUT_MS)
  assert.equal(downloadTimeoutMs(1), BASE_DOWNLOAD_TIMEOUT_MS + 1000)
  // The largest Wagtail original, 39,675,901 bytes: 76 s on top of the base.
  assert.equal(downloadTimeoutMs(39_675_901), BASE_DOWNLOAD_TIMEOUT_MS + 76_000)
  assert.equal(downloadTimeoutMs(1024 ** 3), BASE_DOWNLOAD_TIMEOUT_MS + 2048_000)
})
