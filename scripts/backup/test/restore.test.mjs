import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createReadStream} from 'node:fs'
import {readdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {createGunzip, gzipSync} from 'node:zlib'

import {unpackTar} from 'modern-tar/fs'

import {runBackup} from '../lib/backup.mjs'
import {snapshotDataKey} from '../lib/layout.mjs'
import {
  buildRestoreArchive,
  compareWithSnapshot,
  loadSnapshot,
  needsAllowAssetsInDifferentDataset,
  planAssetMetadataPatches,
  planExactDeletions,
  prepareImportDocuments,
  resolveSnapshot,
  restorableAssetFields,
  rewriteAssetReferences,
} from '../lib/restore.mjs'
import {deleteDocuments, patchDocuments} from '../lib/sanity-mutate.mjs'
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
  sha1,
  steppingClock,
} from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

async function backedUp(t, {dataset = DATASET, documents} = {}) {
  const {storage, dir} = await newLocalStorage(t)
  const fixture = buildDataset()
  const tmpDir = await makeTempDir(t, 'restore-work-')
  const clock = steppingClock()
  const result = await runBackup({
    projectId: PROJECT_ID,
    dataset,
    storage,
    exportDocuments: async () => documents ?? fixture.documents,
    downloadAsset: fakeAssetDownloader(fixture.binaries),
    muxArchiver: fakeMuxArchiver(),
    now: clock,
    tmpDir,
    log: quietLog(),
  })
  return {storage, dir, fixture, result, clock, tmpDir}
}

test('asset references become _sanityAsset directives; everything else is untouched', () => {
  const {documents, assets} = buildDataset()
  const post = documents.find((doc) => doc._id === 'blogPost-7')
  const referenced = new Set()
  const rewritten = rewriteAssetReferences(post, referenced)

  assert.deepEqual(rewritten.heroMedia[0], {
    _sanityAsset: `image@file://./images/${assets.hero.sha1hash}.jpg`,
    _key: 'h1',
    _type: 'imageWithAlt',
    alt: 'Hero',
  })
  assert.deepEqual(rewritten.body[0].markDefs[0], {
    _key: 'fl1',
    _type: 'fileLink',
    file: {_sanityAsset: `file@file://./files/${assets.stl.sha1hash}.stl`, _type: 'file'},
  })
  assert.deepEqual(rewritten.body[1], {
    _sanityAsset: `image@file://./images/${assets.hero.sha1hash}.jpg`,
    _key: 'img1',
    _type: 'imageBlock',
    alt: 'Inline',
    layout: 'left',
  })
  // A Mux video reference is a document reference, not an asset: unchanged.
  assert.deepEqual(rewritten.body[2], post.body[2])
  assert.deepEqual(rewritten.author, post.author)
  assert.deepEqual([...referenced].sort(), [assets.hero._id, assets.stl._id].sort())
  // The input is not mutated.
  assert.equal(post.heroMedia[0].asset._ref, assets.hero._id)
})

test('hotspot and crop survive the rewrite', () => {
  const asset = imageAsset(Buffer.from('x'))
  const field = {_type: 'image', asset: {_type: 'reference', _ref: asset._id}, hotspot: {x: 0.1, y: 0.2, height: 1, width: 1}, crop: {top: 0, bottom: 0, left: 0, right: 0}}
  const rewritten = rewriteAssetReferences(field)
  assert.deepEqual(rewritten.hotspot, field.hotspot)
  assert.deepEqual(rewritten.crop, field.crop)
  assert.equal(rewritten.asset, undefined)
})

test('the import set drops Sanity-managed system documents and asset documents, and keeps the rest', () => {
  const {documents} = buildDataset()
  const prepared = prepareImportDocuments(documents)
  assert.deepEqual(prepared.droppedSystemIds, ['_.groups.administrator', '_.retention._maximum_project'])
  assert.deepEqual(prepared.importDocuments.map((doc) => doc._id), [
    '_.releases.rSpring',
    'blogPost-7',
    'drafts.blogPost-7',
    'mux-video-12',
    'person-1',
    'versions.rSpring.blogPost-7',
  ])
  assert.equal(prepared.assetDocuments.length, 4)
  assert.deepEqual(prepared.otherAssetDocuments, [])
  const mux = prepared.importDocuments.find((doc) => doc._id === 'mux-video-12')
  assert.equal(mux._type, 'mux.videoAsset')
  assert.equal(mux.assetId, 'MuxAsset12abc')
})

test('the restore tarball is a standard import archive', async (t) => {
  const {storage, fixture, result} = await backedUp(t)
  const work = await makeTempDir(t, 'restore-build-')
  const tarballPath = path.join(work, 'out', 'restore.tar.gz')
  const archive = await buildRestoreArchive({storage, timestamp: result.timestamp, workDir: work, tarballPath, log: quietLog()})
  assert.equal(archive.assetCount, 4)
  assert.deepEqual(archive.missingAssetIds, [])

  const extracted = await makeTempDir(t, 'restore-extract-')
  await pipeline(createReadStream(tarballPath), createGunzip(), unpackTar(extracted))
  const root = path.join(extracted, `${DATASET}-${result.timestamp}`)
  assert.deepEqual((await readdir(root)).sort(), ['assets.json', 'data.ndjson', 'files', 'images'])

  const {hero, avatar, unused, stl} = fixture.assets
  assert.deepEqual((await readdir(path.join(root, 'images'))).sort(), [`${avatar.sha1hash}.png`, `${hero.sha1hash}.jpg`, `${unused.sha1hash}.webp`].sort())
  assert.deepEqual(await readdir(path.join(root, 'files')), [`${stl.sha1hash}.stl`])
  assert.equal(sha1(await readFile(path.join(root, 'images', `${hero.sha1hash}.jpg`))), hero.sha1hash)

  const lines = (await readFile(path.join(root, 'data.ndjson'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.ok(lines.every((doc) => doc._type !== 'sanity.imageAsset' && doc._type !== 'sanity.fileAsset'))
  assert.ok(!lines.some((doc) => doc._id.startsWith('_.groups.')))
  // Every directive points at a file that is in the archive.
  const pointers = JSON.stringify(lines).match(/(image|file)@file:\/\/\.\/[a-z]+\/[a-f0-9]{40}\.[a-z0-9]+/g)
  assert.ok(pointers.length >= 4)
  for (const pointer of pointers) {
    const relative = pointer.replace(/^(image|file)@file:\/\/\.\//, '')
    assert.ok((await readFile(path.join(root, relative))).length > 0, `${relative} is in the archive`)
  }
  const draft = lines.find((doc) => doc._id === 'drafts.blogPost-7')
  assert.equal(draft.heroMedia[0]._sanityAsset, `image@file://./images/${avatar.sha1hash}.png`)

  // assets.json carries asset metadata keyed like @sanity/export (<type>-<sha1>).
  const assetMap = JSON.parse(await readFile(path.join(root, 'assets.json'), 'utf8'))
  assert.equal(assetMap[`image-${hero.sha1hash}`].originalFilename, hero.originalFilename)
  assert.equal(assetMap[`file-${stl.sha1hash}`].originalFilename, 'model.stl')
  for (const entry of Object.values(assetMap)) {
    for (const excluded of ['_id', '_type', 'url', 'path', 'uploadId', 'assetId', 'extension', 'mimeType']) {
      assert.equal(entry[excluded], undefined, `${excluded} is not in assets.json`)
    }
  }
})

test('a snapshot whose data does not match its manifest is rejected', async (t) => {
  const {storage, dir, result} = await backedUp(t)
  const dataPath = path.join(dir, ...snapshotDataKey(result.timestamp).split('/'))
  await writeFile(dataPath, gzipSync(Buffer.from('{"_id":"x","_type":"y","_rev":"1"}\n')))
  await assert.rejects(loadSnapshot(storage, result.timestamp), /does not match the hash in its manifest/)
})

test('a referenced asset missing from the bucket stops the build unless allowed', async (t) => {
  const {storage, dir, fixture, result} = await backedUp(t)
  const {rm} = await import('node:fs/promises')
  await rm(path.join(dir, 'assets', 'files', `${fixture.assets.stl.sha1hash}.stl`))
  const work = await makeTempDir(t, 'restore-build-')
  await assert.rejects(
    buildRestoreArchive({storage, timestamp: result.timestamp, workDir: work, tarballPath: path.join(work, 'a.tar.gz'), log: quietLog()}),
    /not in the bucket/,
  )
  const log = quietLog()
  const archive = await buildRestoreArchive({storage, timestamp: result.timestamp, workDir: work, tarballPath: path.join(work, 'b.tar.gz'), allowFailingAssets: true, log})
  assert.deepEqual(archive.missingAssetIds, [fixture.assets.stl._id])
  assert.ok(log.messages.warn.some((message) => message.includes(fixture.assets.stl._id)))
})

test('--latest picks the newest marker of the source dataset; --snapshot needs a marker of that dataset', async (t) => {
  const {storage, fixture, clock, tmpDir} = await backedUp(t)
  const first = (await storage.list('markers/')).map((object) => object.key)
  const staging = await runBackup({
    projectId: PROJECT_ID,
    dataset: 'staging',
    storage,
    exportDocuments: async () => fixture.documents,
    downloadAsset: fakeAssetDownloader(fixture.binaries),
    muxArchiver: fakeMuxArchiver(),
    now: clock,
    tmpDir,
    log: quietLog(),
  })
  const productionTs = first[0].slice('markers/'.length, -'.json'.length)
  // The staging snapshot is the newest marker overall, but never the answer for production.
  assert.ok(staging.timestamp > productionTs)
  assert.equal(await resolveSnapshot(storage, {latest: true, sourceDataset: 'staging'}), staging.timestamp)
  assert.equal(await resolveSnapshot(storage, {latest: true, sourceDataset: 'production'}), productionTs)
  await assert.rejects(resolveSnapshot(storage, {latest: true}), /--latest needs the dataset the snapshot was taken of/)
  assert.equal(await resolveSnapshot(storage, {snapshot: productionTs, sourceDataset: 'production'}), productionTs)
  await assert.rejects(
    resolveSnapshot(storage, {snapshot: staging.timestamp, sourceDataset: 'production'}),
    /Snapshot \d{8}T\d{6}Z is of dataset staging, not production\. To restore it into another dataset on purpose, pass --from-dataset staging/,
  )
  // Only a --build-only run of an explicit snapshot names no dataset.
  assert.equal(await resolveSnapshot(storage, {snapshot: productionTs}), productionTs)
  await assert.rejects(resolveSnapshot(storage, {snapshot: '20200101T000000Z', sourceDataset: 'production'}), /does not exist or never completed/)
  await assert.rejects(resolveSnapshot(storage, {latest: true, sourceDataset: 'nope'}), /No completed snapshots of dataset nope/)
  await assert.rejects(resolveSnapshot(storage, {snapshot: 'yesterday'}), /must look like/)
  await assert.rejects(resolveSnapshot(storage, {}), /--snapshot <ts> or --latest/)
})

test('restore.mjs never takes another dataset\'s snapshot unless --from-dataset names it', async (t) => {
  const {dir, result} = await backedUp(t, {dataset: 'staging'})
  const env = {...process.env}
  delete env.SANITY_WRITE_TOKEN
  delete env.MUX_TOKEN_ID
  delete env.MUX_TOKEN_SECRET
  const restore = async (...args) =>
    spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'restore.mjs'),
        '--source', 'local',
        '--local-dir', dir,
        '--build-only',
        '--work-dir', await makeTempDir(t),
        '--output', path.join(await makeTempDir(t), 'r.tar.gz'),
        ...args,
      ],
      {encoding: 'utf8', env},
    )

  const latestForProduction = await restore('--latest', '--dataset', 'production')
  assert.equal(latestForProduction.status, 1)
  assert.match(latestForProduction.stderr, /No completed snapshots of dataset production/)

  const snapshotIntoProduction = await restore('--snapshot', result.timestamp, '--dataset', 'production')
  assert.equal(snapshotIntoProduction.status, 1)
  assert.match(snapshotIntoProduction.stderr, /is of dataset staging, not production/)

  const noDataset = await restore('--latest')
  assert.equal(noDataset.status, 1)
  assert.match(noDataset.stderr, /--latest needs --dataset or --from-dataset/)

  const explicit = await restore('--latest', '--from-dataset', 'staging', '--dataset', 'production')
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.match(explicit.stdout, new RegExp(`Restoring snapshot ${result.timestamp}`))
})

test('--exact plans to delete only documents and assets that are not in the snapshot', () => {
  const {documents} = buildDataset()
  const prepared = prepareImportDocuments(documents)
  const extraAsset = imageAsset(Buffer.from('added after the snapshot'))
  const targetDocuments = [
    ...documents,
    {_id: 'blogPost-99', _type: 'blogPost', _rev: 'x'},
    {_id: 'drafts.flexPage-3', _type: 'flexPage', _rev: 'x'},
    extraAsset,
    {_id: '_.groups.editor', _type: 'system.group', _rev: 'x'},
    {_id: '_.releases.rNew', _type: 'system.release', _rev: 'x'},
  ]
  const plan = planExactDeletions({prepared, targetDocuments})
  assert.deepEqual(plan.deleteDocumentIds, ['blogPost-99', 'drafts.flexPage-3'])
  assert.deepEqual(plan.deleteAssetIds, [extraAsset._id])
  assert.deepEqual(plan.keptSystemIds, ['_.releases.rNew'])
})

test('verification ignores _rev and _updatedAt and reports real differences', () => {
  const {documents} = buildDataset()
  const prepared = prepareImportDocuments(documents)
  const restored = documents
    .filter((doc) => !doc._id.startsWith('_.groups.') && !doc._id.startsWith('_.retention.'))
    .map((doc) => ({...doc, _rev: 'new-rev', _updatedAt: '2027-01-01T00:00:00Z'}))
  assert.deepEqual(compareWithSnapshot({documents, prepared, targetDocuments: restored}), {
    missing: [],
    changed: [],
    missingAssets: [],
    extra: [],
    createdAtDiffers: [],
  })

  const broken = restored
    .filter((doc) => doc._id !== 'person-1')
    .map((doc) => (doc._id === 'blogPost-7' ? {...doc, title: 'Changed'} : doc))
  broken.push({_id: 'service-1', _type: 'service', _rev: 'x'})
  const result = compareWithSnapshot({documents, prepared, targetDocuments: broken})
  assert.deepEqual(result.missing, ['person-1'])
  assert.deepEqual(result.changed, [{id: 'blogPost-7', path: 'title'}])
  assert.deepEqual(result.extra, ['service-1'])
})

test('verification reports _createdAt separately and compares asset documents on their restorable fields', () => {
  const {documents, assets} = buildDataset()
  const prepared = prepareImportDocuments(documents)
  const inTarget = documents.filter((doc) => !doc._id.startsWith('_.groups.') && !doc._id.startsWith('_.retention.'))
  // What a real import into another dataset looks like: documents that
  // already existed keep their own _createdAt, and asset documents have that
  // dataset's url, path and uploadId.
  const restored = inTarget.map((doc) => {
    if (doc._id === 'blogPost-7') return {...doc, _createdAt: '2026-01-01T00:00:00Z'}
    if (doc._type === 'sanity.imageAsset' || doc._type === 'sanity.fileAsset') {
      return {...doc, url: doc.url.replace('/production/', '/staging/'), path: doc.path.replace('/production/', '/staging/'), uploadId: 'other-upload'}
    }
    return doc
  })
  const result = compareWithSnapshot({documents, prepared, targetDocuments: restored})
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.createdAtDiffers, ['blogPost-7'])

  // A reused asset whose metadata or user fields differ is a real difference.
  const withStaleAsset = restored.map((doc) =>
    doc._id === assets.hero._id ? {...doc, metadata: {...doc.metadata, thumbHash: 'abc'}, title: 'Added later'} : doc,
  )
  assert.deepEqual(compareWithSnapshot({documents, prepared, targetDocuments: withStaleAsset}).changed, [{id: assets.hero._id, path: 'metadata.thumbHash'}])
})

test('asset metadata patches set differing restorable fields and unset ones the snapshot lacks', () => {
  const {documents, assets} = buildDataset()
  const prepared = prepareImportDocuments(documents)
  const stale = {
    ...assets.hero,
    _rev: 'other',
    _createdAt: '2026-01-01T00:00:00Z',
    uploadId: 'other-upload',
    url: assets.hero.url.replace('/production/', '/staging/'),
    path: assets.hero.path.replace('/production/', '/staging/'),
    metadata: {...assets.hero.metadata, thumbHash: 'abc'},
    originalFilename: 'renamed.jpg',
    title: 'Added later',
  }
  // The same content under the same sha1 but another id is matched too.
  const sameContentOtherId = {...assets.avatar, _id: `image-${assets.avatar.sha1hash}-8x6-png`, source: {name: 'unsplash', id: 'x'}}
  const targetDocuments = [
    ...documents.filter((doc) => ![assets.hero._id, assets.avatar._id].includes(doc._id)),
    stale,
    sameContentOtherId,
  ]
  assert.deepEqual(planAssetMetadataPatches({prepared, targetDocuments}), [
    {
      id: assets.hero._id,
      set: {metadata: assets.hero.metadata, originalFilename: assets.hero.originalFilename},
      unset: ['title'],
    },
    {id: sameContentOtherId._id, set: {}, unset: ['source']},
  ])
  // Nothing to do when the target already matches, whatever url, path, uploadId, _rev or dates say.
  const matching = documents.map((doc) => (doc._type === 'sanity.imageAsset' ? {...doc, uploadId: 'x', _rev: 'y', url: 'https://cdn.sanity.io/images/p/staging/a.png'} : doc))
  assert.deepEqual(planAssetMetadataPatches({prepared, targetDocuments: matching}), [])
  assert.deepEqual(restorableAssetFields(assets.stl), {originalFilename: 'model.stl'})
})

test('--allow-assets-in-different-dataset is only needed for leftover asset documents from elsewhere', () => {
  assert.equal(needsAllowAssetsInDifferentDataset([], {projectId: 'p', dataset: 'staging'}), false)
  const other = {_id: 'video-abc', _type: 'sanity.videoAsset', url: 'https://cdn.sanity.io/media/p/production/abc.mp4'}
  assert.equal(needsAllowAssetsInDifferentDataset([other], {projectId: 'p', dataset: 'production'}), false)
  assert.equal(needsAllowAssetsInDifferentDataset([other], {projectId: 'p', dataset: 'staging'}), true)
})

test('restore.mjs refuses --exact against production without --i-understand-production', async (t) => {
  const dir = await makeTempDir(t)
  const run = spawnSync(process.execPath, [
    path.join(here, '..', 'restore.mjs'),
    '--latest',
    '--source', 'local',
    '--local-dir', dir,
    '--dataset', 'production',
    '--project', 'abc123',
    '--exact',
  ], {encoding: 'utf8', env: {...process.env, SANITY_WRITE_TOKEN: 'not-used'}})
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Refusing to run it against "production" without --i-understand-production/)
})

test('restore.mjs refuses --replace without SANITY_WRITE_TOKEN', async (t) => {
  const dir = await makeTempDir(t)
  const env = {...process.env}
  delete env.SANITY_WRITE_TOKEN
  const run = spawnSync(process.execPath, [
    path.join(here, '..', 'restore.mjs'),
    '--latest',
    '--source', 'local',
    '--local-dir', dir,
    '--dataset', 'staging',
    '--project', 'abc123',
    '--replace',
  ], {encoding: 'utf8', env})
  assert.equal(run.status, 1)
  assert.match(run.stderr, /--replace, --exact and --verify need SANITY_WRITE_TOKEN/)
})

test('deletes and asset metadata patches go to the Mutate API in batches', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({url, body, authorization: init.headers.Authorization})
    return new Response(JSON.stringify({results: body.mutations.map((mutation) => ({id: (mutation.delete ?? mutation.patch).id}))}))
  }
  const deleted = await deleteDocuments({projectId: 'abc123', dataset: 'staging', token: 'tok', ids: ['a', 'b', 'c'], fetchImpl, batchSize: 2})
  assert.equal(deleted, 3)
  assert.deepEqual(requests.map((request) => request.body.mutations), [[{delete: {id: 'a'}}, {delete: {id: 'b'}}], [{delete: {id: 'c'}}]])
  assert.match(requests[0].url, /^https:\/\/abc123\.api\.sanity\.io\/v2025-02-19\/data\/mutate\/staging\?returnIds=true&visibility=sync&tag=sanity\.restore\.exact$/)
  assert.equal(requests[0].authorization, 'Bearer tok')

  requests.length = 0
  const patched = await patchDocuments({
    projectId: 'abc123',
    dataset: 'staging',
    token: 'tok',
    patches: [{id: 'image-1', set: {metadata: {lqip: 'x'}}, unset: ['title']}, {id: 'file-2', set: {}, unset: ['source']}],
    fetchImpl,
  })
  assert.equal(patched, 2)
  assert.deepEqual(requests[0].body.mutations, [
    {patch: {id: 'image-1', set: {metadata: {lqip: 'x'}}, unset: ['title']}},
    {patch: {id: 'file-2', unset: ['source']}},
  ])
  assert.match(requests[0].url, /tag=sanity\.restore\.asset-metadata$/)
  await assert.rejects(patchDocuments({projectId: 'abc123', dataset: 'staging', token: 'tok', patches: [{id: 'x', set: {}, unset: []}], fetchImpl}), /neither sets nor unsets/)
  await assert.rejects(deleteDocuments({projectId: 'abc123', dataset: 'staging', token: '', ids: ['a'], fetchImpl}), /SANITY_WRITE_TOKEN/)
})

test('restore.mjs --build-only writes a tarball from a local backup without touching Sanity', async (t) => {
  const {dir, result} = await backedUp(t)
  const out = path.join(await makeTempDir(t), 'restore.tar.gz')
  const env = {...process.env}
  delete env.SANITY_WRITE_TOKEN
  delete env.MUX_TOKEN_ID
  delete env.MUX_TOKEN_SECRET
  const run = spawnSync(process.execPath, [
    path.join(here, '..', 'restore.mjs'),
    '--latest',
    '--from-dataset', DATASET,
    '--source', 'local',
    '--local-dir', dir,
    '--build-only',
    '--output', out,
    '--work-dir', await makeTempDir(t),
  ], {encoding: 'utf8', env})
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, new RegExp(`Restoring snapshot ${result.timestamp}`))
  assert.ok((await readFile(out)).length > 0)
})
