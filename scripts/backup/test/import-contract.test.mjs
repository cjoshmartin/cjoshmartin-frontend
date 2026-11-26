// Contract test: feed the restore tarball to @sanity/import, the library that
// `sanity datasets import` runs, with an in-memory client that applies every
// mutation it receives. The documents that come out must equal the backed-up
// documents (ignoring _rev and _updatedAt), with every asset uploaded once.
import assert from 'node:assert/strict'
import {createReadStream} from 'node:fs'
import path from 'node:path'
import {test} from 'node:test'

import {sanityImport} from '@sanity/import'
import {Mutation} from '@sanity/mutator'

import {runBackup} from '../lib/backup.mjs'
import {buildRestoreArchive} from '../lib/restore.mjs'
import {
  buildDataset,
  DATASET,
  fakeAssetDownloader,
  makeTempDir,
  newLocalStorage,
  PROJECT_ID,
  quietLog,
  sha1,
  steppingClock,
} from './helpers.mjs'

function fakeSanityClient({projectId, dataset, assetIdForHash}) {
  const docs = new Map()
  const uploads = []
  const actions = []
  const assetMetaPatches = []

  function applyPatch(id, ops) {
    let doc = docs.get(id)
    if (!doc) throw new Error(`patch on missing document ${id}`)
    for (const op of ops) doc = new Mutation({mutations: [{patch: {id, ...op}}]}).apply(doc)
    docs.set(id, doc)
  }

  function patchBuilder() {
    const ops = []
    const builder = {
      ops,
      set(value) {
        ops.push({set: value})
        return builder
      },
      setIfMissing(value) {
        ops.push({setIfMissing: value})
        return builder
      },
      unset(value) {
        ops.push({unset: value})
        return builder
      },
    }
    return builder
  }

  function transaction() {
    const queued = []
    const trx = {
      create(doc) {
        queued.push({kind: 'create', doc})
        return trx
      },
      createOrReplace(doc) {
        queued.push({kind: 'createOrReplace', doc})
        return trx
      },
      createIfNotExists(doc) {
        queued.push({kind: 'createIfNotExists', doc})
        return trx
      },
      patch(id, build) {
        const builder = patchBuilder()
        build(builder)
        queued.push({kind: 'patch', id, ops: builder.ops})
        return trx
      },
      async commit() {
        const results = []
        for (const item of queued) {
          if (item.kind === 'patch') {
            applyPatch(item.id, item.ops)
            results.push({id: item.id, operation: 'update'})
          } else {
            docs.set(item.doc._id, structuredClone(item.doc))
            results.push({id: item.doc._id, operation: 'create'})
          }
        }
        return {results}
      },
    }
    return trx
  }

  const client = {
    config: () => ({token: 'fake-token', projectId, dataset}),
    withConfig: () => client,
    transaction,
    // No asset with this hash exists yet in the (empty) target dataset.
    fetch: async () => null,
    assets: {
      async upload(type, buffer, options) {
        const hash = sha1(buffer)
        const id = assetIdForHash(type, hash)
        uploads.push({type, id, filename: options.filename, size: buffer.length})
        docs.set(id, {_id: id, _type: type === 'image' ? 'sanity.imageAsset' : 'sanity.fileAsset', sha1hash: hash, size: buffer.length})
        return {_id: id}
      },
    },
    patch(id) {
      const builder = patchBuilder()
      const chain = {
        set(value) {
          builder.set(value)
          return chain
        },
        async commit() {
          assetMetaPatches.push({id, ops: builder.ops})
          applyPatch(id, builder.ops)
          return {}
        },
      }
      return chain
    },
    async action(action) {
      actions.push(action)
      return {}
    },
    datasets: {list: async () => []},
  }
  return {client, docs, uploads, actions, assetMetaPatches}
}

function withoutVolatile(doc) {
  const {_rev, _updatedAt, ...rest} = doc
  return rest
}

test('@sanity/import turns the restore tarball back into the backed-up documents', async (t) => {
  const {storage} = await newLocalStorage(t)
  const fixture = buildDataset()
  const backup = await runBackup({
    projectId: PROJECT_ID,
    dataset: DATASET,
    storage,
    exportDocuments: async () => fixture.documents,
    downloadAsset: fakeAssetDownloader(fixture.binaries),
    now: steppingClock(),
    tmpDir: await makeTempDir(t),
    log: quietLog(),
  })
  const work = await makeTempDir(t, 'contract-')
  const tarballPath = path.join(work, 'restore.tar.gz')
  const archive = await buildRestoreArchive({storage, timestamp: backup.timestamp, workDir: work, tarballPath, log: quietLog()})

  // Sanity derives asset ids from content, so the fake does the same by
  // looking up which backed-up asset has these bytes.
  const assetDocs = fixture.documents.filter((doc) => doc._type === 'sanity.imageAsset' || doc._type === 'sanity.fileAsset')
  const fake = fakeSanityClient({
    projectId: 'targetproj',
    dataset: 'staging',
    assetIdForHash: (type, hash) => {
      const match = assetDocs.find((doc) => doc.sha1hash === hash && doc._id.startsWith(`${type}-`))
      if (!match) throw new Error(`unexpected ${type} upload with sha1 ${hash}`)
      return match._id
    },
  })

  // @sanity/import extracts tarballs under os.tmpdir() and leaves the empty
  // parent directory behind; keep that inside this test's temp directory.
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = work
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  })
  const result = await sanityImport(createReadStream(tarballPath), {
    client: fake.client,
    operation: 'createOrReplace',
    releasesOperation: 'replace',
    onProgress: () => {},
  })
  assert.equal(result.warnings.length, 0)

  // Every asset binary, referenced or not, was uploaded exactly once, with its original file name.
  assert.deepEqual(fake.uploads.map((upload) => upload.id).sort(), assetDocs.map((doc) => doc._id).sort())
  for (const doc of assetDocs) {
    assert.equal(fake.uploads.find((upload) => upload.id === doc._id).filename, doc.originalFilename)
  }
  // Asset metadata from assets.json was written back.
  const heroId = fixture.assets.hero._id
  assert.deepEqual(fake.docs.get(heroId).metadata, fixture.assets.hero.metadata)

  // The video's MP4 and its kept original were each uploaded once, as files,
  // with their own names. The MP4 gets its source back, so the converter can
  // still find it by the original's id and never converts the video again.
  const {clipMp4, clipOriginal} = fixture.assets
  assert.deepEqual(
    fake.uploads.filter((upload) => upload.id === clipMp4._id || upload.id === clipOriginal._id).map(({type, id, filename, size}) => ({type, id, filename, size})).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [
      {type: 'file', id: clipMp4._id, filename: 'IMG_3151.mp4', size: clipMp4.size},
      {type: 'file', id: clipOriginal._id, filename: 'IMG_3151.MOV', size: clipOriginal.size},
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  )
  assert.deepEqual(fake.docs.get(clipMp4._id).source, {name: 'video-to-mp4', id: clipOriginal._id})
  assert.equal(fake.docs.get(clipMp4._id).originalFilename, 'IMG_3151.mp4')
  // After the import the block plays the same MP4 its conversion record names,
  // so the restored block does not need conversion.
  for (const id of ['blogPost-7', 'drafts.blogPost-7']) {
    const block = fake.docs.get(id).body.find((member) => member._type === 'video')
    assert.equal(block.file.asset._ref, clipMp4._id)
    assert.equal(block.original.asset._ref, clipOriginal._id)
    assert.equal(block.conversion.outputAssetId, block.file.asset._ref)
    assert.equal(block.conversion.sourceAssetId, block.original.asset._ref)
  }

  // The release definition went through the release import action.
  assert.deepEqual(fake.actions.map((action) => [action.actionType, action.releaseId, action.ifExists]), [['sanity.action.release.import', 'rSpring', 'replace']])

  // Every other document comes back exactly as it was backed up.
  const original = new Map(fixture.documents.map((doc) => [doc._id, doc]))
  const restoredIds = archive.prepared.importDocuments.map((doc) => doc._id).filter((id) => !id.startsWith('_.'))
  assert.deepEqual(restoredIds.sort(), ['blogPost-7', 'drafts.blogPost-7', 'person-1', 'versions.rSpring.blogPost-7'])
  for (const id of restoredIds) {
    const restored = fake.docs.get(id)
    assert.ok(restored, `${id} was imported`)
    assert.deepEqual(withoutVolatile(restored), withoutVolatile(original.get(id)), `${id} round-trips`)
    assert.ok(!JSON.stringify(restored).includes('_sanityAsset'), `${id} has no leftover import directives`)
  }
  // System documents managed by Sanity were not sent.
  assert.ok(![...fake.docs.keys()].some((id) => id.startsWith('_.groups.') || id.startsWith('_.retention.')))
})
