/**
 * The range proxy against a local "CDN" server: plain and ranged reads return the right bytes,
 * a connection that breaks mid-response is resumed with a new range request, and a client that
 * hangs up (ffmpeg seeking) stops the upstream read.
 */
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {once} from 'node:events'
import {createServer, request as httpRequest, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {after, before, describe, it} from 'node:test'

import {parseSimpleRange, startRangeProxy} from '../range-proxy'

const DATA = randomBytes(3 * 1024 * 1024)
let cdn: Server
let cdnUrl = ''
/** Requests whose body the "CDN" cuts after this many bytes (one-shot per request count). */
let breakNextAfter: number | null = null
const cdnRanges: string[] = []

before(async () => {
  cdn = createServer((req, res) => {
    const range = parseSimpleRange(req.headers.range)
    cdnRanges.push(req.headers.range ?? '(none)')
    const start = range?.start ?? 0
    const end = range?.end ?? DATA.length - 1
    const body = DATA.subarray(start, end + 1)
    res.writeHead(range ? 206 : 200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'video/quicktime',
      ...(range ? {'content-range': `bytes ${start}-${end}/${DATA.length}`} : {}),
    })
    if (breakNextAfter !== null) {
      const cut = breakNextAfter
      breakNextAfter = null
      res.write(body.subarray(0, cut), () => res.destroy())
      return
    }
    res.end(body)
  })
  cdn.listen(0, '127.0.0.1')
  await once(cdn, 'listening')
  cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/file`
})

after(() => {
  cdn.closeAllConnections()
  cdn.close()
})

function get(
  url: string,
  range?: string,
): Promise<{status: number; headers: Record<string, unknown>; body: Buffer}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {headers: range ? {range} : {}}, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('startRangeProxy', () => {
  it('parses simple ranges only', () => {
    assert.deepEqual(parseSimpleRange('bytes=10-'), {start: 10})
    assert.deepEqual(parseSimpleRange('bytes=10-19'), {start: 10, end: 19})
    assert.equal(parseSimpleRange('bytes=-500'), null)
    assert.equal(parseSimpleRange(undefined), null)
  })

  it('serves the whole file and ranges with the CDN headers', async () => {
    const proxy = await startRangeProxy(cdnUrl)
    try {
      const whole = await get(proxy.url)
      assert.equal(whole.status, 200)
      assert.ok(whole.body.equals(DATA))
      const part = await get(proxy.url, 'bytes=1000-1999')
      assert.equal(part.status, 206)
      assert.equal(part.headers['content-range'], `bytes 1000-1999/${DATA.length}`)
      assert.ok(part.body.equals(DATA.subarray(1000, 2000)))
      const tail = await get(proxy.url, `bytes=${DATA.length - 10}-`)
      assert.ok(tail.body.equals(DATA.subarray(DATA.length - 10)))
      assert.equal(proxy.stats.errors.length, 0)
    } finally {
      await proxy.close()
    }
  })

  it('resumes a response the CDN cut off, so the client still gets every byte', async () => {
    const proxy = await startRangeProxy(cdnUrl)
    try {
      cdnRanges.length = 0
      breakNextAfter = 700_000
      const result = await get(proxy.url, 'bytes=100-')
      assert.equal(result.status, 206)
      assert.ok(result.body.equals(DATA.subarray(100)), 'same bytes as the file')
      assert.equal(proxy.stats.resumes, 1)
      assert.deepEqual(cdnRanges, ['bytes=100-', `bytes=${100 + 700_000}-`])
    } finally {
      await proxy.close()
    }
  })

  it('stops reading upstream when the client hangs up', async () => {
    const proxy = await startRangeProxy(cdnUrl)
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(proxy.url, (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        })
        req.on('error', (error) =>
          (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve() : reject(error),
        )
        req.end()
      })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(proxy.stats.errors.length, 0, JSON.stringify(proxy.stats.errors))
      assert.ok(proxy.stats.bytes < DATA.length)
    } finally {
      await proxy.close()
    }
  })
})
