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

import {PRIVACY_FIELD, VIDEO_STRIP_VERSION} from '../../privacy/constants'
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
  store.put({_id: copy, _type: 'sanity.fileAsset', _createdAt: new Date(clock).toISOString(), mimeType: 'video/quicktime', source: {name: 'video-to-mp4-original', id: upload._id}, [PRIVACY_FIELD]: {status: 'stripped', version: VIDEO_STRIP_VERSION, strippedFrom: upload._id}})
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

  it('a video the stripper cannot handle is marked failed; an unexpected error pending, and reported', async () => {
    const broken = putVideo('broken.mov')
    await runUploadPrivacy(options(created(broken), {stripVideo: async () => {
      throw new UploadStripFailure('ffmpeg could not read the file as a video')
    }}))
    assert.equal((store.get(broken)![PRIVACY_FIELD] as {status: string}).status, 'failed')
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
