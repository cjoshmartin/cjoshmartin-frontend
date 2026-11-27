import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'

import {ObjectExistsError} from './storage/errors.mjs'

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// Streams the file through sha1, so a large video never has to fit in memory.
export async function sha1OfFile(filePath) {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`
}

// Runs `worker` over `items` with at most `limit` in flight. After the first
// failure no new items start; the first error is rethrown once the in-flight
// ones settle.
export async function runPool(items, limit, worker) {
  let next = 0
  let failure = null
  const runnerCount = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({length: runnerCount}, async () => {
    while (failure === null && next < items.length) {
      const item = items[next++]
      try {
        await worker(item)
      } catch (error) {
        if (failure === null) failure = error
      }
    }
  })
  await Promise.all(runners)
  if (failure !== null) throw failure
}

// Create-only upload of a local file. Returns true when this call created the
// object and false when an object of the same size already existed, which
// happens when a retried request had in fact succeeded or a concurrent run
// stored the same content-addressed file. A size mismatch throws.
export async function createFileOnce(storage, key, srcPath, expectedSize, options) {
  try {
    await storage.createFromFile(key, srcPath, options)
    return true
  } catch (error) {
    if (!(error instanceof ObjectExistsError)) throw error
    const existing = await storage.stat(key)
    if (existing && existing.size === expectedSize) return false
    throw new Error(`${key} already exists with ${existing?.size ?? 'unknown'} bytes, expected ${expectedSize}`, {cause: error})
  }
}

// Create-only upload of a buffer. Returns true when created, false when an
// identical object already existed (a retried request that had succeeded).
// Different existing content throws: snapshots and markers are never replaced.
export async function createBufferOnce(storage, key, buffer, options) {
  try {
    await storage.createFromBuffer(key, buffer, options)
    return true
  } catch (error) {
    if (!(error instanceof ObjectExistsError)) throw error
    const existing = await storage.readBuffer(key)
    if (Buffer.compare(existing, buffer) === 0) return false
    throw new Error(`${key} already exists with different content; refusing to overwrite it`, {cause: error})
  }
}
