import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {test} from 'node:test'
import {gunzipSync} from 'node:zlib'

import {BucketTooLargeError, runBackup} from '../lib/backup.mjs'
import {computeFingerprint} from '../lib/fingerprint.mjs'
import {markerKey, snapshotDataKey, snapshotManifestKey} from '../lib/layout.mjs'
import {ObjectExistsError} from '../lib/storage/errors.mjs'
import {describeAssetDocument} from '../lib/sanity-assets.mjs'
import {createBufferOnce, createFileOnce} from '../lib/util.mjs'
import {
  buildDataset,
  DATASET,
  fakeAssetDownloader,
  fakeMuxArchiver,
  imageAsset,
  makeTempDir,
  newLocalStorage,
  PROJECT_ID,
  quietLog,
  recordingStorage,
  sha1,
  steppingClock,
} from './helpers.mjs'

async function setup(t, overrides = {}) {
  const {storage: local, dir} = await newLocalStorage(t)
  const storage = recordingStorage(local)
  const tmpDir = await makeTempDir(t, 'backup-work-')
  const dataset = buildDataset()
  const state = {documents: dataset.documents, exportCalls: 0}
  const downloadAsset = fakeAssetDownloader(dataset.binaries)
  const muxArchiver = overrides.muxArchiver === undefined ? fakeMuxArchiver() : overrides.muxArchiver
  const log = quietLog()
  const clock = steppingClock()
  const run = (options = {}) =>
    runBackup({
      projectId: PROJECT_ID,
      dataset: DATASET,
      storage,
      exportDocuments: async () => {
        state.exportCalls++
        return state.documents
      },
      downloadAsset,
      muxArchiver,
      now: clock,
      tmpDir,
      log,
      ...options,
    })
  return {storage, local, dir, tmpDir, dataset, state, downloadAsset, muxArchiver, log, run}
}

test('first run stores every asset, the Mux original, the snapshot, and writes the marker last', async (t) => {
  const ctx = await setup(t)
  const result = await ctx.run()

  assert.equal(result.status, 'snapshot')
  assert.equal(result.timestamp, '20261129T090000Z')
  const ts = result.timestamp
  const writes = ctx.storage.writes
  assert.equal(writes.at(-1), markerKey(ts), 'the marker is the last object written')
  assert.deepEqual(writes.slice(-3), [snapshotDataKey(ts), snapshotManifestKey(ts), markerKey(ts)])
  const {hero, avatar, unused, stl} = ctx.dataset.assets
  const expectedAssetKeys = [
    `assets/images/${hero.sha1hash}.jpg`,
    `assets/images/${avatar.sha1hash}.png`,
    `assets/images/${unused.sha1hash}.webp`,
    `assets/files/${stl.sha1hash}.stl`,
    'assets/mux/MuxAsset12abc.mp4',
  ].sort()
  assert.deepEqual(writes.slice(0, -3).sort(), expectedAssetKeys)

  // Stored bytes are the originals.
  const heroBytes = await ctx.local.readBuffer(`assets/images/${hero.sha1hash}.jpg`)
  assert.equal(sha1(heroBytes), hero.sha1hash)

  // data.ndjson.gz holds every exported document, sorted by _id.
  const data = gunzipSync(await ctx.local.readBuffer(snapshotDataKey(ts))).toString('utf8')
  const lines = data.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, ctx.dataset.documents.length)
  assert.deepEqual(lines.map((doc) => doc._id), ctx.dataset.documents.map((doc) => doc._id).sort())
  assert.deepEqual(lines.find((doc) => doc._id === 'blogPost-7'), ctx.dataset.documents.find((doc) => doc._id === 'blogPost-7'))

  const manifest = JSON.parse(await ctx.local.readBuffer(snapshotManifestKey(ts)))
  assert.equal(manifest.fingerprint.value, computeFingerprint(ctx.dataset.documents))
  assert.deepEqual(
    {published: manifest.documents.published, drafts: manifest.documents.drafts, versions: manifest.documents.versions, system: manifest.documents.system},
    {published: 7, drafts: 1, versions: 1, system: 3},
  )
  assert.equal(manifest.assets.length, 4)
  assert.ok(manifest.assets.every((asset) => asset.storedThisRun === true))
  assert.equal(manifest.mux.method, 'master-access')
  assert.deepEqual(manifest.mux.items.map((item) => [item.assetId, item.status, item.key]), [['MuxAsset12abc', 'stored', 'assets/mux/MuxAsset12abc.mp4']])

  const marker = JSON.parse(await ctx.local.readBuffer(markerKey(ts)))
  assert.equal(marker.fingerprint, manifest.fingerprint.value)
  assert.equal(marker.dataset, DATASET)
  assert.equal(marker.projectId, PROJECT_ID)
  assert.equal(marker.snapshot, `snapshots/${ts}/`)
})

test('a run with no changes writes nothing and reports no-change', async (t) => {
  const ctx = await setup(t)
  const first = await ctx.run()
  const before = await ctx.local.list('')
  const writesBefore = ctx.storage.writes.length
  const downloadsBefore = ctx.downloadAsset.calls.length

  const second = await ctx.run()
  assert.equal(second.status, 'no-change')
  assert.equal(second.previousTimestamp, first.timestamp)
  assert.equal(ctx.storage.writes.length, writesBefore, 'no create calls at all')
  assert.equal(ctx.downloadAsset.calls.length, downloadsBefore, 'no asset downloads')
  assert.deepEqual(await ctx.local.list(''), before)
  assert.ok(ctx.log.messages.info.some((message) => message.startsWith('No changes since snapshot')))
})

test('the order of the export does not matter for change detection', async (t) => {
  const ctx = await setup(t)
  await ctx.run()
  ctx.state.documents = [...ctx.state.documents].reverse()
  const second = await ctx.run()
  assert.equal(second.status, 'no-change')
})

test('a changed run writes a new snapshot and marker last, and does not upload stored assets again', async (t) => {
  const ctx = await setup(t)
  const first = await ctx.run()
  const firstWrites = ctx.storage.writes.length
  ctx.state.documents = ctx.state.documents.map((doc) => (doc._id === 'drafts.blogPost-7' ? {...doc, _rev: 'b3', title: 'Edited'} : doc))

  const second = await ctx.run()
  assert.equal(second.status, 'snapshot')
  assert.notEqual(second.timestamp, first.timestamp)
  assert.equal(second.previousTimestamp, first.timestamp)
  const newWrites = ctx.storage.writes.slice(firstWrites)
  assert.deepEqual(newWrites, [snapshotDataKey(second.timestamp), snapshotManifestKey(second.timestamp), markerKey(second.timestamp)])
  assert.equal(second.storedAssets, 0)
  assert.equal(second.storedMux, 0)

  const manifest = JSON.parse(await ctx.local.readBuffer(snapshotManifestKey(second.timestamp)))
  assert.equal(manifest.assets.length, 4, 'the manifest still lists every asset')
  assert.ok(manifest.assets.every((asset) => asset.storedThisRun === false))
  assert.equal(manifest.previousTimestamp, first.timestamp)
  // The first snapshot is untouched.
  assert.ok(await ctx.local.stat(markerKey(first.timestamp)))
})

test('a deleted document counts as a change', async (t) => {
  const ctx = await setup(t)
  await ctx.run()
  ctx.state.documents = ctx.state.documents.filter((doc) => doc._id !== 'versions.rSpring.blogPost-7')
  assert.equal((await ctx.run()).status, 'snapshot')
})

test('a new asset is the only binary uploaded on the next run (dedupe)', async (t) => {
  const ctx = await setup(t)
  await ctx.run()
  const downloadsBefore = ctx.downloadAsset.calls.length
  const writesBefore = ctx.storage.writes.length
  const newBytes = Buffer.from('a brand new image')
  const newAsset = imageAsset(newBytes, {extension: 'gif'})
  ctx.dataset.binaries.set(newAsset.url, newBytes)
  ctx.state.documents = [...ctx.state.documents, newAsset]

  const result = await ctx.run()
  assert.equal(result.status, 'snapshot')
  assert.deepEqual(ctx.downloadAsset.calls.slice(downloadsBefore), [newAsset._id])
  const ts = result.timestamp
  assert.deepEqual(ctx.storage.writes.slice(writesBefore), [
    `assets/images/${newAsset.sha1hash}.gif`,
    snapshotDataKey(ts),
    snapshotManifestKey(ts),
    markerKey(ts),
  ])
  assert.equal(result.storedAssets, 1)
})

test('two asset documents with the same content are stored once', async (t) => {
  const ctx = await setup(t)
  const bytes = Buffer.from('same bytes')
  const a = imageAsset(bytes, {width: 10, height: 10, extension: 'png'})
  ctx.dataset.binaries.set(a.url, bytes)
  // Same sha1 and extension, so the same object key, even though the id differs.
  const b = {...imageAsset(bytes, {width: 20, height: 20, extension: 'png'}), url: a.url}
  ctx.state.documents = [...ctx.state.documents, a, b]
  await ctx.run()
  const key = `assets/images/${sha1(bytes)}.png`
  assert.equal(ctx.storage.writes.filter((write) => write === key).length, 1)
})

test('a dry run writes nothing and lists what it would write', async (t) => {
  const ctx = await setup(t)
  const result = await ctx.run({dryRun: true})
  assert.equal(result.status, 'dry-run')
  assert.equal(ctx.storage.writes.length, 0)
  assert.equal(ctx.downloadAsset.calls.length, 0)
  assert.deepEqual(ctx.muxArchiver.calls, ['inspect:MuxAsset12abc'], 'a dry run only inspects Mux, read-only')
  assert.equal(result.plan.writes.at(-1), markerKey(result.plan.timestamp))
  assert.equal(result.plan.writes.length, 8)
  assert.deepEqual(await ctx.local.list(''), [])
})

test('markers of other datasets are ignored when comparing', async (t) => {
  const ctx = await setup(t)
  const production = await ctx.run()
  const staging = await ctx.run({dataset: 'staging'})
  assert.equal(staging.status, 'snapshot', 'the first staging run is a snapshot even with identical content')
  assert.equal(staging.previousTimestamp, null)
  const productionAgain = await ctx.run()
  assert.equal(productionAgain.status, 'no-change')
  assert.equal(productionAgain.previousTimestamp, production.timestamp)
})

test('an unavailable Mux original is recorded as a warning and the snapshot is still written', async (t) => {
  const ctx = await setup(t, {muxArchiver: fakeMuxArchiver({unavailable: new Map([['MuxAsset12abc', 'Mux asset not found (HTTP 404)']])})})
  const result = await ctx.run()
  assert.equal(result.status, 'snapshot')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /MuxAsset12abc/)
  const manifest = JSON.parse(await ctx.local.readBuffer(snapshotManifestKey(result.timestamp)))
  assert.equal(manifest.mux.items[0].status, 'unavailable')
  assert.equal(manifest.warnings.length, 1)
  const marker = JSON.parse(await ctx.local.readBuffer(markerKey(result.timestamp)))
  assert.equal(marker.warningCount, 1)
  assert.equal(await ctx.local.stat('assets/mux/MuxAsset12abc.mp4'), null)
})

test('missing Mux credentials fail the run before anything is written', async (t) => {
  const ctx = await setup(t, {muxArchiver: null})
  await assert.rejects(ctx.run(), /MUX_TOKEN_ID and MUX_TOKEN_SECRET/)
  assert.equal(ctx.storage.writes.length, 0)
})

test('a failed asset download leaves no marker, and the next run resumes without re-uploading', async (t) => {
  const ctx = await setup(t)
  // With concurrency 1 assets are stored in key order, so failing the asset
  // with the last key means the others were stored before the failure.
  const failing = Object.values(ctx.dataset.assets).sort((a, b) => (describeAssetDocument(a).key < describeAssetDocument(b).key ? -1 : 1)).at(-1)
  const failingBytes = ctx.dataset.binaries.get(failing.url)
  ctx.dataset.binaries.delete(failing.url)
  await assert.rejects(ctx.run({concurrency: 1}), /no bytes/)
  assert.deepEqual(await ctx.local.list('markers/'), [])
  assert.deepEqual(await ctx.local.list('snapshots/'), [])
  const storedBefore = (await ctx.local.list('assets/')).map((object) => object.key)
  assert.ok(storedBefore.length > 0, 'assets uploaded before the failure stay in the bucket')

  assert.equal(storedBefore.length, 3)
  assert.ok(!storedBefore.includes(describeAssetDocument(failing).key))

  ctx.dataset.binaries.set(failing.url, failingBytes)
  const downloadsBefore = ctx.downloadAsset.calls.length
  const result = await ctx.run()
  assert.equal(result.status, 'snapshot')
  assert.deepEqual(ctx.downloadAsset.calls.slice(downloadsBefore), [failing._id], 'only the missing asset is downloaded again')
})

test('the run fails before exporting when the bucket is already over the size limit', async (t) => {
  const ctx = await setup(t)
  await ctx.local.createFromBuffer('archive/big.bin', Buffer.alloc(2048))
  await assert.rejects(ctx.run({maxBucketBytes: 1024}), BucketTooLargeError)
  assert.equal(ctx.state.exportCalls, 0)
  assert.equal(ctx.storage.writes.length, 0)
})

test('the run fails after writing the marker when this run pushes the bucket over the limit', async (t) => {
  const ctx = await setup(t)
  await assert.rejects(ctx.run({maxBucketBytes: 200}), BucketTooLargeError)
  const markers = await ctx.local.list('markers/')
  assert.equal(markers.length, 1, 'the snapshot is complete even though the run fails')
})

test('a no-change run still fails when the bucket is over the size limit', async (t) => {
  const ctx = await setup(t)
  await ctx.run()
  await ctx.local.createFromBuffer('archive/big.bin', Buffer.alloc(4096))
  await assert.rejects(ctx.run({maxBucketBytes: 4096}), BucketTooLargeError)
})

test('a marker whose snapshot files are missing is reported as an error', async (t) => {
  const ctx = await setup(t)
  await ctx.local.createFromBuffer(markerKey('20261101T000000Z'), Buffer.from(JSON.stringify({fingerprint: 'x', dataset: DATASET, projectId: PROJECT_ID})))
  await assert.rejects(ctx.run(), /snapshot files are missing/)
})

test('a clock behind the newest marker is refused', async (t) => {
  const ctx = await setup(t)
  await ctx.run()
  ctx.state.documents = ctx.state.documents.map((doc) => (doc._id === 'person-1' ? {...doc, _rev: 'p2'} : doc))
  await assert.rejects(ctx.run({now: () => new Date('2026-01-01T00:00:00Z')}), /not after the newest marker/)
})

test('createBufferOnce accepts an identical existing object and refuses different content', async (t) => {
  const {storage} = await newLocalStorage(t)
  assert.equal(await createBufferOnce(storage, 'markers/x.json', Buffer.from('same')), true)
  assert.equal(await createBufferOnce(storage, 'markers/x.json', Buffer.from('same')), false)
  await assert.rejects(createBufferOnce(storage, 'markers/x.json', Buffer.from('different')), /refusing to overwrite/)
  assert.equal((await storage.readBuffer('markers/x.json')).toString(), 'same')
})

test('createFileOnce accepts an existing object of the same size and refuses another size', async (t) => {
  const {storage} = await newLocalStorage(t)
  const dir = await makeTempDir(t)
  const file = path.join(dir, 'a.bin')
  await writeFile(file, 'abc')
  assert.equal(await createFileOnce(storage, 'assets/files/a.bin', file, 3), true)
  assert.equal(await createFileOnce(storage, 'assets/files/a.bin', file, 3), false)
  await writeFile(file, 'abcd')
  await assert.rejects(createFileOnce(storage, 'assets/files/a.bin', file, 4), /already exists with 3 bytes/)
  assert.equal(await readFile(path.join(dir, 'a.bin'), 'utf8'), 'abcd')
  await assert.rejects(storage.createFromFile('assets/files/a.bin', file), ObjectExistsError)
})
