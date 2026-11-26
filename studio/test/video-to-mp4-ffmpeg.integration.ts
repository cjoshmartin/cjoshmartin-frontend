/**
 * Runs buildFfmpegArgs through a real ffmpeg on small generated videos and checks the MP4 with
 * ffprobe: dimensions (landscape, portrait, small, rotated), H.264 High yuv420p limited range,
 * AAC stereo or no audio, no input metadata, no rotation left in the output, moov before mdat.
 *
 * Needs ffmpeg and ffprobe with libx264 (FFMPEG_PATH / FFPROBE_PATH, or on PATH). It fails when
 * they are missing instead of skipping. Run with `npm run test:ffmpeg` (not part of `npm test`).
 */
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp, open, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'
import {promisify} from 'node:util'

import {
  buildFfmpegArgs,
  expectedOutputSize,
  type FfmpegArgsOptions,
} from '../functions/video-to-mp4/settings'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
const TIMEOUT = 120_000

interface ProbeStream {
  index: number
  codec_type: string
  codec_name: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  color_range?: string
  channels?: number
  bit_rate?: string
  disposition?: Record<string, number>
  side_data_list?: Array<{side_data_type?: string; rotation?: number}>
}

interface Probe {
  streams: ProbeStream[]
  format: {format_name: string; tags?: Record<string, string>}
}

let workDir = ''

async function ffmpeg(args: string[]) {
  try {
    await run(FFMPEG, args, {maxBuffer: 64 * 1024 * 1024})
  } catch (error) {
    const stderr = (error as {stderr?: string}).stderr ?? ''
    throw new Error(`ffmpeg ${args.join(' ')} failed:\n${stderr.slice(-2000)}`, {cause: error})
  }
}

async function probe(file: string): Promise<Probe> {
  const {stdout} = await run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ])
  return JSON.parse(stdout) as Probe
}

/** Top-level MP4 box types in file order. */
async function topLevelBoxes(file: string): Promise<string[]> {
  const handle = await open(file, 'r')
  try {
    const {size} = await handle.stat()
    const types: string[] = []
    const header = Buffer.alloc(16)
    let offset = 0
    while (offset + 8 <= size) {
      await handle.read(header, 0, 16, offset)
      let boxSize = header.readUInt32BE(0)
      types.push(header.toString('latin1', 4, 8))
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8))
      if (boxSize === 0) break // box runs to the end of the file
      if (boxSize < 8) throw new Error(`Invalid box size ${boxSize} at ${offset} in ${file}`)
      offset += boxSize
    }
    return types
  } finally {
    await handle.close()
  }
}

/** Generates a fixture with lavfi sources. `extra` comes after the inputs (maps, codecs, ...). */
async function fixture(name: string, inputs: string[], extra: string[]): Promise<string> {
  const file = join(workDir, name)
  await ffmpeg(['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputs, ...extra, file])
  return file
}

const testVideo = (size: string) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10`]
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
const quickH264 = ['-c:v', 'libx264', '-preset', 'superfast']

async function convert(input: string, options: Omit<FfmpegArgsOptions, 'input' | 'output'>) {
  const output = join(workDir, `${input.split('/').pop()}.out.mp4`)
  await ffmpeg(buildFfmpegArgs({input, output, ...options}))
  return {output, info: await probe(output)}
}

function videoStreams(info: Probe) {
  return info.streams.filter((stream) => stream.codec_type === 'video')
}

function audioStreams(info: Probe) {
  return info.streams.filter((stream) => stream.codec_type === 'audio')
}

/** Checks everything SETTINGS_VERSION promises about the video stream and the container. */
async function assertMp4Settings(
  output: string,
  info: Probe,
  size: {width: number; height: number},
) {
  assert.match(info.format.format_name, /mp4/)
  const videos = videoStreams(info)
  assert.equal(videos.length, 1, 'exactly one video stream')
  const [video] = videos
  assert.equal(video.codec_name, 'h264')
  assert.equal(video.profile, 'High')
  assert.equal(video.pix_fmt, 'yuv420p')
  // Limited range. libx264 only signals the range when the input also has colour tags; without a
  // signal H.264 means limited range, and ffprobe leaves color_range out or says "unknown".
  assert.ok(
    video.color_range === undefined || ['tv', 'unknown'].includes(video.color_range),
    `limited range, got ${video.color_range}`,
  )
  assert.equal(video.width, size.width)
  assert.equal(video.height, size.height)
  const rotation = (video.side_data_list ?? []).filter(
    (data) => data.side_data_type === 'Display Matrix' && data.rotation !== 0,
  )
  assert.deepEqual(rotation, [], 'no rotation left in the output')
  assert.ok(
    info.streams.every((stream) => ['video', 'audio'].includes(stream.codec_type)),
    'no data or subtitle streams',
  )
  const boxes = await topLevelBoxes(output)
  assert.ok(boxes.includes('moov') && boxes.includes('mdat'), boxes.join(','))
  assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'), `faststart: ${boxes.join(',')}`)
}

function assertStereoAac(info: Probe) {
  const audios = audioStreams(info)
  assert.equal(audios.length, 1, 'exactly one audio stream')
  const [audio] = audios
  assert.equal(audio.codec_name, 'aac')
  assert.equal(audio.channels, 2)
  const bitRate = Number(audio.bit_rate)
  assert.ok(bitRate > 115_000 && bitRate < 141_000, `about 128 kb/s, got ${audio.bit_rate}`)
}

describe('buildFfmpegArgs with a real ffmpeg', {timeout: 10 * TIMEOUT}, () => {
  before(async () => {
    try {
      const {stdout} = await run(FFMPEG, ['-hide_banner', '-encoders'])
      if (!/libx264/.test(stdout)) throw new Error(`${FFMPEG} has no libx264 encoder`)
      await run(FFPROBE, ['-version'])
    } catch (error) {
      throw new Error(
        'These tests need ffmpeg with libx264 and ffprobe. Install them or set FFMPEG_PATH and FFPROBE_PATH.',
        {cause: error},
      )
    }
    workDir = await mkdtemp(join(tmpdir(), 'video-to-mp4-test-'))
  })

  after(async () => {
    if (workDir) await rm(workDir, {recursive: true, force: true})
  })

  it('landscape 4K with mono audio and metadata, default preset', {timeout: TIMEOUT}, async () => {
    const input = await fixture(
      'landscape.mov',
      [...testVideo('3840x2160'), ...tone],
      [
        '-t',
        '2',
        ...quickH264,
        // Full-range input, like iPhone yuvj420p videos.
        '-pix_fmt',
        'yuvj420p',
        '-c:a',
        'aac',
        '-ac',
        '1',
        '-metadata',
        'title=private title',
        '-metadata',
        'location=+52.3676+004.9041/',
        '-metadata',
        'creation_time=2024-05-05T12:00:00Z',
      ],
    )
    const {output, info} = await convert(input, {hasAudio: true})
    await assertMp4Settings(output, info, {width: 1920, height: 1080})
    assertStereoAac(info)
    const tags = Object.keys(info.format.tags ?? {})
    for (const tag of ['title', 'location', 'creation_time']) {
      assert.ok(!tags.includes(tag), `${tag} stripped (tags: ${tags.join(', ')})`)
    }
    for (const stream of info.streams) {
      const streamTags = (stream as {tags?: Record<string, string>}).tags ?? {}
      assert.ok(!('creation_time' in streamTags), 'stream creation_time stripped')
    }
  })

  it('portrait taller than the limit, no audio', {timeout: TIMEOUT}, async () => {
    const input = await fixture('portrait.mp4', testVideo('1080x2400'), ['-t', '1', ...quickH264])
    const {output, info} = await convert(input, {hasAudio: false, preset: 'veryfast'})
    await assertMp4Settings(output, info, {width: 864, height: 1920})
    assert.equal(audioStreams(info).length, 0, 'no audio track')
  })

  it('small video with odd sides is not upscaled', {timeout: TIMEOUT}, async () => {
    // libx264 cannot encode odd sizes in 4:2:0, so the fixture is lossless RGB in Matroska.
    const input = await fixture('small.mkv', testVideo('641x361'), [
      '-t',
      '1',
      '-c:v',
      'libx264rgb',
      '-preset',
      'superfast',
      '-qp',
      '0',
    ])
    const {output, info} = await convert(input, {hasAudio: false, preset: 'superfast'})
    const size = expectedOutputSize({width: 641, height: 361})
    assert.deepEqual(size, {width: 640, height: 360})
    await assertMp4Settings(output, info, size)
  })

  it('applies rotation metadata to the pixels', {timeout: TIMEOUT}, async () => {
    const plain = await fixture(
      'plain.mp4',
      [...testVideo('1920x1440'), ...tone],
      ['-t', '1', ...quickH264, '-c:a', 'aac'],
    )
    // Same stream with a 90 degree display rotation, like a portrait iPhone video.
    const rotated = join(workDir, 'rotated.mov')
    await ffmpeg([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-display_rotation:v:0',
      '90',
      '-i',
      plain,
      '-c',
      'copy',
      rotated,
    ])
    const source = await probe(rotated)
    assert.ok(
      videoStreams(source)[0].side_data_list?.some((data) => Math.abs(data.rotation ?? 0) === 90),
      'fixture carries a rotation',
    )
    const {output, info} = await convert(rotated, {hasAudio: true, preset: 'superfast'})
    await assertMp4Settings(output, info, {width: 1440, height: 1920})
    assertStereoAac(info)
  })

  it(
    'maps the video when audio is the first stream, and drops cover art',
    {timeout: TIMEOUT},
    async () => {
      const cover = await fixture(
        'cover.png',
        ['-f', 'lavfi', '-i', 'color=c=red:size=320x320'],
        ['-frames:v', '1'],
      )
      const input = await fixture(
        'audio-first.mp4',
        [...testVideo('1280x720'), ...tone, '-i', cover],
        [
          '-t',
          '1',
          '-map',
          '1:a',
          '-map',
          '0:v',
          '-map',
          '2:v',
          '-c:a',
          'aac',
          '-c:v:0',
          'libx264',
          '-preset',
          'superfast',
          '-c:v:1',
          'mjpeg',
          '-disposition:v:1',
          'attached_pic',
        ],
      )
      const source = await probe(input)
      assert.equal(source.streams[0].codec_type, 'audio', 'fixture has audio first')
      assert.ok(
        source.streams.some((stream) => stream.disposition?.attached_pic === 1),
        'fixture has cover art',
      )
      const {output, info} = await convert(input, {hasAudio: true, preset: 'superfast'})
      await assertMp4Settings(output, info, {width: 1280, height: 720})
      assertStereoAac(info)
    },
  )
})
