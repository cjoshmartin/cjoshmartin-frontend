/**
 * runUploadPrivacy against the image-privacy Function's in-memory store with the real image
 * stripper and a fake video stripper: a new unused upload is stripped and deleted after the grace
 * period, one that gets a reference is left to the content Functions, extracted location goes at
 * once, the sweep deletes `replaced` leftovers and strips unchecked ones, and nothing made by the
 * migration or a Function is touched.
 */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {beforeEach, describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {IMAGE_STRIP_VERSION, PRIVACY_FIELD, VIDEO_STRIP_VERSION} from '../../privacy/constants'
import {uploadDigest} from '../../privacy/provenance'
import {createImageAssetProcessor} from '../../image-privacy/orchestrator'
import {jpegWithGps, TINY_JPEG} from '../../image-privacy/test/fixtures'
import {MemoryImageStore} from '../../image-privacy/test/memory-store'
import {runUploadPrivacy, UnexpectedUploadError, UploadStripFailure, type RunOptions, type UploadStore, type VideoStripper} from '../orchestrator'
import {GRACE_SECONDS, POLL_SECONDS, SWEEP_QUERY, sweepParams} from '../trigger'

class MemoryUploadStore extends MemoryImageStore implements UploadStore {
  now = new Date()
  async sweepCandidates(exclude: readonly string[]): Promise<string[]> {
    const result = await evaluate(parse(SWEEP_QUERY), {dataset: [...this.docs.values()], params: sweepParams(exclude), timestamp: this.now})
    return (await result.get()) as string[]
  }
}

let store: MemoryUploadStore
let clock: number
const logs: string[] = []
const videoCalls: string[] = []

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')
const imageRef = (ref: string) => ({_type: 'imageWithAlt', asset: {_type: 'reference', _ref: ref}})

/** A fake of video-to-mp4's stripOriginal: a copy marked stripped, the upload marked replaced. */
const fakeStripVideo: VideoStripper = async (upload) => {
  videoCalls.push(upload._id)
  const copy = `file-${sha1(`copy of ${upload._id}`)}-mov`
  const link = uploadDigest(upload._id, 'cd'.repeat(32))
  store.put({_id: copy, _type: 'sanity.fileAsset', _createdAt: new Date(clock).toISOString(), mimeType: 'video/quicktime', source: {name: 'video-to-mp4-original', id: link}, [PRIVACY_FIELD]: {status: 'stripped', version: VIDEO_STRIP_VERSION, strippedFromDigest: link}})
  store.put({...store.get(upload._id)!, [PRIVACY_FIELD]: {status: 'replaced', version: VIDEO_STRIP_VERSION, replacementAssetId: copy}})
  return {assetId: copy, clean: false, message: 'The original is kept without its location.'}
}

function options(event: RunOptions['event'], overrides: Partial<RunOptions> = {}): RunOptions {
  const now = () => new Date(clock)
  return {
    store,
    event,
    runId: 'run-a',
    deadline: Number.MAX_SAFE_INTEGER,
    now,
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      clock += ms
      store.now = new Date(clock)
    },
    processImage: (id) => createImageAssetProcessor({store, runId: 'run-a', now, log: (m) => logs.push(m), sleep: async () => undefined}).processAsset(id),
    stripVideo: fakeStripVideo,
    stripImageFile: fakeStripVideo,
    ...overrides,
  }
}

function putVideo(name: string, extra: Record<string, unknown> = {}, createdSecondsAgo = 0): string {
  const id = `file-${sha1(name)}-mov`
  store.put({_id: id, _type: 'sanity.fileAsset', _createdAt: new Date(clock - createdSecondsAgo * 1000).toISOString(), mimeType: 'video/quicktime', url: `https://cdn.sanity.io/files/p/staging/${id}.mov`, ...extra})
  return id
}

beforeEach(() => {
  clock = Date.parse('2026-11-27T12:00:00Z')
  store = new MemoryUploadStore()
  store.now = new Date(clock)
  logs.length = 0
  videoCalls.length = 0
})

const created = (id: string, type = id.startsWith('image-') ? 'sanity.imageAsset' : 'sanity.fileAsset') => ({operation: 'create', id, type})

describe('a new upload', () => {
  it('nobody uses after the grace period: an image is replaced by a copy without metadata and deleted', async () => {
    const gps = store.putImage(jpegWithGps(), {_createdAt: new Date(clock).toISOString(), metadata: {dimensions: {width: 8, height: 8}, location: {lat: 1, lng: 2}, exif: {GPSLatitude: 1}}})
    const outcome = await runUploadPrivacy(options(created(gps)))
    assert.equal(outcome.extractedRemoved, true, 'the extracted location went at once')
    assert.equal(outcome.outcomes[0].kind, 'image')
    assert.equal(store.get(gps), undefined, 'the upload is deleted')
    const copy = store.uploads[0].id
    assert.equal((store.get(copy)![PRIVACY_FIELD] as {status: string}).status, 'stripped')
    assert.ok(clock - Date.parse('2026-11-27T12:00:00Z') >= GRACE_SECONDS * 1000, 'it waited the grace period')
  })

  it('that a document starts using is left to the content Functions', async () => {
    const gps = store.putImage(jpegWithGps(), {_createdAt: new Date(clock).toISOString()})
    let polls = 0
    const outcome = await runUploadPrivacy(
      options(created(gps), {
        sleep: async (ms) => {
          clock += ms
          polls += 1
          if (polls === 2) store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', contentImage: imageRef(gps)})
        },
      }),
    )
    assert.deepEqual(outcome.outcomes.map((o) => o.kind), ['in-use'])
    assert.ok(store.get(gps), 'not touched')
    assert.ok(clock - Date.parse('2026-11-27T12:00:00Z') < GRACE_SECONDS * 1000, 'stopped waiting once it was used')
    assert.equal(polls, 2)
    assert.ok(POLL_SECONDS > 0)
  })

  it('seen in use once stays in use, even when the next reference query misses the draft (recreate fix round 1, finding 4)', async () => {
    // T1 of the recreate verification: the draft was written 0.5 s after the upload; one query saw
    // it and ended the wait, the next one a moment later did not, and the upload was stripped here.
    const png = store.putImage(TINY_JPEG, {_createdAt: new Date(clock).toISOString()})
    store.put({_id: 'drafts.testimonial-1', _type: 'testimonial', image: imageRef(png)})
    const real = store.referencing.bind(store)
    let queries = 0
    store.referencing = async (id: string) => {
      queries += 1
      return queries === 1 ? real(id) : []
    }
    const outcome = await runUploadPrivacy(options(created(png)))
    assert.deepEqual(outcome.outcomes, [{assetId: png, kind: 'in-use'}])
    assert.deepEqual(outcome.wait, {kind: 'referenced', seconds: 0, by: 1, recheck: 0})
    assert.equal(store.get(png)![PRIVACY_FIELD], undefined, 'not taken: left to the content Functions')
    assert.deepEqual(store.uploads, [])
    assert.ok(logs.some((line) => line.includes('the query index lagged')), 'the disagreement is logged')
  })

  it('not readable yet when the run starts is waited for, its extracted location removed once readable', async () => {
    const gps = store.putImage(jpegWithGps(), {_createdAt: new Date(clock).toISOString(), metadata: {dimensions: {width: 8, height: 8}, location: {lat: 1, lng: 2}}})
    const real = store.getDocument.bind(store)
    let reads = 0
    store.getDocument = async (id: string) => {
      if (id === gps && ++reads <= 2) return null
      return real(id)
    }
    const warnings: string[] = []
    let polls = 0
    const outcome = await runUploadPrivacy(
      options(created(gps), {
        warn: (m) => warnings.push(m),
        sleep: async (ms) => {
          clock += ms
          polls += 1
          store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', contentImage: imageRef(gps)})
        },
      }),
    )
    assert.equal(polls, 1, 'one poll, not handled as unused at once')
    assert.deepEqual(outcome.outcomes, [{assetId: gps, kind: 'in-use'}])
    assert.equal(outcome.extractedRemoved, true)
    assert.equal((store.get(gps)!.metadata as Record<string, unknown>).location, undefined, 'the extracted location went once readable')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /History API of a public dataset serves it without a token/)
    assert.doesNotMatch(warnings[0], /lat|lng|\d+\.\d+,/, 'the warning names no coordinates')
  })

  it('deleted during the wait is not handled; never readable waits the grace period', async () => {
    const gone = store.putImage(TINY_JPEG, {_createdAt: new Date(clock).toISOString()})
    const outcome = await runUploadPrivacy(options(created(gone), {sleep: async (ms) => {
      clock += ms
      store.delete(gone)
    }}))
    assert.equal(outcome.wait?.kind, 'deleted')
    assert.deepEqual(outcome.outcomes, [{assetId: gone, kind: 'missing'}])

    const start = clock
    const never = `image-${sha1('never')}-8x8-jpg`
    const late = await runUploadPrivacy(options(created(never)))
    assert.equal(late.wait?.kind, 'never-readable')
    assert.ok(clock - start >= GRACE_SECONDS * 1000)
    assert.deepEqual(late.outcomes, [{assetId: never, kind: 'missing'}])
  })

  it('without personal metadata is marked clean and kept', async () => {
    const clean = store.putImage(TINY_JPEG, {_createdAt: new Date(clock).toISOString()})
    await runUploadPrivacy(options(created(clean)))
    assert.equal((store.get(clean)![PRIVACY_FIELD] as {status: string}).status, 'clean')
    assert.deepEqual(store.uploads, [])
  })

  it('a video nobody uses is stripped to a copy and deleted', async () => {
    const mov = putVideo('IMG_0001.MOV')
    const outcome = await runUploadPrivacy(options(created(mov)))
    assert.deepEqual(videoCalls, [mov])
    assert.equal(outcome.outcomes[0].kind, 'video')
    assert.equal(store.get(mov), undefined)
  })

  it('a video the stripper cannot handle is deleted (its location data cannot be removed); an unexpected error pending, and reported', async () => {
    const broken = putVideo('broken.mov')
    const outcome = await runUploadPrivacy(options(created(broken), {stripVideo: async () => {
      throw new UploadStripFailure('ffmpeg could not read the file as a video')
    }}))
    assert.deepEqual(outcome.outcomes[0], {assetId: broken, kind: 'deleted', reason: 'its location data cannot be removed'})
    assert.equal(store.get(broken), undefined, 'not kept in the public dataset')
    const flaky = putVideo('flaky.mov')
    await assert.rejects(
      runUploadPrivacy(options(created(flaky), {stripVideo: async () => {
        throw new Error('socket hang up')
      }})),
      UnexpectedUploadError,
    )
    assert.equal((store.get(flaky)![PRIVACY_FIELD] as {status: string}).status, 'pending')
  })

  it('an image uploaded as a file is stripped to a file copy and deleted', async () => {
    const jpg = `file-${sha1('photo')}-jpg`
    store.put({_id: jpg, _type: 'sanity.fileAsset', _createdAt: new Date(clock).toISOString(), mimeType: 'image/jpeg'})
    const calls: string[] = []
    const outcome = await runUploadPrivacy(options(created(jpg), {stripImageFile: async (upload) => {
      calls.push(upload._id)
      return fakeStripVideo(upload)
    }}))
    assert.deepEqual(calls, [jpg])
    assert.deepEqual(videoCalls, [jpg], 'through the image file stripper only')
    assert.equal(outcome.outcomes[0].kind, 'image-file')
    assert.equal(store.get(jpg), undefined)
  })

  it('a PDF is not stripped by any Function and left as it is', async () => {
    const pdf = `file-${sha1('cv')}-pdf`
    store.put({_id: pdf, _type: 'sanity.fileAsset', _createdAt: new Date(clock).toISOString(), mimeType: 'application/pdf'})
    const outcome = await runUploadPrivacy(options(created(pdf)))
    assert.deepEqual(outcome.outcomes.map((o) => o.kind), ['unsupported'])
    assert.ok(store.get(pdf))
  })
})

describe('the sweep', () => {
  it('deletes a replaced upload nobody uses any more and strips an unchecked one, after any event', async () => {
    const copy = putVideo('copy', {source: {name: 'video-to-mp4-original', id: 'x'}, [PRIVACY_FIELD]: {status: 'stripped', version: VIDEO_STRIP_VERSION}}, GRACE_SECONDS + 30)
    const replaced = putVideo('replaced', {[PRIVACY_FIELD]: {status: 'replaced', version: VIDEO_STRIP_VERSION, replacementAssetId: copy}}, GRACE_SECONDS + 60)
    const unchecked = putVideo('unchecked', {}, GRACE_SECONDS + 50)
    const used = putVideo('used', {}, GRACE_SECONDS + 40)
    store.put({_id: 'drafts.project-1', _type: 'project', body: [{_type: 'video', _key: 'v', file: {_type: 'file', asset: {_type: 'reference', _ref: used}}}]})
    const migrated = putVideo('migrated', {source: {name: 'wagtail', id: 'media-1'}}, GRACE_SECONDS + 20)
    const outcome = await runUploadPrivacy(options({operation: 'delete', id: 'drafts.blogPost-9', type: 'blogPost'}))
    assert.deepEqual(outcome.outcomes.map((o) => `${o.assetId === replaced ? 'replaced' : o.assetId === unchecked ? 'unchecked' : o.assetId}:${o.kind}`), ['replaced:deleted', 'unchecked:video'])
    assert.equal(store.get(replaced), undefined)
    assert.equal(store.get(unchecked), undefined)
    assert.ok(store.get(used), 'a used upload is left to the content Functions')
    assert.ok(store.get(migrated), "the migration's assets are not touched")
    assert.ok(store.get(copy))
  })

  it('deletes an unused upload the current stripper failed on; strips one an older stripper failed on', async () => {
    const failedNow = putVideo('failed-now', {[PRIVACY_FIELD]: {status: 'failed', version: VIDEO_STRIP_VERSION, message: 'too large'}}, GRACE_SECONDS + 60)
    const failedBefore = putVideo('failed-before', {[PRIVACY_FIELD]: {status: 'failed', version: 'video-strip-v1', message: 'old stripper'}}, GRACE_SECONDS + 50)
    const failedImage = store.putImage(new Uint8Array(Buffer.from('not an image at all')), {_createdAt: new Date(clock - (GRACE_SECONDS + 40) * 1000).toISOString(), [PRIVACY_FIELD]: {status: 'failed', version: IMAGE_STRIP_VERSION, message: 'not a JPEG'}})
    const outcome = await runUploadPrivacy(options({operation: 'delete', id: 'drafts.blogPost-9', type: 'blogPost'}))
    assert.deepEqual(
      outcome.outcomes.map((o) => `${o.assetId === failedNow ? 'now' : o.assetId === failedBefore ? 'before' : o.assetId === failedImage ? 'image' : o.assetId}:${o.kind}`),
      ['now:deleted', 'before:video', 'image:deleted'],
    )
    assert.equal(store.get(failedNow), undefined)
    assert.equal(store.get(failedImage), undefined)
    assert.deepEqual(videoCalls, [failedBefore], 'stripped again by the current stripper')
  })

  it('an unused image the image stripper fails on is deleted', async () => {
    const broken = store.putImage(new Uint8Array(Buffer.from('GIF89a but not really a GIF')), {_createdAt: new Date(clock).toISOString(), mimeType: 'image/gif'})
    const outcome = await runUploadPrivacy(options(created(broken)))
    assert.deepEqual(outcome.outcomes, [{assetId: broken, kind: 'deleted', reason: 'its location data cannot be removed'}])
    assert.equal(store.get(broken), undefined)
  })

  it('stops starting new uploads near the deadline', async () => {
    putVideo('late', {}, GRACE_SECONDS + 50)
    const outcome = await runUploadPrivacy(options({operation: 'delete', id: 'drafts.blogPost-9', type: 'blogPost'}, {deadline: 0}))
    assert.deepEqual(outcome.outcomes, [])
    assert.ok(logs.some((line) => line.includes('near its time limit')))
  })

  it('leaves an upload alone while video-to-mp4 holds its lease', async () => {
    const leased = putVideo('leased', {videoToMp4Lease: {holder: 'other', documentId: 'd', acquiredAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 600_000).toISOString()}}, GRACE_SECONDS + 50)
    const outcome = await runUploadPrivacy(options({operation: 'delete', id: 'drafts.blogPost-9', type: 'blogPost'}))
    assert.deepEqual(outcome.outcomes.map((o) => o.kind), ['busy'])
    assert.ok(store.get(leased))
  })
})
