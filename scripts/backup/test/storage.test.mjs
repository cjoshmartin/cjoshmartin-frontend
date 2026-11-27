import assert from 'node:assert/strict'
import {readdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {test} from 'node:test'

import {GcsStorage} from '../lib/storage/gcs.mjs'
import {ObjectExistsError} from '../lib/storage/errors.mjs'
import {makeTempDir, newLocalStorage} from './helpers.mjs'

test('local storage writes are create-only', async (t) => {
  const {storage} = await newLocalStorage(t)
  await storage.createFromBuffer('markers/a.json', Buffer.from('first'))
  await assert.rejects(storage.createFromBuffer('markers/a.json', Buffer.from('second')), ObjectExistsError)
  assert.equal((await storage.readBuffer('markers/a.json')).toString(), 'first')

  const dir = await makeTempDir(t)
  const src = path.join(dir, 'src.bin')
  await writeFile(src, 'payload')
  await storage.createFromFile('assets/files/x.bin', src)
  await assert.rejects(storage.createFromFile('assets/files/x.bin', src), ObjectExistsError)
})

test('local storage lists keys sorted with sizes, filtered by prefix, and hides partial files', async (t) => {
  const {storage, dir} = await newLocalStorage(t)
  await storage.createFromBuffer('snapshots/b/data', Buffer.from('12345'))
  await storage.createFromBuffer('markers/b.json', Buffer.from('1'))
  await storage.createFromBuffer('markers/a.json', Buffer.from('12'))
  await writeFile(path.join(dir, 'markers', '.partial-deadbeef-c.json'), 'partial')
  assert.deepEqual(await storage.list(''), [
    {key: 'markers/a.json', size: 2},
    {key: 'markers/b.json', size: 1},
    {key: 'snapshots/b/data', size: 5},
  ])
  assert.deepEqual((await storage.list('markers/')).map((object) => object.key), ['markers/a.json', 'markers/b.json'])
  assert.deepEqual(await storage.list('missing/'), [])
  assert.deepEqual(await storage.stat('markers/a.json'), {size: 2})
  assert.equal(await storage.stat('markers/zzz.json'), null)
  // No temporary files are left behind by successful writes.
  assert.deepEqual((await readdir(path.join(dir, 'markers'))).filter((name) => name.startsWith('.partial-') && name !== '.partial-deadbeef-c.json'), [])
})

test('storage keys cannot escape the root', async (t) => {
  const {storage} = await newLocalStorage(t)
  for (const key of ['../x', 'a/../../x', '/abs', 'a//b', 'a/./b', 'a\\b', '', 'dir/']) {
    await assert.rejects(storage.createFromBuffer(key, Buffer.from('x')), /Invalid object key|non-empty/, key)
  }
})

function fakeGcs({existing = new Map(), failWith} = {}) {
  const calls = []
  const bucket = {
    file(name) {
      return {
        name,
        async save(buffer, options) {
          calls.push({op: 'save', name, options})
          if (failWith) throw failWith
          if (existing.has(name)) throw Object.assign(new Error('Precondition Failed'), {code: 412})
          existing.set(name, buffer)
        },
        async getMetadata() {
          if (!existing.has(name)) throw Object.assign(new Error('Not Found'), {code: 404})
          return [{size: String(existing.get(name).length)}]
        },
        async download(options) {
          calls.push({op: 'download', name, options})
          return [existing.get(name)]
        },
      }
    },
    async upload(srcPath, options) {
      calls.push({op: 'upload', srcPath, options})
      if (existing.has(options.destination)) throw Object.assign(new Error('Precondition Failed'), {response: {status: 412}})
      existing.set(options.destination, Buffer.from('uploaded'))
    },
    async getFiles(options) {
      calls.push({op: 'getFiles', options})
      const files = [...existing.entries()]
        .filter(([name]) => name.startsWith(options.prefix))
        .reverse()
        .map(([name, buffer]) => ({name, metadata: {size: String(buffer.length)}}))
      return [files]
    },
  }
  return {calls, existing, storage: {bucket: () => bucket}}
}

test('GCS adapter sends ifGenerationMatch=0 on every write and maps 412 to ObjectExistsError', async (t) => {
  const fake = fakeGcs()
  const gcs = new GcsStorage({bucketName: 'cjoshmartin-sanity-backups', storage: fake.storage})
  assert.equal(gcs.describe(), 'gs://cjoshmartin-sanity-backups')

  await gcs.createFromBuffer('markers/a.json', Buffer.from('{}'), {contentType: 'application/json'})
  const save = fake.calls.find((call) => call.op === 'save')
  assert.deepEqual(save.options.preconditionOpts, {ifGenerationMatch: 0})
  assert.equal(save.options.contentType, 'application/json')
  assert.equal(save.options.resumable, false)
  await assert.rejects(gcs.createFromBuffer('markers/a.json', Buffer.from('{}')), ObjectExistsError)

  const dir = await makeTempDir(t)
  const src = path.join(dir, 'x.jpg')
  await writeFile(src, 'jpeg')
  await gcs.createFromFile('assets/images/x.jpg', src, {contentType: 'image/jpeg', metadata: {sha1: 'abc'}})
  const upload = fake.calls.find((call) => call.op === 'upload')
  assert.equal(upload.options.destination, 'assets/images/x.jpg')
  assert.deepEqual(upload.options.preconditionOpts, {ifGenerationMatch: 0})
  assert.deepEqual(upload.options.metadata, {metadata: {sha1: 'abc'}})
  await assert.rejects(gcs.createFromFile('assets/images/x.jpg', src), ObjectExistsError)
})

test('GCS adapter passes other errors through, lists sorted keys with numeric sizes, and stats missing objects as null', async () => {
  const forbidden = Object.assign(new Error('Forbidden'), {code: 403})
  const failing = new GcsStorage({bucketName: 'cjoshmartin-sanity-backups', storage: fakeGcs({failWith: forbidden}).storage})
  await assert.rejects(failing.createFromBuffer('markers/a.json', Buffer.from('x')), (error) => error === forbidden)

  const fake = fakeGcs({existing: new Map([['markers/b.json', Buffer.from('bb')], ['markers/a.json', Buffer.from('a')], ['assets/x', Buffer.from('xxx')]])})
  const gcs = new GcsStorage({bucketName: 'cjoshmartin-sanity-backups', storage: fake.storage})
  assert.deepEqual(await gcs.list('markers/'), [{key: 'markers/a.json', size: 1}, {key: 'markers/b.json', size: 2}])
  assert.equal(fake.calls.find((call) => call.op === 'getFiles').options.autoPaginate, true)
  assert.deepEqual(await gcs.stat('markers/a.json'), {size: 1})
  assert.equal(await gcs.stat('markers/nope.json'), null)
  assert.equal((await gcs.readBuffer('assets/x')).toString(), 'xxx')
})

test('GCS adapter rejects invalid bucket names and keys', () => {
  assert.throws(() => new GcsStorage({bucketName: 'Bad_Bucket!', storage: fakeGcs().storage}), /Invalid GCS bucket name/)
  const gcs = new GcsStorage({bucketName: 'cjoshmartin-sanity-backups', storage: fakeGcs().storage})
  return assert.rejects(gcs.createFromBuffer('../escape', Buffer.from('x')), /Invalid object key/)
})
