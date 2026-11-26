/**
 * Runs the Function's conversion pipeline (convertToMp4: input description, buildFfmpegArgs,
 * MP4 checks, decode check) on every video in a directory, served over local HTTP like the CDN,
 * and cross-checks it with ffprobe: the parsed input (displayed size, audio, duration) against
 * ffprobe's view of the input, and the output (H.264 High, yuv420p, size, audio, no rotation)
 * against ffprobe's view of the output. Nothing is uploaded; outputs are deleted.
 *
 * Usage (from this function's directory; ffmpeg must be 7.0 or newer, see
 * test/convert.integration.ts):
 *   npx tsx scripts/check-originals.ts <directory> [--preset medium] [--json <report.json>]
 */
import {execFile} from 'node:child_process'
import {once} from 'node:events'
import {createReadStream} from 'node:fs'
import {mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {parseArgs, promisify} from 'node:util'

import {convertToMp4} from '../convert'
import {sha1File, sha256File, verifyFfmpegBinary} from '../ffmpeg'
import {rotationSwapsSides} from '../media-info'
import {ConversionFailure} from '../orchestrator'
import {parseSimpleRange} from '../range-proxy'
import {expectedOutputSize, isX264Preset, X264_PRESETS} from '../settings'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi'])

interface ProbeStream {
  codec_type: string
  codec_name: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  channels?: number
  disposition?: {attached_pic?: number}
  side_data_list?: {side_data_type?: string; rotation?: number}[]
}

async function ffprobe(file: string) {
  const {stdout} = await run(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    {
      maxBuffer: 1 << 26,
    },
  )
  return JSON.parse(stdout) as {streams: ProbeStream[]; format: {duration?: string}}
}

async function main() {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {preset: {type: 'string', default: 'medium'}, json: {type: 'string'}},
  })
  const directory = positionals[0]
  if (!directory)
    throw new Error('usage: check-originals.ts <directory> [--preset medium] [--json file]')
  const preset = values.preset
  if (!isX264Preset(preset)) throw new Error(`--preset must be one of ${X264_PRESETS.join(', ')}`)

  const {stdout: resolved} = await run('/bin/sh', ['-c', `command -v "${FFMPEG}"`])
  const ffmpegPath = await verifyFfmpegBinary(resolved.trim(), await sha256File(resolved.trim()))
  const {stdout: version} = await run(ffmpegPath, ['-hide_banner', '-version'])

  const files = (await readdir(directory))
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
  const server = createServer((req, res) => {
    const file = path.join(directory, path.basename(decodeURIComponent(req.url ?? '')))
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const tmp = await mkdtemp(path.join(tmpdir(), 'video-to-mp4-originals-'))

  const rows: Record<string, unknown>[] = []
  let failures = 0
  try {
    for (const name of files) {
      const file = path.join(directory, name)
      const problems: string[] = []
      const started = Date.now()
      const inputProbe = await ffprobe(file)
      const probeVideo = inputProbe.streams.find(
        (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
      )
      const probeRotation =
        probeVideo?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0
      const probeHasAudio = inputProbe.streams.some((s) => s.codec_type === 'audio')
      const swap = rotationSwapsSides(probeRotation)
      const probeDisplay = probeVideo
        ? {
            width: swap ? probeVideo.height! : probeVideo.width!,
            height: swap ? probeVideo.width! : probeVideo.height!,
          }
        : null
      const sha1 = await sha1File(file)
      const {size} = await stat(file)
      try {
        const result = await convertToMp4(
          {
            assetId: `file-${sha1}-${path.extname(name).slice(1).toLowerCase()}`,
            url: `${base}/${encodeURIComponent(name)}`,
            size,
            sha1hash: sha1,
            mimeType: 'video/quicktime',
            originalFilename: name,
          },
          {ffmpegPath, preset, deadline: Date.now() + 840_000, tmpDir: tmp},
        )
        try {
          const parsed = result.input
          if (!probeDisplay) problems.push('ffprobe found no video stream')
          else if (
            parsed.video.displayWidth !== probeDisplay.width ||
            parsed.video.displayHeight !== probeDisplay.height
          ) {
            problems.push(
              `parsed display size ${parsed.video.displayWidth}x${parsed.video.displayHeight}, ffprobe ${probeDisplay.width}x${probeDisplay.height}`,
            )
          }
          if (parsed.hasAudio !== probeHasAudio)
            problems.push(`parsed hasAudio ${parsed.hasAudio}, ffprobe ${probeHasAudio}`)
          const probeDuration = Number(inputProbe.format.duration)
          if (
            parsed.durationSeconds !== null &&
            Math.abs(parsed.durationSeconds - probeDuration) > 0.02
          ) {
            problems.push(`parsed duration ${parsed.durationSeconds}, ffprobe ${probeDuration}`)
          }
          const out = await ffprobe(result.outputPath)
          const v = out.streams.filter((s) => s.codec_type === 'video')
          const a = out.streams.filter((s) => s.codec_type === 'audio')
          const expected = probeDisplay ? expectedOutputSize(probeDisplay) : null
          if (
            v.length !== 1 ||
            v[0].codec_name !== 'h264' ||
            v[0].profile !== 'High' ||
            v[0].pix_fmt !== 'yuv420p'
          ) {
            problems.push(
              `ffprobe output video ${JSON.stringify(v.map((s) => [s.codec_name, s.profile, s.pix_fmt]))}`,
            )
          }
          if (expected && (v[0]?.width !== expected.width || v[0]?.height !== expected.height)) {
            problems.push(
              `ffprobe output ${v[0]?.width}x${v[0]?.height}, expected ${expected.width}x${expected.height}`,
            )
          }
          if (v[0]?.side_data_list?.some((d) => d.rotation !== undefined && d.rotation !== 0))
            problems.push('output still rotated')
          if (
            probeHasAudio
              ? a.length !== 1 || a[0].codec_name !== 'aac' || a[0].channels !== 2
              : a.length !== 0
          ) {
            problems.push(
              `ffprobe output audio ${JSON.stringify(a.map((s) => [s.codec_name, s.channels]))}`,
            )
          }
          rows.push({
            file: name,
            ok: problems.length === 0,
            problems,
            input: `${parsed.video.codec} ${parsed.video.width}x${parsed.video.height}${parsed.video.rotation ? ` rot ${parsed.video.rotation}` : ''}${parsed.hasAudio ? ` + ${parsed.firstAudioCodec}` : ''}`,
            output: `${result.expectedSize.width}x${result.expectedSize.height}${a.length ? ' + aac' : ''}`,
            inputBytes: size,
            outputBytes: result.outputBytes,
            seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
            timings: result.timings,
          })
        } finally {
          await rm(result.workDir, {recursive: true, force: true})
        }
      } catch (error) {
        if (!(error instanceof ConversionFailure)) throw error
        problems.push(`conversion failed: ${error.message}`)
        rows.push({
          file: name,
          ok: false,
          problems,
          seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        })
      }
      if (problems.length > 0) failures += 1
      const row = rows.at(-1)!
      console.log(
        `${row.ok ? 'ok  ' : 'FAIL'} ${name}: ${row.input ?? ''} -> ${row.output ?? ''} in ${row.seconds} s ${problems.join('; ')}`,
      )
    }
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(tmp, {recursive: true, force: true})
  }
  const summary = {ffmpeg: version.split('\n')[0], preset, files: files.length, failures, rows}
  if (values.json) await writeFile(values.json, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(
    `${files.length - failures} of ${files.length} passed (${summary.ffmpeg}, preset ${preset})`,
  )
  if (failures > 0) process.exitCode = 1
}

await main()
