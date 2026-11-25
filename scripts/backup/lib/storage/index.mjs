// Storage adapters share one interface. Keys are slash-separated object names
// such as "snapshots/20261129T090000Z/manifest.json".
//
//   describe(): string
//   list(prefix = ''): Promise<Array<{key: string, size: number}>>   sorted by key
//   stat(key): Promise<{size: number} | null>                         null when missing
//   readBuffer(key): Promise<Buffer>
//   downloadToFile(key, destPath): Promise<void>
//   createFromBuffer(key, buffer, {contentType, metadata}): Promise<void>
//   createFromFile(key, srcPath, {contentType, metadata}): Promise<void>
//
// Both create methods are create-only: they throw ObjectExistsError when the
// key exists and never replace an object. There is no delete method.

import {GcsStorage} from './gcs.mjs'
import {LocalStorage} from './local.mjs'

export {ObjectExistsError} from './errors.mjs'
export {GcsStorage} from './gcs.mjs'
export {LocalStorage} from './local.mjs'

export async function createStorage({kind, bucket, localDir}) {
  if (kind === 'gcs') {
    if (!bucket) throw new Error('--bucket (or BACKUP_BUCKET) is required for the gcs target')
    return GcsStorage.create({bucketName: bucket})
  }
  if (kind === 'local') {
    if (!localDir) throw new Error('--local-dir is required for the local target')
    return new LocalStorage(localDir)
  }
  throw new Error(`Unknown storage kind "${kind}" (expected gcs or local)`)
}
