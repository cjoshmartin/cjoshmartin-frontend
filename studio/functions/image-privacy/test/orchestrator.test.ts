/**
 * runImagePrivacy against the in-memory store with the real stripper: an image with GPS is replaced
 * by a stripped copy everywhere (drafts, published, release versions; crop, hotspot and alt kept)
 * and deleted; an image without personal metadata is left alone; publishing mid-processing; a
 * reference added while deleting; the lease; failures and retries; no loops.
 */
import assert from 'node:assert/strict'
import {beforeEach, describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {IMAGE_PRIVACY_SOURCE_NAME, IMAGE_STRIP_VERSION} from '../../privacy/constants'
import {analyzeImage} from '../../privacy/image-strip'
import {RetryableImageError, runImagePrivacy, UnexpectedImageError, type RunOptions} from '../orchestrator'
import {IMAGE_PRIVACY_FILTER, RETRY_DELAY_SECONDS} from '../trigger'
import {jpegWithGps, TINY_JPEG} from './fixtures'
import {MemoryImageStore} from './memory-store'

const imageValue = (ref: string, extra: Record<string, unknown> = {}) => ({
  _type: 'imageWithAlt',
  asset: {_type: 'reference', _ref: ref},
  ...extra,
})

let store: MemoryImageStore
let gps: string
const logs: string[] = []
const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  store,
  documentId: 'drafts.blogPost-1',
  runId: 'run-a',
  log: (m) => logs.push(m),
  sleep: async () => undefined,
  ...overrides,
})

async function filterMatches(id: string, now = new Date()): Promise<boolean> {
  const doc = store.get(id)
  if (!doc) return false
  const result = await evaluate(parse(`*[_id == $id && ${IMAGE_PRIVACY_FILTER}]._id`), {
    dataset: [...store.docs.values()],
    params: {id},
    sanity: {projectId: 'j3vdh6ti', dataset: 'staging'},
    timestamp: now,
  })
  return ((await result.get()) as string[]).length === 1
}

beforeEach(() => {
  store = new MemoryImageStore()
  logs.length = 0
  gps = store.putImage(jpegWithGps())
  store.put({
    _id: 'drafts.blogPost-1',
    _type: 'blogPost',
    title: 'T',
    contentImage: imageValue(gps, {crop: {top: 0.1, bottom: 0, left: 0, right: 0}, hotspot: {x: 0.4, y: 0.6, width: 0.5, height: 0.5}, alt: 'Alt', caption: 'Cap'}),
    body: [
      {_type: 'block', _key: 't', children: [], markDefs: []},
      {_type: 'imageBlock', _key: 'i', asset: {_type: 'reference', _ref: gps}, layout: 'left', alt: 'In text'},
    ],
  })
})

describe('runImagePrivacy', () => {
  it('replaces an image with GPS by a stripped copy everywhere and deletes the upload', async () => {
    assert.equal(await filterMatches('drafts.blogPost-1'), true)
    const outcome = await runImagePrivacy(options())
    assert.equal(outcome.kind, 'done')
    assert.equal(store.uploads.length, 1)
    const copy = store.uploads[0].id
    assert.equal(store.uploads[0].mimeType, 'image/jpeg')

    const doc = store.get('drafts.blogPost-1')!
    assert.deepEqual(doc.contentImage, imageValue(copy, {crop: {top: 0.1, bottom: 0, left: 0, right: 0}, hotspot: {x: 0.4, y: 0.6, width: 0.5, height: 0.5}, alt: 'Alt', caption: 'Cap'}))
    const block = (doc.body as {_key: string}[]).find((b) => b._key === 'i')
    assert.deepEqual(block, {_type: 'imageBlock', _key: 'i', asset: {_type: 'reference', _ref: copy}, layout: 'left', alt: 'In text'})

    const copyDoc = store.get(copy)!
    assert.deepEqual(copyDoc.source, {name: IMAGE_PRIVACY_SOURCE_NAME, id: gps})
    assert.equal((copyDoc.privacy as {status: string}).status, 'stripped')
    assert.equal((copyDoc.privacy as {version: string}).version, IMAGE_STRIP_VERSION)
    assert.deepEqual((copyDoc.privacy as {removed: string[]}).removed, ['EXIF: Make, GPS'])
    const stripped = analyzeImage(store.bytes.get(copy)!)
    assert.deepEqual(stripped.removed.filter((r) => r.personal), [], 'the copy has no personal metadata')
    assert.equal(stripped.orientation, 6, 'the copy keeps the orientation')

    assert.equal(store.get(gps), undefined, 'the upload is deleted')
    assert.deepEqual(store.deletions, [gps])
    assert.equal(await filterMatches('drafts.blogPost-1'), false, 'its own patch does not start another run')
    assert.equal((await runImagePrivacy(options({runId: 'run-b'}))).kind, 'nothing-to-do')
  })

  it('leaves an image without personal metadata alone: no upload, no document change', async () => {
    const clean = store.putImage(new Uint8Array(TINY_JPEG))
    store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', contentImage: imageValue(clean)})
    const before = store.get('drafts.blogPost-1')!
    const outcome = await runImagePrivacy(options())
    assert.deepEqual(outcome.kind === 'done' && outcome.assets.map((a) => a.kind), ['clean'])
    assert.deepEqual(store.uploads, [])
    assert.deepEqual(store.get('drafts.blogPost-1'), before)
    assert.equal((store.get(clean)!.privacy as {status: string}).status, 'clean')
    assert.ok(store.get(clean), 'kept')
    assert.equal(await filterMatches('drafts.blogPost-1'), false)
  })

  it('a draft published while the copy is uploaded ends with a clean published document', async () => {
    store.beforeUpload = () => {
      const draft = store.get('drafts.blogPost-1')!
      store.put({...draft, _id: 'blogPost-1'})
      store.delete('drafts.blogPost-1')
    }
    await runImagePrivacy(options())
    const copy = store.uploads[0].id
    const published = store.get('blogPost-1')!
    assert.equal((published.contentImage as {asset: {_ref: string}}).asset._ref, copy)
    assert.equal(store.get(gps), undefined)
    assert.equal(await filterMatches('blogPost-1'), false)
  })

  it('points release versions and other documents at the copy too', async () => {
    store.put({_id: '_.releases.r1', _type: 'system.release', state: 'active'})
    store.put({_id: 'versions.r1.blogPost-1', _type: 'blogPost', contentImage: imageValue(gps)})
    store.put({_id: 'person-1', _type: 'person', image: imageValue(gps, {hotspot: {x: 0.2}})})
    await runImagePrivacy(options())
    const copy = store.uploads[0].id
    assert.equal((store.get('versions.r1.blogPost-1')!.contentImage as {asset: {_ref: string}}).asset._ref, copy)
    assert.deepEqual(store.get('person-1')!.image, imageValue(copy, {hotspot: {x: 0.2}}))
    assert.equal(store.get(gps), undefined)
  })

  it('leaves a version in a locked release alone and keeps the upload until it no longer uses it', async () => {
    store.put({_id: '_.releases.r2', _type: 'system.release', state: 'scheduled'})
    store.put({_id: 'versions.r2.blogPost-1', _type: 'blogPost', contentImage: imageValue(gps)})
    await runImagePrivacy(options())
    const copy = store.uploads[0].id
    assert.equal((store.get('drafts.blogPost-1')!.contentImage as {asset: {_ref: string}}).asset._ref, copy)
    assert.equal((store.get('versions.r2.blogPost-1')!.contentImage as {asset: {_ref: string}}).asset._ref, gps, 'the locked version is not written')
    assert.equal((store.get(gps)!.privacy as {status: string}).status, 'replaced', 'kept, marked replaced')
  })

  it("moves a testimonial's asciiArtSource with its image, so the art is not made again", async () => {
    store.put({_id: 'testimonial-1', _type: 'testimonial', image: imageValue(gps), asciiArt: '<pre>art</pre>', asciiArtSource: gps})
    await runImagePrivacy(options())
    const copy = store.uploads[0].id
    const testimonial = store.get('testimonial-1')!
    assert.equal((testimonial.image as {asset: {_ref: string}}).asset._ref, copy)
    assert.equal(testimonial.asciiArtSource, copy)
    assert.equal(testimonial.asciiArt, '<pre>art</pre>')
    assert.equal(store.get(gps), undefined)
  })

  it('a reference added while deleting is pointed at the copy in the next round', async () => {
    let added = false
    store.beforeDelete = () => {
      if (added) return
      added = true
      store.put({_id: 'drafts.project-2', _type: 'project', previewImage: imageValue(gps)})
    }
    await runImagePrivacy(options())
    const copy = store.uploads[0].id
    assert.equal((store.get('drafts.project-2')!.previewImage as {asset: {_ref: string}}).asset._ref, copy)
    assert.equal(store.get(gps), undefined)
  })

  it('finishes a replaced upload that a document still uses, without stripping again', async () => {
    await runImagePrivacy(options())
    const copy = store.uploads[0].id
    // A document that kept the upload (here: re-created with it, as a restored revision would).
    store.putImage(jpegWithGps(), {privacy: {status: 'replaced', version: IMAGE_STRIP_VERSION, replacementAssetId: copy}})
    store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', contentImage: imageValue(gps)})
    assert.equal(await filterMatches('drafts.blogPost-1'), true)
    const outcome = await runImagePrivacy(options({runId: 'run-b'}))
    assert.deepEqual(outcome.kind === 'done' && outcome.assets.map((a) => a.kind), ['repointed'])
    assert.equal(store.uploads.length, 1, 'no second upload')
    assert.equal((store.get('drafts.blogPost-1')!.contentImage as {asset: {_ref: string}}).asset._ref, copy)
    assert.equal(store.get(gps), undefined)
  })

  it('skips an image another run is processing (fresh lease)', async () => {
    const asset = store.get(gps)!
    store.put({...asset, privacy: {status: 'processing', holder: 'run-x', updatedAt: new Date().toISOString(), version: IMAGE_STRIP_VERSION}})
    assert.equal(await filterMatches('drafts.blogPost-1'), false)
    assert.equal((await runImagePrivacy(options())).kind, 'nothing-to-do')
    assert.deepEqual(store.uploads, [])
  })

  it('records a file that cannot be stripped as failed (final), keeps it and does not loop', async () => {
    const broken = store.putImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45]))
    store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', contentImage: imageValue(broken)})
    const outcome = await runImagePrivacy(options())
    assert.deepEqual(outcome.kind === 'done' && outcome.assets.map((a) => a.kind), ['failed'])
    const privacy = store.get(broken)!.privacy as {status: string; message: string}
    assert.equal(privacy.status, 'failed')
    assert.match(privacy.message, /could not be removed/)
    assert.ok(store.get(broken))
    assert.equal(await filterMatches('drafts.blogPost-1'), false)
  })

  it('records a download problem as pending and retries it after the delay', async () => {
    store.downloadError = new RetryableImageError('the image could not be downloaded (HTTP 503)')
    await runImagePrivacy(options())
    const privacy = store.get(gps)!.privacy as {status: string; message: string}
    assert.equal(privacy.status, 'pending')
    assert.match(privacy.message, /HTTP 503/)
    assert.equal(await filterMatches('drafts.blogPost-1'), false)
    const later = new Date(Date.now() + (RETRY_DELAY_SECONDS + 1) * 1000)
    assert.equal(await filterMatches('drafts.blogPost-1', later), true)
    store.downloadError = undefined
    await runImagePrivacy(options({runId: 'run-b', now: () => later}))
    assert.equal(store.get(gps), undefined)
  })

  it('records an unexpected error as pending and rethrows it for the logs', async () => {
    store.downloadError = new TypeError('boom')
    await assert.rejects(runImagePrivacy(options()), UnexpectedImageError)
    assert.equal((store.get(gps)!.privacy as {status: string}).status, 'pending')
  })

  it('refuses a copy with other dimensions (crops would move) and keeps the upload', async () => {
    store.copyDimensions = {width: 8, height: 9}
    const outcome = await runImagePrivacy(options())
    assert.deepEqual(outcome.kind === 'done' && outcome.assets.map((a) => a.kind), ['failed'])
    assert.ok(store.get(gps))
    assert.equal((store.get('drafts.blogPost-1')!.contentImage as {asset: {_ref: string}}).asset._ref, gps)
  })
  it('removes location and EXIF Sanity extracted into the upload, even while it cannot be deleted yet', async () => {
    const asset = store.get(gps)!
    store.put({...asset, metadata: {dimensions: {width: 8, height: 8}, location: {_type: 'geopoint', lat: 1, lng: 2}, exif: {Make: 'x'}}})
    // Something keeps adding a reference: every round points it at the copy, and a new one appears.
    let n = 0
    store.beforeDelete = () => {
      n += 1
      store.put({_id: `drafts.flexPage-${n}`, _type: 'flexPage', body: [{_type: 'imageBlock', _key: 'k', asset: {_type: 'reference', _ref: gps}}]})
    }
    await runImagePrivacy(options())
    const upload = store.get(gps)!
    assert.equal((upload.privacy as {status: string}).status, 'replaced', 'kept as replaced; the next event finishes it')
    assert.deepEqual(upload.metadata, {dimensions: {width: 8, height: 8}})
    assert.ok(logs.some((line) => line.includes('still referenced after 5 rounds')))
    assert.equal(await filterMatches(`drafts.flexPage-${n}`), true, 'the filter matches a document still using it')
  })
})
