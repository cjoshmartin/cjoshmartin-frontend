/**
 * runVideoToMp4 against the in-memory store: stripping the original and deleting the unstripped
 * upload, conversion, reuse of an earlier stripped copy and conversion, adopting an MP4 the
 * converter made, failures, stale `processing`, the per-upload lease (two runs never convert the
 * same upload at once), publishing mid-conversion, a file replaced mid-conversion, and revision
 * conflicts.
 */
import assert from 'node:assert/strict'
import {beforeEach, describe, it} from 'node:test'

import {
  ConversionFailure,
  RetryableConversionError,
  runVideoToMp4,
  UnexpectedConversionError,
  type AssetDocument,
  type Converter,
  type RunOptions,
} from '../orchestrator'
import {PRIVACY_FIELD, VIDEO_ORIGINAL_SOURCE_NAME, VIDEO_STRIP_VERSION} from '../../privacy/constants'
import {LEASE_FIELD, newLease} from '../patches'
import {
  CONVERTED_ASSET_SETTINGS_FIELD,
  CONVERTED_ASSET_SOURCE_NAME,
  SETTINGS_VERSION,
} from '../settings'
import {
  RETRY_DELAY_SECONDS,
  STALE_PROCESSING_SECONDS,
  VIDEO_TO_MP4_FILTER,
  type VideoBlock,
} from '../trigger'
import {evaluate, parse} from 'groq-js'
import {MemoryStore, testUploadDigest} from './memory-store'

const MOV = 'file-1111111111111111111111111111111111111111-mov'
const MP4 = 'file-2222222222222222222222222222222222222222-mp4'
const WEBM = 'file-3333333333333333333333333333333333333333-webm'
const OLD_MP4 = 'file-4444444444444444444444444444444444444444-mp4'

/** Id of the stripped copy the fake converter makes of an upload. */
const stripped = (uploadId: string) => uploadId.replace(/^file-./, 'file-a')
const S_MOV = stripped(MOV)

const file = (ref: string) => ({_type: 'file', asset: {_type: 'reference', _ref: ref}})
const fileAsset = (id: string, extra: Partial<AssetDocument> = {}) => ({
  _id: id,
  _type: 'sanity.fileAsset',
  _createdAt: '2026-11-26T10:00:00Z',
  url: `https://cdn.sanity.io/files/j3vdh6ti/staging/${id}`,
  size: 1000,
  mimeType: 'video/quicktime',
  originalFilename: 'IMG_0169.MOV',
  ...extra,
})

function videoOf(store: MemoryStore, id: string, key = 'v'): VideoBlock | undefined {
  const body = store.get(id)?.body as VideoBlock[] | undefined
  return body?.find((b) => b._key === key)
}

async function filterMatches(store: MemoryStore, id: string, now = new Date()): Promise<boolean> {
  const doc = store.get(id)
  if (!doc) return false
  const tree = parse(`*[${VIDEO_TO_MP4_FILTER}]._id`)
  const result = await (
    await evaluate(tree, {
      dataset: [doc],
      sanity: {projectId: 'j3vdh6ti', dataset: 'staging'},
      timestamp: now,
    })
  ).get()
  return (result as string[]).length === 1
}

/** An MP4 asset this converter made from `sourceId`, with `settingsVersion` recorded on it. */
const convertedAsset = (id: string, sourceId: string, settingsVersion?: string) =>
  fileAsset(id, {
    mimeType: 'video/mp4',
    source: {name: CONVERTED_ASSET_SOURCE_NAME, id: sourceId},
    ...(settingsVersion === undefined ? {} : {[CONVERTED_ASSET_SETTINGS_FIELD]: settingsVersion}),
  })

/** A copy of `uploadId` without metadata, as the stripper uploads it. */
const strippedAsset = (uploadId: string) =>
  fileAsset(stripped(uploadId), {
    source: {name: VIDEO_ORIGINAL_SOURCE_NAME, id: testUploadDigest(uploadId)},
    [PRIVACY_FIELD]: {status: 'stripped', version: VIDEO_STRIP_VERSION, strippedFromDigest: testUploadDigest(uploadId)},
  })

/** A converter whose conversions finish when the test says so. */
class FakeConverter implements Converter {
  calls: string[] = []
  stripCalls: string[] = []
  private pending: {resolve: () => void; reject: (e: unknown) => void}[] = []
  constructor(
    private readonly store: MemoryStore,
    private readonly mode: 'immediate' | 'manual' = 'immediate',
    private readonly error?: unknown,
    private readonly stripError?: unknown,
  ) {}
  /** Uploads the stripper finds without personal metadata. */
  readonly cleanUploads = new Set<string>()
  async strip(upload: AssetDocument) {
    this.stripCalls.push(upload._id)
    if (this.stripError) throw this.stripError
    const current = this.store.get(upload._id)!
    if (this.cleanUploads.has(upload._id)) {
      this.store.put({...current, [PRIVACY_FIELD]: {status: 'clean', version: VIDEO_STRIP_VERSION, removed: []}})
      return {assetId: upload._id, clean: true, message: 'The upload has no location or personal metadata; it is kept as it is.'}
    }
    this.store.put(strippedAsset(upload._id))
    // Like stripOriginal: the upload is marked replaced by its copy.
    this.store.put({...current, [PRIVACY_FIELD]: {status: 'replaced', version: VIDEO_STRIP_VERSION, replacementAssetId: stripped(upload._id)}})
    return {assetId: stripped(upload._id), message: 'The original is kept without its location.'}
  }
  async convert(source: AssetDocument) {
    this.calls.push(source._id)
    if (this.mode === 'manual') {
      await new Promise<void>((resolve, reject) => this.pending.push({resolve, reject}))
    }
    if (this.error) throw this.error
    this.store.put(
      fileAsset(MP4, {
        mimeType: 'video/mp4',
        originalFilename: 'IMG_0169.mp4',
        source: {name: CONVERTED_ASSET_SOURCE_NAME, id: source._id},
        [CONVERTED_ASSET_SETTINGS_FIELD]: SETTINGS_VERSION,
      }),
    )
    return {outputAssetId: MP4, message: 'Converted IMG_0169.MOV to MP4'}
  }
  get waiting() {
    return this.pending.length
  }
  finishAll() {
    for (const p of this.pending.splice(0)) p.resolve()
  }
}

/** Waits until `condition` holds, letting the runs progress. */
async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}`)
}

let store: MemoryStore
const logs: string[] = []
const options = (overrides: Partial<RunOptions> & Pick<RunOptions, 'converter'>): RunOptions => ({
  store,
  documentId: 'drafts.blogPost-1',
  runId: 'run-a',
  log: (m) => logs.push(m),
  sleep: async () => undefined,
  ...overrides,
})

beforeEach(() => {
  store = new MemoryStore()
  logs.length = 0
  store.put(fileAsset(MOV))
  store.put({
    _id: 'drafts.blogPost-1',
    _type: 'blogPost',
    title: 'T',
    body: [{_type: 'video', _key: 'v', file: file(MOV)}],
  })
})

describe('runVideoToMp4', () => {
  it('converts a new upload: processing first, then file = MP4, original = upload, ready', async () => {
    const converter = new FakeConverter(store, 'manual')
    const run = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the conversion to start')

    const during = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(during.conversion?.status, 'processing')
    assert.equal(during.conversion?.sourceAssetId, MOV)
    assert.equal(during.conversion?.settingsVersion, SETTINGS_VERSION)
    assert.ok(during.conversion?.updatedAt)
    assert.equal(
      await filterMatches(store, 'drafts.blogPost-1'),
      false,
      'no new run while processing',
    )
    assert.equal(store.get(MOV)?.[LEASE_FIELD] !== undefined, true, 'lease held during conversion')
    assert.ok(store.get(S_MOV), 'the stripped copy was uploaded before converting')

    converter.finishAll()
    const outcome = await run
    assert.equal(outcome.kind, 'done')
    assert.deepEqual(outcome.kind === 'done' && outcome.patchedDocuments, ['drafts.blogPost-1'])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(MP4))
    assert.deepEqual(after.original, file(S_MOV), 'original is the stripped copy')
    assert.equal(after.conversion?.status, 'ready')
    assert.equal(after.conversion?.sourceAssetId, S_MOV)
    assert.equal(after.conversion?.outputAssetId, MP4)
    assert.equal(after.conversion?.settingsVersion, SETTINGS_VERSION)
    assert.equal(after.conversion?.originalStripped, true)
    assert.equal(after.conversion?.stripVersion, VIDEO_STRIP_VERSION)
    assert.match(after.conversion?.message ?? '', /without its location/)
    assert.deepEqual(converter.stripCalls, [MOV])
    assert.deepEqual(converter.calls, [S_MOV], 'the stripped copy is converted')
    assert.equal(store.get(MOV), undefined, 'the unstripped upload is deleted')
    assert.ok(logs.some((line) => line.includes(`${MOV}: unstripped upload deleted`)))
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), false)

    // Saving the document again does nothing.
    const again = await runVideoToMp4(options({converter, runId: 'run-b'}))
    assert.equal(again.kind, 'nothing-to-do')
    assert.deepEqual(converter.calls, [S_MOV])
  })

  it('reuses an earlier stripped copy and its conversion instead of stripping and converting again', async () => {
    store.put(strippedAsset(MOV))
    store.put(convertedAsset(OLD_MP4, S_MOV, SETTINGS_VERSION))
    const converter = new FakeConverter(store)
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'done')
    assert.deepEqual(converter.stripCalls, [])
    assert.deepEqual(converter.calls, [])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(OLD_MP4))
    assert.deepEqual(after.original, file(S_MOV))
    assert.equal(after.conversion?.originalStripped, true)
    assert.equal(store.get(MOV), undefined, 'the re-uploaded unstripped file is deleted again')
    assert.equal(after.conversion?.status, 'ready')
    assert.equal(after.conversion?.settingsVersion, SETTINGS_VERSION)
    assert.match(after.conversion?.message ?? '', /Reused/)
  })

  it('does not reuse a conversion made with other settings, or without a recorded version', async () => {
    store.put(strippedAsset(MOV))
    store.put(convertedAsset(OLD_MP4, S_MOV, 'h264-crf23-max1920-v1'))
    store.put(convertedAsset('file-6666666666666666666666666666666666666666-mp4', S_MOV))
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.deepEqual(converter.calls, [S_MOV])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(MP4))
    assert.equal(after.conversion?.settingsVersion, SETTINGS_VERSION)
  })

  it('does not reuse assets of another source name or another upload', async () => {
    store.put(fileAsset(OLD_MP4, {mimeType: 'video/mp4', source: {name: 'video-spike', id: MOV}}))
    store.put(
      fileAsset('file-5555555555555555555555555555555555555555-mp4', {
        mimeType: 'video/mp4',
        source: {name: CONVERTED_ASSET_SOURCE_NAME, id: WEBM},
      }),
    )
    // A copy stripped by an older stripper is not reused either.
    store.put({
      ...strippedAsset(MOV),
      _id: 'file-7777777777777777777777777777777777777777-mov',
      [PRIVACY_FIELD]: {status: 'stripped', version: 'video-strip-v0', strippedFromDigest: testUploadDigest(MOV)},
    })
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.deepEqual(converter.stripCalls, [MOV])
    assert.deepEqual(converter.calls, [S_MOV])
    assert.deepEqual(videoOf(store, 'drafts.blogPost-1')?.file, file(MP4))
  })

  it('uses an MP4 the converter made as it is when an editor picks it for a new block', async () => {
    store.put(convertedAsset(OLD_MP4, MOV, SETTINGS_VERSION))
    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [{_type: 'video', _key: 'v', file: file(OLD_MP4)}],
    })
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.deepEqual(converter.calls, [])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(OLD_MP4))
    assert.deepEqual(after.original, file(MOV))
    assert.equal(after.conversion?.sourceAssetId, MOV)
    assert.equal(after.conversion?.outputAssetId, OLD_MP4)
    assert.equal(after.conversion?.settingsVersion, SETTINGS_VERSION)
    assert.equal(after.conversion?.originalStripped, false, 'an original from before stripping is not stripped')
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), false)
  })

  it('marks an adopted MP4 whose original is a stripped copy as stripped', async () => {
    store.put(strippedAsset(MOV))
    store.put(convertedAsset(OLD_MP4, S_MOV, SETTINGS_VERSION))
    store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', body: [{_type: 'video', _key: 'v', file: file(OLD_MP4)}]})
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.original, file(S_MOV))
    assert.equal(after.conversion?.originalStripped, true)
    assert.equal(after.conversion?.stripVersion, VIDEO_STRIP_VERSION)
  })

  it('swaps an MP4 made with older settings back to its original, which the next run converts', async () => {
    store.put(convertedAsset(OLD_MP4, MOV, 'h264-crf23-max1920-v1'))
    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [{_type: 'video', _key: 'v', file: file(OLD_MP4)}],
    })
    const converter = new FakeConverter(store)
    const first = await runVideoToMp4(options({converter}))
    assert.equal(first.kind, 'done')
    assert.deepEqual(converter.calls, [])
    assert.deepEqual(videoOf(store, 'drafts.blogPost-1'), {
      _type: 'video',
      _key: 'v',
      file: file(MOV),
    })
    assert.equal(store.get(OLD_MP4)?.[LEASE_FIELD], undefined, 'lease on the old MP4 released')
    // The restart patch is an update event that matches; the next run converts the original.
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), true)
    await runVideoToMp4(options({converter, runId: 'run-b'}))
    assert.deepEqual(converter.calls, [S_MOV])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(MP4))
    assert.deepEqual(after.original, file(S_MOV))
    assert.equal(after.conversion?.settingsVersion, SETTINGS_VERSION)
  })

  it('converts an MP4 made with older settings like any upload when its original is gone', async () => {
    store.put(convertedAsset(OLD_MP4, WEBM))
    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [{_type: 'video', _key: 'v', file: file(OLD_MP4)}],
    })
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.deepEqual(converter.stripCalls, [OLD_MP4])
    assert.deepEqual(converter.calls, [stripped(OLD_MP4)])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(after.conversion?.status, 'ready')
    assert.equal(after.conversion?.sourceAssetId, stripped(OLD_MP4))
    assert.deepEqual(after.original, file(stripped(OLD_MP4)))
  })

  it('records a failure after the strip on the stripped copy, deletes the upload, and does not run again', async () => {
    const converter = new FakeConverter(
      store,
      'immediate',
      new ConversionFailure('This file could not be read as a video: moov atom not found'),
    )
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'done')
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(S_MOV), 'the block keeps the copy without location data')
    assert.equal(after.original, undefined)
    assert.equal(after.conversion?.status, 'failed')
    assert.equal(after.conversion?.sourceAssetId, S_MOV)
    assert.equal(after.conversion?.outputAssetId, undefined)
    assert.match(after.conversion?.message ?? '', /moov atom not found/)
    assert.equal(store.get(MOV), undefined, 'the unstripped upload is deleted although the conversion failed')
    assert.ok(store.get(S_MOV))
    const failureWrites = store.patches.filter(
      (p) => p.id === 'drafts.blogPost-1' && JSON.stringify(p.ops).includes('"failed"'),
    )
    assert.equal(failureWrites.length, 1, 'the failure is written once')
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), false)
    const again = await runVideoToMp4(options({converter, runId: 'run-b'}))
    assert.equal(again.kind, 'nothing-to-do')
    assert.equal(converter.calls.length, 1)
  })

  it('takes an upload that cannot be stripped out of the block and deletes it (no copy exists)', async () => {
    const converter = new FakeConverter(
      store,
      'immediate',
      undefined,
      new ConversionFailure('The location and personal metadata could not be removed from the original: not a video'),
    )
    await runVideoToMp4(options({converter}))
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(after.file, undefined, 'the upload is out of the block')
    assert.equal(after.original, undefined)
    assert.equal(after.conversion?.status, 'failed')
    assert.equal(after.conversion?.sourceAssetId, undefined, 'the block does not name the deleted upload')
    assert.match(after.conversion?.message ?? '', /not a video\. The upload was removed from this block and deleted/)
    assert.ok(!JSON.stringify(store.get('drafts.blogPost-1')).includes(MOV.split('-')[1]), 'nothing names the upload')
    assert.equal(store.get(MOV), undefined, 'the upload with its location is deleted')
    assert.deepEqual(converter.calls, [])
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), false, 'no new run for the block')
  })

  it('waits for the upload sweep that is stripping the same upload and converts its copy', async () => {
    const mov = store.get(MOV)!
    store.put({...mov, [PRIVACY_FIELD]: {status: 'processing', version: VIDEO_STRIP_VERSION, holder: 'upload-sweep', updatedAt: new Date().toISOString()}})
    const converter = new FakeConverter(store)
    let waits = 0
    await runVideoToMp4(
      options({
        converter,
        sleep: async () => {
          waits += 1
          if (waits === 2) {
            // The sweep finishes: its copy exists and the upload is marked replaced.
            store.put(strippedAsset(MOV))
            store.put({...store.get(MOV)!, [PRIVACY_FIELD]: {status: 'replaced', version: VIDEO_STRIP_VERSION, replacementAssetId: S_MOV}})
          }
        },
      }),
    )
    assert.deepEqual(converter.stripCalls, [], 'not stripped twice')
    assert.deepEqual(converter.calls, [S_MOV])
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
    assert.equal(store.get(MOV), undefined)
  })

  it('keeps an upload without personal metadata as it is and converts it', async () => {
    const converter = new FakeConverter(store)
    converter.cleanUploads.add(MOV)
    await runVideoToMp4(options({converter}))
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(after.conversion?.status, 'ready')
    assert.deepEqual(converter.calls, [MOV])
    assert.deepEqual(after.original, file(MOV), 'the upload itself is the original')
    assert.equal(after.conversion?.sourceAssetId, MOV)
    assert.equal(after.conversion?.originalStripped, true)
    assert.equal((store.get(MOV)?.[PRIVACY_FIELD] as {status?: string} | undefined)?.status, 'clean')
    assert.ok(store.get(MOV), 'a clean upload is not deleted')
  })

  it('records an unexpected error as pending (retried later), then rethrows it for the logs', async () => {
    const converter = new FakeConverter(store, 'immediate', new TypeError('boom'))
    await assert.rejects(runVideoToMp4(options({converter})), UnexpectedConversionError)
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(after.conversion?.status, 'pending')
    assert.match(after.conversion?.message ?? '', /unexpected error while converting \(boom\)/)
    assert.equal(store.get(MOV)?.[LEASE_FIELD], undefined)
  })

  it("records a problem that is not the video's fault as pending and retries it after the delay", async () => {
    const broken = new FakeConverter(
      store,
      'immediate',
      new RetryableConversionError('the converter is not set up correctly (bad binary)'),
    )
    const outcome = await runVideoToMp4(options({converter: broken}))
    assert.equal(outcome.kind, 'done')
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.file, file(S_MOV), 'the block moves to the copy; the retry converts it')
    assert.equal(after.conversion?.status, 'pending')
    assert.equal(after.conversion?.sourceAssetId, S_MOV)
    assert.equal(store.get(MOV), undefined, 'the unstripped upload is deleted')
    assert.match(
      after.conversion?.message ?? '',
      /Could not convert yet: the converter is not set up/,
    )
    assert.match(after.conversion?.message ?? '', /retried automatically/)
    // Not retried by its own patch or a quick re-save...
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), false)
    const again = await runVideoToMp4(options({converter: broken, runId: 'run-b'}))
    assert.equal(again.kind, 'nothing-to-do')
    // ... but by the first event after the retry delay, after a redeploy fixed the converter.
    const later = new Date(Date.now() + (RETRY_DELAY_SECONDS + 1) * 1000)
    assert.equal(await filterMatches(store, 'drafts.blogPost-1', later), true)
    const fixed = new FakeConverter(store)
    await runVideoToMp4(options({converter: fixed, runId: 'run-c', now: () => later}))
    assert.deepEqual(fixed.calls, [S_MOV])
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
  })

  it('records failed when the upload no longer exists', async () => {
    store.delete(MOV)
    const converter = new FakeConverter(store)
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'done')
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'failed')
    assert.deepEqual(converter.stripCalls, [])
    assert.deepEqual(converter.calls, [])
  })

  it('leaves a fresh processing block alone and retries a stale one', async () => {
    const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()
    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [
        {
          _type: 'video',
          _key: 'v',
          file: file(MOV),
          conversion: {status: 'processing', sourceAssetId: MOV, updatedAt: at(60)},
        },
      ],
    })
    const converter = new FakeConverter(store)
    assert.equal((await runVideoToMp4(options({converter}))).kind, 'nothing-to-do')
    assert.deepEqual(converter.calls, [])

    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [
        {
          _type: 'video',
          _key: 'v',
          file: file(MOV),
          conversion: {
            status: 'processing',
            sourceAssetId: MOV,
            updatedAt: at(STALE_PROCESSING_SECONDS + 10),
          },
        },
      ],
    })
    // The run that wrote it died; its lease expired too.
    const asset = store.get(MOV)!
    store.put({
      ...asset,
      [LEASE_FIELD]: newLease(
        'dead-run',
        'drafts.blogPost-1',
        new Date(Date.now() - (STALE_PROCESSING_SECONDS + 10) * 1000),
      ),
    })
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'done')
    assert.deepEqual(converter.calls, [S_MOV])
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
  })

  it('handles one block per run, and the processing mark is what starts the next run', async () => {
    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [
        {_type: 'video', _key: 'v', file: file(MOV)},
        {_type: 'video', _key: 'w', file: file(WEBM)},
      ],
    })
    store.put(fileAsset(WEBM, {mimeType: 'video/webm'}))
    const converter = new FakeConverter(store, 'manual')
    const first = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'first conversion')
    // The processing mark on v is an update event; the filter still matches because of w.
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), true)
    const second = runVideoToMp4(options({converter, runId: 'run-b'}))
    await until(() => converter.waiting === 2, 'second conversion')
    assert.deepEqual(converter.calls, [S_MOV, stripped(WEBM)])
    assert.equal(await filterMatches(store, 'drafts.blogPost-1'), false)
    converter.finishAll()
    await Promise.all([first, second])
  })

  it('never converts one upload twice at once: the second run waits and is completed by the first', async () => {
    store.put({
      _id: 'blogPost-1',
      _type: 'blogPost',
      body: [{_type: 'video', _key: 'v', file: file(MOV)}],
    })
    store.put({
      _id: 'drafts.project-9',
      _type: 'project',
      body: [{_type: 'video', _key: 'p', file: file(MOV)}],
    })
    const converter = new FakeConverter(store, 'manual')
    const holder = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the holder to convert')

    const published = await runVideoToMp4(
      options({converter, documentId: 'blogPost-1', runId: 'run-b'}),
    )
    const otherDoc = await runVideoToMp4(
      options({converter, documentId: 'drafts.project-9', runId: 'run-c'}),
    )
    assert.equal(published.kind, 'waiting')
    assert.equal(otherDoc.kind, 'waiting')
    assert.equal(videoOf(store, 'blogPost-1')?.conversion?.status, 'processing')
    assert.equal(
      await filterMatches(store, 'blogPost-1'),
      false,
      'waiting blocks do not trigger runs',
    )

    converter.finishAll()
    assert.equal((await holder).kind, 'done')
    assert.deepEqual(converter.calls, [S_MOV], 'converted once')
    assert.deepEqual(converter.stripCalls, [MOV], 'stripped once')
    assert.equal(store.get(MOV), undefined, 'deleted once every block uses the stripped copy')
    for (const [id, key] of [
      ['drafts.blogPost-1', 'v'],
      ['blogPost-1', 'v'],
      ['drafts.project-9', 'p'],
    ]) {
      const block = videoOf(store, id, key)!
      assert.deepEqual(block.file, file(MP4), id)
      assert.equal(block.conversion?.status, 'ready', id)
    }
  })

  it('a draft published mid-conversion ends with a converted published document, converted once', async () => {
    const converter = new FakeConverter(store, 'manual')
    const run = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the conversion to start')

    // Publish: the published document gets the draft's content (block processing), the draft goes.
    const draft = store.get('drafts.blogPost-1')!
    store.put({...draft, _id: 'blogPost-1'})
    store.delete('drafts.blogPost-1')
    // The publish event for blogPost-1 does not start a run (fresh processing).
    assert.equal(await filterMatches(store, 'blogPost-1'), false)

    converter.finishAll()
    const outcome = await run
    assert.equal(outcome.kind, 'done')
    assert.deepEqual(converter.calls, [S_MOV])
    const published = videoOf(store, 'blogPost-1')!
    assert.deepEqual(published.file, file(MP4))
    assert.deepEqual(published.original, file(S_MOV))
    assert.equal(published.conversion?.status, 'ready')
    assert.equal(published.conversion?.originalStripped, true)
    assert.equal(store.get('drafts.blogPost-1'), undefined)
    assert.equal(store.get(MOV), undefined, 'the published document no longer references the upload')
  })

  it('a draft published before the first run marked it is converted once, in the published document', async () => {
    const draft = store.get('drafts.blogPost-1')!
    store.put({...draft, _id: 'blogPost-1'})
    store.delete('drafts.blogPost-1')
    const converter = new FakeConverter(store, 'manual')
    // The draft's run starts after the draft is gone; the published document's run starts too.
    const draftRun = runVideoToMp4(options({converter}))
    const publishedRun = runVideoToMp4(
      options({converter, documentId: 'blogPost-1', runId: 'run-b'}),
    )
    assert.equal((await draftRun).kind, 'document-missing')
    await until(() => converter.waiting === 1, 'the published run to convert')
    converter.finishAll()
    assert.equal((await publishedRun).kind, 'done')
    assert.deepEqual(converter.calls, [S_MOV])
    assert.deepEqual(videoOf(store, 'blogPost-1')?.file, file(MP4))
  })

  it('does not apply a result to a block whose file was replaced mid-conversion', async () => {
    store.put(fileAsset(WEBM, {mimeType: 'video/webm'}))
    const converter = new FakeConverter(store, 'manual')
    const run = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the conversion to start')
    const draft = store.get('drafts.blogPost-1')!
    const body = draft.body as VideoBlock[]
    store.put({...draft, body: [{...body[0], file: file(WEBM)}]})
    assert.equal(
      await filterMatches(store, 'drafts.blogPost-1'),
      true,
      'the new file needs its own run',
    )

    converter.finishAll()
    await run
    const block = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(block.file, file(WEBM))
    assert.notEqual(block.conversion?.status, 'ready')
  })

  it('retries a patch after a concurrent edit (revision conflict)', async () => {
    store.forcedConflicts.set('drafts.blogPost-1', 3)
    const converter = new FakeConverter(store)
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'done')
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
    assert.ok(logs.some((line) => /re-reading/.test(line)))
  })

  it('keeps edits made between read and patch (patches only touch the block by _key)', async () => {
    const converter = new FakeConverter(store, 'manual')
    const run = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the conversion to start')
    const draft = store.get('drafts.blogPost-1')!
    store.put({
      ...draft,
      title: 'Edited while converting',
      body: [{_type: 'block', _key: 'b', children: [], markDefs: []}, ...(draft.body as unknown[])],
    })
    converter.finishAll()
    await run
    const after = store.get('drafts.blogPost-1')!
    assert.equal(after.title, 'Edited while converting')
    assert.equal((after.body as {_key: string}[]).length, 2)
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
  })

  it('removes an original left over from a replaced file when the new one starts converting', async () => {
    store.put(fileAsset(WEBM, {mimeType: 'video/webm'}))
    store.put({
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [
        {
          _type: 'video',
          _key: 'v',
          file: file(WEBM),
          original: file(MOV),
          conversion: {status: 'ready', sourceAssetId: MOV, outputAssetId: OLD_MP4},
        },
      ],
    })
    const converter = new FakeConverter(store, 'manual')
    const run = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the conversion to start')
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.original, undefined)
    converter.finishAll()
    await run
    assert.deepEqual(videoOf(store, 'drafts.blogPost-1')?.original, file(stripped(WEBM)))
  })

  it('a waiting run whose second look finds the lease released takes over without converting again', async () => {
    store.put({
      _id: 'drafts.project-9',
      _type: 'project',
      body: [{_type: 'video', _key: 'p', file: file(MOV)}],
    })
    const converter = new FakeConverter(store, 'manual')
    const holder = runVideoToMp4(options({converter}))
    await until(() => converter.waiting === 1, 'the holder to convert')

    // After the waiter's mark lands, hold its second look at the lease until the holder is done.
    let state: 'idle' | 'armed' | 'fired' = 'idle'
    store.onPatch = (id) => {
      if (id === 'drafts.project-9' && state === 'idle') state = 'armed'
    }
    store.beforeRead = async (id) => {
      if (id === MOV && state === 'armed') {
        state = 'fired'
        converter.finishAll()
        await holder
      }
    }
    const waiter = await runVideoToMp4(
      options({converter, documentId: 'drafts.project-9', runId: 'run-b'}),
    )
    assert.equal(waiter.kind, 'no-target', 'the holder already completed the waiting block')
    assert.deepEqual(converter.calls, [S_MOV])
    assert.equal(videoOf(store, 'drafts.project-9', 'p')?.conversion?.status, 'ready')
    assert.equal(store.get(MOV)?.[LEASE_FIELD], undefined)
  })

  it('releases the lease without converting when the block changed before it could be marked', async () => {
    store.put(fileAsset(WEBM, {mimeType: 'video/webm'}))
    // Between the run's first read and its processing mark, the editor replaces the file.
    let replaced = false
    store.beforeRead = async (id) => {
      if (id === MOV && !replaced) {
        replaced = true
        const draft = store.get('drafts.blogPost-1')!
        store.put({...draft, body: [{_type: 'video', _key: 'v', file: file(WEBM)}]})
      }
    }
    const converter = new FakeConverter(store)
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'no-target')
    assert.deepEqual(converter.calls, [])
    assert.equal(store.get(MOV)?.[LEASE_FIELD], undefined)
    assert.equal(
      await filterMatches(store, 'drafts.blogPost-1'),
      true,
      'the new file gets its own run',
    )
  })
  it('takes an unstrippable upload out of every document that uses it, then deletes it', async () => {
    // A published document uses the same upload but does not wait for this run.
    store.put({_id: 'blogPost-2', _type: 'blogPost', title: 'U', body: [{_type: 'video', _key: 'w', file: file(MOV)}]})
    const converter = new FakeConverter(
      store,
      'immediate',
      undefined,
      new ConversionFailure('The location and personal metadata could not be removed from the original: unsupported stream'),
    )
    const outcome = await runVideoToMp4(options({converter}))
    assert.equal(outcome.kind, 'done')
    assert.deepEqual(outcome.kind === 'done' && outcome.patchedDocuments, ['blogPost-2', 'drafts.blogPost-1'])
    assert.equal(videoOf(store, 'drafts.blogPost-1')!.file, undefined)
    const other = videoOf(store, 'blogPost-2', 'w')!
    assert.equal(other.file, undefined)
    assert.match(other.conversion?.message ?? '', /unsupported stream\. The upload was removed/)
    assert.equal(store.get(MOV), undefined, 'deleted once nothing uses it')
    assert.equal(await filterMatches(store, 'blogPost-2'), false)
  })

  it('uses a failure the current stripper already recorded on the upload, without stripping again', async () => {
    store.put({...store.get(MOV)!, [PRIVACY_FIELD]: {status: 'failed', version: VIDEO_STRIP_VERSION, message: 'The location and personal metadata could not be removed: unsupported stream.'}})
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.deepEqual(converter.stripCalls, [], 'no second strip')
    assert.deepEqual(converter.calls, [])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(after.file, undefined)
    assert.match(after.conversion?.message ?? '', /^The location and personal metadata could not be removed: unsupported stream\. The upload was removed/)
    assert.equal(store.get(MOV), undefined)
  })

  it('keeps an unstrippable upload a locked release still uses, marked failed, for the sweep', async () => {
    store.put({_id: 'versions.rLocked.blogPost-1', _type: 'blogPost', title: 'T', body: [{_type: 'video', _key: 'v', file: file(MOV)}]})
    store.put({_id: '_.releases.rLocked', _type: 'system.release', state: 'scheduled'})
    const converter = new FakeConverter(store, 'immediate', undefined, new ConversionFailure('The video is too large for the converter to remove its location data.'))
    await runVideoToMp4(options({converter}))
    assert.equal(videoOf(store, 'drafts.blogPost-1')!.file, undefined)
    assert.deepEqual(videoOf(store, 'versions.rLocked.blogPost-1')!.file, file(MOV), 'a locked release is never written')
    assert.equal((store.get(MOV)![PRIVACY_FIELD] as {status: string}).status, 'failed')
  })

  it('records a strip problem that is not the file\'s fault as pending', async () => {
    const converter = new FakeConverter(store, 'immediate', undefined, new RetryableConversionError('the copy without metadata could not be uploaded (503)'))
    await runVideoToMp4(options({converter}))
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.equal(after.conversion?.status, 'pending')
    assert.match(after.conversion?.message ?? '', /could not be uploaded/)
  })

  it('converts an upload that already is a stripped copy without stripping or deleting it', async () => {
    store.put(strippedAsset(MOV))
    store.put({_id: 'drafts.blogPost-1', _type: 'blogPost', body: [{_type: 'video', _key: 'v', file: file(S_MOV)}]})
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.deepEqual(converter.stripCalls, [])
    assert.deepEqual(converter.calls, [S_MOV])
    const after = videoOf(store, 'drafts.blogPost-1')!
    assert.deepEqual(after.original, file(S_MOV))
    assert.equal(after.conversion?.originalStripped, true)
    assert.ok(store.get(S_MOV), 'the stripped copy is kept')
  })

  it('delivers to a version in an active release and deletes the upload', async () => {
    store.put({_id: '_.releases.r1', _type: 'system.release', state: 'active'})
    store.put({_id: 'versions.r1.blogPost-1', _type: 'blogPost', body: [{_type: 'video', _key: 'v', file: file(MOV)}]})
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter}))
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
    assert.equal(videoOf(store, 'versions.r1.blogPost-1')?.conversion?.status, 'ready')
    assert.deepEqual(videoOf(store, 'versions.r1.blogPost-1')?.original, file(S_MOV))
    assert.equal(store.get(MOV), undefined)
    assert.deepEqual(converter.calls, [S_MOV], 'one conversion for both')
  })

  it('converts a version in an active release from its own event', async () => {
    store.delete('drafts.blogPost-1')
    store.put({_id: '_.releases.r1', _type: 'system.release', state: 'active'})
    store.put({_id: 'versions.r1.blogPost-1', _type: 'blogPost', body: [{_type: 'video', _key: 'v', file: file(MOV)}]})
    const converter = new FakeConverter(store)
    await runVideoToMp4(options({converter, documentId: 'versions.r1.blogPost-1'}))
    assert.equal(videoOf(store, 'versions.r1.blogPost-1')?.conversion?.status, 'ready')
    assert.equal(store.get(MOV), undefined)
  })

  it('leaves a version in a locked release alone and keeps the upload it references', async () => {
    store.put({_id: '_.releases.r1', _type: 'system.release', state: 'scheduled'})
    store.put({_id: 'versions.r1.blogPost-1', _type: 'blogPost', body: [{_type: 'video', _key: 'v', file: file(MOV)}]})
    const converter = new FakeConverter(store)
    const locked = await runVideoToMp4(options({converter, documentId: 'versions.r1.blogPost-1'}))
    assert.equal(locked.kind, 'nothing-to-do')
    assert.deepEqual(converter.calls, [])
    await runVideoToMp4(options({converter, runId: 'run-b'}))
    assert.equal(videoOf(store, 'drafts.blogPost-1')?.conversion?.status, 'ready')
    assert.equal(videoOf(store, 'versions.r1.blogPost-1')?.conversion, undefined, 'the locked version is not written')
    assert.ok(store.get(MOV), 'not deleted while referenced')
    assert.ok(logs.some((line) => line.includes('still referenced by versions.r1.blogPost-1')))
    // Once the version no longer uses the upload (the release was published or archived), the next
    // run for a block with it deletes it.
    store.delete('versions.r1.blogPost-1')
    store.put({_id: 'drafts.project-2', _type: 'project', body: [{_type: 'video', _key: 'p', file: file(MOV)}]})
    await runVideoToMp4(options({converter, documentId: 'drafts.project-2', runId: 'run-b'}))
    assert.deepEqual(converter.stripCalls, [MOV], 'the stripped copy is reused')
    assert.deepEqual(converter.calls, [S_MOV], 'and its conversion')
    assert.deepEqual(videoOf(store, 'drafts.project-2', 'p')?.original, file(S_MOV))
    assert.equal(store.get(MOV), undefined)
  })
})
