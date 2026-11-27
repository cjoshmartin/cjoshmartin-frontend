import {stat as statFile} from 'node:fs/promises'

import {ObjectExistsError, assertValidKey} from './errors.mjs'

// Uploads above this size use a resumable session; smaller ones use a single
// request. Both carry ifGenerationMatch=0, so GCS only creates the object when
// no live object has that name, and answers 412 otherwise.
const RESUMABLE_THRESHOLD_BYTES = 8 * 1024 * 1024

function isStatus(error, status) {
  // @google-cloud/storage 8 throws ApiError with `code`; newer versions use
  // GaxiosError with `status` / `response.status`.
  return error?.code === status || error?.status === status || error?.response?.status === status
}

// Google Cloud Storage implementation of the storage interface (see ./index.mjs).
// Authentication is Application Default Credentials: in GitHub Actions the
// google-github-actions/auth step writes a Workload Identity Federation
// credential file and exports GOOGLE_APPLICATION_CREDENTIALS; locally it is
// `gcloud auth application-default login`.
export class GcsStorage {
  constructor({bucketName, storage}) {
    if (typeof bucketName !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucketName)) {
      throw new Error(`Invalid GCS bucket name: ${bucketName}`)
    }
    if (!storage) throw new TypeError('GcsStorage needs a @google-cloud/storage Storage instance')
    this.bucketName = bucketName
    this.bucket = storage.bucket(bucketName)
  }

  static async create({bucketName}) {
    const {Storage} = await import('@google-cloud/storage')
    return new GcsStorage({bucketName, storage: new Storage()})
  }

  describe() {
    return `gs://${this.bucketName}`
  }

  async list(prefix = '') {
    const [files] = await this.bucket.getFiles({prefix, autoPaginate: true})
    const results = files.map((file) => {
      const size = Number(file.metadata?.size)
      if (!Number.isFinite(size)) throw new Error(`GCS listing returned no size for ${file.name}`)
      return {key: file.name, size}
    })
    results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return results
  }

  async stat(key) {
    assertValidKey(key)
    try {
      const [metadata] = await this.bucket.file(key).getMetadata()
      return {size: Number(metadata.size)}
    } catch (error) {
      if (isStatus(error, 404)) return null
      throw error
    }
  }

  async readBuffer(key) {
    assertValidKey(key)
    const [buffer] = await this.bucket.file(key).download({validation: true})
    return buffer
  }

  async downloadToFile(key, destPath) {
    assertValidKey(key)
    await this.bucket.file(key).download({destination: destPath, validation: true})
  }

  async createFromBuffer(key, buffer, {contentType, metadata} = {}) {
    assertValidKey(key)
    try {
      await this.bucket.file(key).save(buffer, {
        resumable: buffer.length > RESUMABLE_THRESHOLD_BYTES,
        validation: true,
        contentType,
        metadata: metadata ? {metadata} : undefined,
        preconditionOpts: {ifGenerationMatch: 0},
      })
    } catch (error) {
      if (isStatus(error, 412)) throw new ObjectExistsError(key, {cause: error})
      throw error
    }
  }

  async createFromFile(key, srcPath, {contentType, metadata} = {}) {
    assertValidKey(key)
    const {size} = await statFile(srcPath)
    try {
      await this.bucket.upload(srcPath, {
        destination: key,
        resumable: size > RESUMABLE_THRESHOLD_BYTES,
        validation: true,
        contentType,
        metadata: metadata ? {metadata} : undefined,
        preconditionOpts: {ifGenerationMatch: 0},
      })
    } catch (error) {
      if (isStatus(error, 412)) throw new ObjectExistsError(key, {cause: error})
      throw error
    }
  }
}
