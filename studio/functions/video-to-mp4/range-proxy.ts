/**
 * Local HTTP proxy so ffmpeg can read a large upload straight from the Sanity CDN.
 *
 * The static ffmpeg build cannot resolve host names in Lambda (a fully static glibc has no NSS:
 * "Failed to resolve hostname cdn.sanity.io"), so it never gets an https URL. For uploads too
 * large to download to the 512 MB /tmp first, ffmpeg reads http://127.0.0.1:<port>/input and this
 * server forwards each request, Range header included, to the CDN with Node's fetch. ffmpeg can
 * still seek (for example to a `moov` box at the end of the file). If the CDN connection breaks
 * mid-response, the proxy continues the same response from the byte it reached with a new range
 * request, up to MAX_RESUMES times.
 */
import {once} from 'node:events'
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'

export interface RangeProxyStats {
  requests: number
  bytes: number
  resumes: number
  errors: string[]
}

export interface RangeProxy {
  url: string
  stats: RangeProxyStats
  close(): Promise<void>
}

const MAX_RESUMES = 3
const PASSED_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'content-type',
  'last-modified',
  'etag',
]

/** `bytes=<start>-[<end>]`; other forms (suffix ranges, several ranges) are passed through as-is. */
export function parseSimpleRange(header: string | undefined): {start: number; end?: number} | null {
  if (!header) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!match) return null
  return {start: Number(match[1]), ...(match[2] === '' ? {} : {end: Number(match[2])})}
}

export async function startRangeProxy(
  target: string,
  options: {fetchImpl?: typeof fetch; signal?: AbortSignal} = {},
): Promise<RangeProxy> {
  const fetchImpl = options.fetchImpl ?? fetch
  const stats: RangeProxyStats = {requests: 0, bytes: 0, resumes: 0, errors: []}
  const recordError = (message: string) => {
    if (stats.errors.length < 10) stats.errors.push(message)
  }

  async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    options.signal?.addEventListener('abort', abortUpstream)
    // ffmpeg closes the connection whenever it seeks; stop reading from the CDN then.
    let clientGone = false
    response.on('close', () => {
      if (!response.writableFinished) {
        clientGone = true
        controller.abort()
      }
    })
    try {
      const rangeHeader = request.headers.range
      const headers: Record<string, string> = {'accept-encoding': 'identity'}
      if (rangeHeader) headers.range = rangeHeader
      const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
      const first = await fetchImpl(target, {method, headers, signal: controller.signal})
      const passHeaders: Record<string, string> = {}
      for (const name of PASSED_HEADERS) {
        const value = first.headers.get(name)
        if (value) passHeaders[name] = value
      }
      response.writeHead(first.status, passHeaders)
      if (method === 'HEAD' || !first.body) {
        response.end()
        return
      }

      const range = parseSimpleRange(rangeHeader)
      const canResume = first.ok && (range !== null || !rangeHeader)
      const start = range?.start ?? 0
      let sent = 0
      let body: ReadableStream<Uint8Array> = first.body
      for (;;) {
        try {
          for await (const chunk of body) {
            if (clientGone) return
            sent += chunk.length
            stats.bytes += chunk.length
            if (!response.write(chunk)) await once(response, 'drain')
          }
          break
        } catch (error) {
          if (clientGone || options.signal?.aborted) return
          if (!canResume || stats.resumes >= MAX_RESUMES) throw error
          stats.resumes += 1
          const from = start + sent
          const next = await fetchImpl(target, {
            headers: {'accept-encoding': 'identity', range: `bytes=${from}-${range?.end ?? ''}`},
            signal: controller.signal,
          })
          if (next.status !== 206 || !next.body) {
            throw new Error(`resuming at byte ${from} returned HTTP ${next.status}`, {cause: error})
          }
          recordError(`resumed at byte ${from} after: ${(error as Error).message}`)
          body = next.body
        }
      }
      response.end()
    } finally {
      options.signal?.removeEventListener('abort', abortUpstream)
    }
  }

  const server = createServer((request, response) => {
    stats.requests += 1
    forward(request, response).catch((error: unknown) => {
      recordError((error as Error).message ?? String(error))
      if (!response.headersSent) response.writeHead(502)
      response.destroy()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const {port} = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/input`,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
