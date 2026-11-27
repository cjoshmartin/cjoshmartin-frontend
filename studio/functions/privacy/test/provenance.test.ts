/**
 * The keyed digest a stripped copy records instead of its upload's id, and the private fetch the
 * Functions read uploads with (privacy review round 2, finding 1).
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {PRIVATE_FETCH_PARAM, privateAssetFetch, privateAssetUrl} from '../private-fetch'
import {
  copySourceId,
  isUploadDigest,
  PRIVACY_LINK_KEY_ENV,
  UNLINKED_SOURCE_ID,
  uploadDigest,
  uploadDigesterFromEnv,
} from '../provenance'

const KEY = '0123456789abcdef'.repeat(4)
const UPLOAD = 'file-0123456789abcdef0123456789abcdef01234567-mov'

test('uploadDigest is a keyed HMAC: stable, never contains the id, differs per key and per id', () => {
  const digest = uploadDigest(UPLOAD, KEY)
  assert.equal(digest, uploadDigest(UPLOAD, KEY))
  assert.ok(isUploadDigest(digest))
  assert.ok(!digest.includes('0123456789abcdef'), 'the digest does not contain the sha1 (the CDN path)')
  assert.notEqual(digest, uploadDigest(UPLOAD, 'f'.repeat(64)), 'another key gives another digest')
  assert.notEqual(digest, uploadDigest(UPLOAD.replace('-mov', '-mp4'), KEY))
  // RFC 2104 HMAC over the id's UTF-8 bytes with the key's 32 bytes, as hex (checked with openssl).
  assert.equal(uploadDigest('abc', '00'.repeat(32)), 'hmac-sha256:fd7adb152c05ef80dccf50a1fa4c05d5a3ec6da95575fc312ae7c5d091836351')
  assert.ok(!isUploadDigest(UPLOAD))
})

test('the key must be 32 random bytes as hex; without one, copies are unlinked', () => {
  assert.throws(() => uploadDigest(UPLOAD, 'short'), new RegExp(PRIVACY_LINK_KEY_ENV))
  assert.throws(() => uploadDigesterFromEnv({[PRIVACY_LINK_KEY_ENV]: 'not hex'}), new RegExp(PRIVACY_LINK_KEY_ENV))
  assert.equal(uploadDigesterFromEnv({}), undefined)
  assert.equal(uploadDigesterFromEnv({[PRIVACY_LINK_KEY_ENV]: '  '}), undefined)
  const digest = uploadDigesterFromEnv({[PRIVACY_LINK_KEY_ENV]: `${KEY}\n`})!
  assert.equal(digest(UPLOAD), uploadDigest(UPLOAD, KEY))
  assert.equal(copySourceId(UPLOAD, digest), uploadDigest(UPLOAD, KEY))
  assert.equal(copySourceId(UPLOAD, undefined), UNLINKED_SOURCE_ID)
})

test('privateAssetUrl adds a unique parameter and keeps the others', () => {
  const url = 'https://cdn.sanity.io/files/p/staging/abc.mov?dl='
  const a = new URL(privateAssetUrl(url))
  const b = new URL(privateAssetUrl(url))
  assert.equal(a.pathname, '/files/p/staging/abc.mov')
  assert.equal(a.searchParams.get('dl'), '')
  assert.match(a.searchParams.get(PRIVATE_FETCH_PARAM)!, /^[0-9a-f-]{36}$/)
  assert.notEqual(a.searchParams.get(PRIVATE_FETCH_PARAM), b.searchParams.get(PRIVATE_FETCH_PARAM))
})

test('privateAssetFetch sends every request to a unique URL with the token, keeping range headers', async () => {
  const seen: {url: string; headers: Headers}[] = []
  const fake: typeof fetch = async (input, init) => {
    seen.push({url: String(input), headers: new Headers(init?.headers)})
    return new Response('x')
  }
  const fetchPrivately = privateAssetFetch('secret-token', fake)
  await fetchPrivately('https://cdn.sanity.io/files/p/staging/abc.mov', {headers: {range: 'bytes=0-63'}})
  await fetchPrivately(new URL('https://cdn.sanity.io/files/p/staging/abc.mov'))
  assert.equal(seen.length, 2)
  for (const request of seen) {
    assert.ok(new URL(request.url).searchParams.has(PRIVATE_FETCH_PARAM))
    assert.equal(request.headers.get('authorization'), 'Bearer secret-token')
  }
  assert.equal(seen[0].headers.get('range'), 'bytes=0-63')
  assert.notEqual(seen[0].url, seen[1].url)
})
