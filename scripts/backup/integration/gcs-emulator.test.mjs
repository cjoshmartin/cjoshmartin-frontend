// Integration test of the GCS adapter with the real @google-cloud/storage
// client against fake-gcs-server (https://github.com/fsouza/fake-gcs-server).
// Not part of `npm test`, because it needs Docker. Run it with:
//
//   docker run -d --rm --name fake-gcs -p 127.0.0.1:4443:4443 fsouza/fake-gcs-server:1.56.1 \
//     -scheme http -port 4443 -public-host 127.0.0.1:4443 -external-url http://127.0.0.1:4443
//   GCS_EMULATOR_URL=http://127.0.0.1:4443 npm run test:gcs-emulator
//   docker stop fake-gcs
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {test} from 'node:test'

import {Storage} from '@google-cloud/storage'

import {runBackup} from '../lib/backup.mjs'
import {markerKey} from '../lib/layout.mjs'
import {buildRestoreArchive} from '../lib/restore.mjs'
import {ObjectExistsError} from '../lib/storage/errors.mjs'
import {GcsStorage} from '../lib/storage/gcs.mjs'
import {buildDataset, DATASET, fakeAssetDownloader, fakeMuxArchiver, makeTempDir, PROJECT_ID, quietLog, steppingClock} from '../test/helpers.mjs'

// Not STORAGE_EMULATOR_HOST: @google-cloud/storage reads that variable itself
// and then uses it verbatim as the JSON API base URL, without /storage/v1.
const endpoint = process.env.GCS_EMULATOR_URL
if (!endpoint) {
  throw new Error('Set GCS_EMULATOR_URL to the fake-gcs-server URL (see the comment at the top of this file)')
}
if (process.env.STORAGE_EMULATOR_HOST) {
  throw new Error('Unset STORAGE_EMULATOR_HOST; this test passes the endpoint to the client explicitly')
}

async function freshBucket() {
  const name = `backup-it-${randomBytes(4).toString('hex')}`
  const response = await fetch(`${endpoint}/storage/v1/b?project=test`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name}),
  })
  assert.equal(response.status, 200, await response.text())
  const storage = new Storage({apiEndpoint: endpoint, projectId: 'test'})
  return new GcsStorage({bucketName: name, storage})
}

test('create-only writes, listing, stat and downloads work with the real client', async (t) => {
  const gcs = await freshBucket()
  await gcs.createFromBuffer('markers/a.json', Buffer.from('{"a":1}'), {contentType: 'application/json'})
  await assert.rejects(gcs.createFromBuffer('markers/a.json', Buffer.from('{"a":2}')), ObjectExistsError)
  assert.equal((await gcs.readBuffer('markers/a.json')).toString(), '{"a":1}')

  const dir = await makeTempDir(t)
  const small = path.join(dir, 'small.jpg')
  await writeFile(small, randomBytes(1024))
  await gcs.createFromFile('assets/images/small.jpg', small, {contentType: 'image/jpeg', metadata: {sha1: 'x'}})
  await assert.rejects(gcs.createFromFile('assets/images/small.jpg', small), ObjectExistsError)

  // Above the 8 MiB threshold the upload uses a resumable session.
  const big = path.join(dir, 'big.mp4')
  const bigBytes = randomBytes(9 * 1024 * 1024 + 17)
  await writeFile(big, bigBytes)
  await gcs.createFromFile('assets/mux/Big1.mp4', big, {contentType: 'video/mp4'})
  await assert.rejects(gcs.createFromFile('assets/mux/Big1.mp4', big), ObjectExistsError)

  assert.deepEqual(await gcs.list('assets/'), [
    {key: 'assets/images/small.jpg', size: 1024},
    {key: 'assets/mux/Big1.mp4', size: bigBytes.length},
  ])
  assert.deepEqual(await gcs.stat('assets/mux/Big1.mp4'), {size: bigBytes.length})
  assert.equal(await gcs.stat('assets/mux/missing.mp4'), null)
  const downloaded = path.join(dir, 'downloaded.mp4')
  await gcs.downloadToFile('assets/mux/Big1.mp4', downloaded)
  assert.ok(Buffer.compare(await readFile(downloaded), bigBytes) === 0)
})

test('a backup, a no-change run and a restore build work end to end on GCS', async (t) => {
  const gcs = await freshBucket()
  const fixture = buildDataset()
  const run = () =>
    runBackup({
      projectId: PROJECT_ID,
      dataset: DATASET,
      storage: gcs,
      exportDocuments: async () => fixture.documents,
      downloadAsset: fakeAssetDownloader(fixture.binaries),
      muxArchiver: fakeMuxArchiver(),
      now: clock,
      tmpDir: work,
      log: quietLog(),
    })
  const clock = steppingClock()
  const work = await makeTempDir(t)
  const first = await run()
  assert.equal(first.status, 'snapshot')
  assert.ok(await gcs.stat(markerKey(first.timestamp)))
  const second = await run()
  assert.equal(second.status, 'no-change')

  const archive = await buildRestoreArchive({storage: gcs, timestamp: first.timestamp, workDir: work, tarballPath: path.join(work, 'r.tar.gz'), log: quietLog()})
  assert.equal(archive.assetCount, 4)
})
