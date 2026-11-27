import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import path from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {setTimeout as delay} from 'node:timers/promises'

export class HttpError extends Error {
  constructor(label, status, bodySnippet) {
    super(`${label} failed with HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ''}`)
    this.name = 'HttpError'
    this.status = status
  }
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

async function readSnippet(response) {
  try {
    const text = await response.text()
    return text.replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch (error) {
    return `(could not read response body: ${error.message})`
  }
}

// fetch() with a per-attempt timeout and retries for network errors, 408, 429
// and 5xx. `label` is used in errors instead of the URL so signed URLs and
// query strings never reach the logs. Only use for idempotent requests.
export async function fetchWithRetry(url, options = {}) {
  const {
    label = 'HTTP request',
    fetchImpl = globalThis.fetch,
    method = 'GET',
    headers,
    body,
    timeoutMs = 120_000,
    attempts = 4,
    retryDelayMs = 1_000,
    sleep = delay,
    acceptStatuses = [],
  } = options
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response
    try {
      response = await fetchImpl(url, {method, headers, body, signal: AbortSignal.timeout(timeoutMs)})
    } catch (error) {
      lastError = new Error(`${label} failed: ${error.message}`, {cause: error})
      if (attempt < attempts) {
        await sleep(retryDelayMs * 2 ** (attempt - 1))
        continue
      }
      throw lastError
    }
    if (response.ok || acceptStatuses.includes(response.status)) return response
    const snippet = await readSnippet(response)
    lastError = new HttpError(label, response.status, snippet)
    if (!isRetriableStatus(response.status) || attempt === attempts) throw lastError
    await sleep(retryDelayMs * 2 ** (attempt - 1))
  }
  throw lastError
}

// Streams a successful response body to destPath while hashing it. Throws if
// the body is shorter or longer than a Content-Length header announced (only
// checked when the body was not content-encoded, because fetch() decodes gzip
// and brotli bodies and Content-Length then describes the encoded size).
export async function saveResponseToFile(response, destPath, {label = 'download'} = {}) {
  if (!response.body) throw new Error(`${label}: response has no body`)
  await mkdir(path.dirname(destPath), {recursive: true})
  const sha1 = createHash('sha1')
  const md5 = createHash('md5')
  const sha256 = createHash('sha256')
  let size = 0
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      sha1.update(chunk)
      md5.update(chunk)
      sha256.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(destPath, {flags: 'wx'}))
  const contentLength = response.headers.get('content-length')
  const contentEncoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase()
  const isIdentity = contentEncoding === '' || contentEncoding === 'identity'
  if (isIdentity && contentLength !== null && contentLength !== '' && Number(contentLength) !== size) {
    throw new Error(`${label}: expected ${contentLength} bytes, received ${size}`)
  }
  return {size, sha1: sha1.digest('hex'), md5: md5.digest('hex'), sha256: sha256.digest('hex')}
}
