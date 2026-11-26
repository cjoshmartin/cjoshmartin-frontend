/**
 * convertToMp4 end to end with a real ffmpeg: generated inputs served by a local HTTP server
 * standing in for the Sanity CDN, both input modes (download to /tmp, and the range proxy), and
 * the failure cases. Outputs are checked by the Function's own inspectMp4 and, independently,
 * by ffprobe.
 *
 * Needs, and fails without (never skips): `ffmpeg` 7.0 or newer and `ffprobe`, with libx265 and
 * libx264, on PATH (or FFMPEG_PATH / FFPROBE_PATH). That ffmpeg generates the inputs and runs
 * the conversions, going through the same sha256 check as the Function's binary. It must be 7.0
 * or newer like the Function's (7.0.2): before 7.0, `-autorotate` took a value and swallowed the
 * `-i` that buildFfmpegArgs puts after it, which is why the macOS ffmpeg-static 6.0 binary that
 * `npm ci` installs here cannot be used. The test also checks that ffmpeg-static resolves.
 * Run with `npm run test:ffmpeg`.
 */
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {once} from 'node:events'
import {createReadStream} from 'node:fs'
import {mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {createServer, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {promisify} from 'node:util'

import {convertToMp4, type SourceVideo} from '../convert'
import {
  FFMPEG_LINUX_ARM64_SHA256,
  FfmpegUnavailableError,
  ffmpegStaticPath,
  sha1File,
  sha256File,
  verifyFfmpegBinary,
} from '../ffmpeg'
import {ConversionFailure} from '../orchestrator'
import {parseSimpleRange} from '../range-proxy'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
const TIMEOUT = 300_000

let workDir = ''
let tmpForConversions = ''
let server: Server
let baseUrl = ''
let binary = ''
const requests: string[] = []

async function generate(name: string, args: string[]): Promise<string> {
  const file = path.join(workDir, name)
  try {
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args, file], {
      maxBuffer: 1 << 26,
    })
  } catch (error) {
    throw new Error(`generating ${name} failed: ${(error as {stderr?: string}).stderr ?? error}`)
  }
  return file
}

async function source(file: string, mimeType = 'video/quicktime'): Promise<SourceVideo> {
  return {
    assetId: `file-${await sha1File(file)}-${path.extname(file).slice(1)}`,
    url: `${baseUrl}/${path.basename(file)}`,
    size: (await stat(file)).size,
    sha1hash: await sha1File(file),
    mimeType,
    originalFilename: path.basename(file),
  }
}

interface ProbeStream {
  codec_type: string
  codec_name: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  channels?: number
  side_data_list?: unknown[]
}

async function ffprobe(
  file: string,
): Promise<{streams: ProbeStream[]; format: {duration: string; tags?: Record<string, string>}}> {
  const {stdout} = await run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ])
  return JSON.parse(stdout)
}

const options = (overrides: Partial<Parameters<typeof convertToMp4>[1]> = {}) => ({
  ffmpegPath: binary,
  preset: 'superfast' as const,
  deadline: Date.now() + 240_000,
  tmpDir: tmpForConversions,
  ...overrides,
})

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'video-to-mp4-it-inputs-'))
  tmpForConversions = await mkdtemp(path.join(tmpdir(), 'video-to-mp4-it-tmp-'))
  const {stdout: resolved} = await run('/bin/sh', ['-c', `command -v "${FFMPEG}"`])
  const ffmpegPath = resolved.trim()
  const {stdout: version} = await run(ffmpegPath, ['-hide_banner', '-version'])
  const major = Number(/^ffmpeg version n?(\d+)/.exec(version)?.[1])
  assert.ok(major >= 7, `${ffmpegPath} is ffmpeg ${major}; the conversion tests need 7.0 or newer`)
  binary = await verifyFfmpegBinary(ffmpegPath, await sha256File(ffmpegPath))
  server = createServer((req, res) => {
    const file = path.join(workDir, path.basename(decodeURIComponent(req.url ?? '')))
    requests.push(`${req.url} ${req.headers.range ?? ''}`)
    stat(file).then(
      ({size}) => {
        const range = parseSimpleRange(req.headers.range)
        const start = range?.start ?? 0
        const end = Math.min(range?.end ?? size - 1, size - 1)
        res.writeHead(range ? 206 : 200, {
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
          ...(range ? {'content-range': `bytes ${start}-${end}/${size}`} : {}),
        })
        createReadStream(file, {start, end}).pipe(res)
      },
      () => {
        res.writeHead(404)
        res.end()
      },
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.closeAllConnections()
  server?.close()
  await rm(workDir, {recursive: true, force: true})
  await rm(tmpForConversions, {recursive: true, force: true})
})

describe('convertToMp4 with a real ffmpeg', {timeout: TIMEOUT}, () => {
  it('rotated iPhone-style HEVC with mono audio and metadata, downloaded to /tmp', async () => {
    const raw = await generate('IMG_raw.MOV', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1440:rate=30:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=3',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-tag:v',
      'hvc1',
      '-pix_fmt',
      'yuvj420p',
      '-c:a',
      'pcm_s16le',
      '-ac',
      '1',
    ])
    // -display_rotation is an input option: add the rotation (and a location tag) by remuxing.
    const input = await generate('IMG_rotated.MOV', [
      '-display_rotation:v:0',
      '-90',
      '-i',
      raw,
      '-map',
      '0',
      '-c',
      'copy',
      '-metadata',
      'location=+52.3667+004.9000/',
    ])
    assert.match(
      (await run(FFPROBE, ['-v', 'error', '-show_streams', input])).stdout,
      /rotation=-?90/,
    )
    const result = await convertToMp4(await source(input), options())
    try {
      assert.equal(result.inputMode, 'download')
      assert.equal(result.input.video.displayWidth, 1440)
      assert.equal(result.input.hasAudio, true)
      assert.deepEqual(result.expectedSize, {width: 1440, height: 1920})
      const video = result.output.tracks.find((t) => t.handler === 'vide')!
      assert.equal(video.width, 1440)
      assert.equal(video.height, 1920)
      assert.equal(video.avc?.profileIdc, 100)
      assert.equal(result.output.faststart, true)

      const probe = await ffprobe(result.outputPath)
      const v = probe.streams.filter((s) => s.codec_type === 'video')
      const a = probe.streams.filter((s) => s.codec_type === 'audio')
      assert.equal(v.length, 1)
      assert.equal(v[0].codec_name, 'h264')
      assert.equal(v[0].profile, 'High')
      assert.equal(v[0].pix_fmt, 'yuv420p')
      assert.equal(v[0].width, 1440)
      assert.equal(v[0].height, 1920)
      assert.equal(v[0].side_data_list, undefined, 'no display matrix left')
      assert.equal(a.length, 1)
      assert.equal(a[0].codec_name, 'aac')
      assert.equal(a[0].channels, 2)
      assert.equal(probe.format.tags?.location, undefined, 'location stripped')
      assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2)
    } finally {
      await rm(result.workDir, {recursive: true, force: true})
    }
  })

  it('4K landscape without audio, moov at the end, read through the range proxy', async () => {
    const input = await generate('screen.mov', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=3840x2160:rate=30:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
    ])
    requests.length = 0
    const result = await convertToMp4(await source(input), options({downloadLimitBytes: 0}))
    try {
      assert.equal(result.inputMode, 'proxy')
      assert.ok(
        requests.some((r) => r.includes('bytes=')),
        'ffmpeg made range requests',
      )
      const probe = await ffprobe(result.outputPath)
      assert.deepEqual(
        probe.streams.map((s) => [s.codec_type, s.codec_name, s.width, s.height]),
        [['video', 'h264', 1920, 1080]],
      )
      const entries = await readdir(result.workDir)
      assert.deepEqual(entries, ['output.mp4'], 'proxy mode keeps only the output in /tmp')
    } finally {
      await rm(result.workDir, {recursive: true, force: true})
    }
  })

  it('skips cover art and keeps the first audio stream when audio comes first', async () => {
    const cover = await generate('cover.png', [
      '-f',
      'lavfi',
      '-i',
      'color=red:size=64x64',
      '-frames:v',
      '1',
    ])
    const input = await generate('audio-first.mp4', [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:sample_rate=48000:duration=2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:duration=2',
      '-i',
      cover,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-map',
      '2:v',
      '-c:a',
      'aac',
      '-c:v:0',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:v:1',
      'png',
      '-disposition:v:1',
      'attached_pic',
    ])
    const result = await convertToMp4(await source(input, 'video/mp4'), options())
    try {
      const probe = await ffprobe(result.outputPath)
      assert.deepEqual(
        probe.streams.map((s) => [s.codec_type, s.codec_name, s.width ?? s.channels]),
        [
          ['video', 'h264', 640],
          ['audio', 'aac', 2],
        ],
      )
    } finally {
      await rm(result.workDir, {recursive: true, force: true})
    }
  })

  it('fails with a readable message for a file that is not a video (renamed .mov)', async () => {
    const fake = path.join(workDir, 'not-a-video.mov')
    await writeFile(fake, randomBytes(200_000))
    await assert.rejects(convertToMp4(await source(fake), options()), (error: unknown) => {
      assert.ok(error instanceof ConversionFailure, String(error))
      assert.match(error.message, /could not be read as a video/)
      return true
    })
    assert.deepEqual(await readdir(tmpForConversions), [], 'work directory removed')
  })

  it('fails for an audio-only file and for a non-video MIME type', async () => {
    const audio = await generate('voice.m4a', [
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:a',
      'aac',
    ])
    await assert.rejects(
      convertToMp4(await source(audio, 'video/mp4'), options()),
      /no video stream, only audio \(aac\)/,
    )
    await assert.rejects(
      convertToMp4(await source(audio, 'audio/mp4'), options()),
      /not a video \(audio\/mp4\)/,
    )
  })

  it('fails when the download does not match the asset (size or sha1)', async () => {
    const input = await generate('small.mp4', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:duration=1',
      '-c:v',
      'libx264',
    ])
    const bad = {...(await source(input)), sha1hash: '0'.repeat(40)}
    await assert.rejects(
      convertToMp4(bad, options()),
      /Could not download the uploaded file \(sha1/,
    )
  })

  it('stops ffmpeg at the deadline and says so', async () => {
    const input = await generate('long.mov', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=3840x2160:rate=30:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
    ])
    const src = await source(input)
    const started = Date.now()
    await assert.rejects(
      convertToMp4(src, options({preset: 'veryslow', deadline: Date.now() + 4000})),
      /took longer than the Function allows/,
    )
    assert.ok(Date.now() - started < 15_000, 'killed promptly')
  })

  it('refuses a binary whose sha256 is not the expected one (fail closed)', async () => {
    await assert.rejects(verifyFfmpegBinary(binary, '0'.repeat(64)), FfmpegUnavailableError)
    // This machine's ffmpeg-static binary is not the Lambda build, so the Function's check refuses it.
    const packaged = await ffmpegStaticPath()
    assert.match(packaged, /node_modules\/ffmpeg-static\/ffmpeg$/)
    await assert.rejects(
      verifyFfmpegBinary(packaged, FFMPEG_LINUX_ARM64_SHA256),
      /redeploy the Function/,
    )
  })
})
