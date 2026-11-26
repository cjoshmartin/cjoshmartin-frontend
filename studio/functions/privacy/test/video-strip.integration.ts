/**
 * Media test of the video stripper (`npm run test:media`). Makes videos with ffmpeg and tags them
 * with exiftool and ffmpeg metadata (QuickTime Keys and UserData GPS coordinates, make, model,
 * author, comments, creation dates), adds the tracks iPhones and cameras add (timecode, subtitles,
 * chapters), strips them with stripVideo, and checks the result with the tools, not the stripper:
 * - exiftool -ee -a -G1 finds no personal tag, no marker string and no non-zero creation date;
 * - ffprobe: only the video and audio streams are left, with the same codec, pixel format, colour
 *   description, rotation and side data;
 * - ffmpeg (stream copy) gives every kept stream the same sha256 (streamhash) and every packet the
 *   same size and MD5 (framemd5).
 *
 * By default stripVideo runs the ffmpeg on PATH. With FFMPEG_LINUX_ARM64 set to ffmpeg-static
 * 5.3.0's linux-arm64 binary it runs the Function's own ffmpeg 7.0.2 in Docker (see
 * ffmpeg-runner.ts). With PRIVACY_VIDEOS_DIR set (for example ~/cjoshmartin-migration/gcs/media),
 * every video in it is checked as well, and an iPhone clip with Dolby Vision must keep it.
 */
import assert from 'node:assert/strict'
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {stripVideo} from '../video-strip'
import {ffmpegRunner, LINUX_FFMPEG} from './ffmpeg-runner'
import {exiftoolTags, personalTags, tool} from './media-tools'

const MARKERS = ['TestCamera', 'TestPerson', 'TestSerial', 'TestComment', 'TestPlace']
const dir = mkdtempSync(path.join(os.tmpdir(), 'video-strip-'))

function ffmpeg(args: string[]): void {
  tool('ffmpeg', ['-v', 'error', '-y', ...args])
}

interface ProbeStream {
  codec_type: string
  codec_name: string
  pix_fmt?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  sample_rate?: string
  channels?: number
  side_data_list?: Record<string, unknown>[]
}

function probe(file: string): ProbeStream[] {
  const out = tool('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString('utf8')
  return (JSON.parse(out) as {streams: ProbeStream[]}).streams
}

/** What playback needs from a stream; the same before and after stripping. */
function playback(stream: ProbeStream) {
  return {
    codec: stream.codec_name,
    pix_fmt: stream.pix_fmt,
    color: [stream.color_range, stream.color_space, stream.color_transfer, stream.color_primaries].join('/'),
    sample_rate: stream.sample_rate,
    channels: stream.channels,
    side_data: (stream.side_data_list ?? []).map((d) => JSON.stringify(d)).sort(),
  }
}

/** streamhash (sha256) and framemd5 payload lines of the given streams, by the local ffmpeg. */
function packets(file: string, streams: number[]): {hashes: string[]; payloads: string[][]} {
  const maps = streams.flatMap((i) => ['-map', `0:${i}`])
  const hashes = tool('ffmpeg', ['-v', 'error', '-i', file, ...maps, '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-'])
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^\d+,/, ''))
  const frames = tool('ffmpeg', ['-v', 'error', '-i', file, ...maps, '-c', 'copy', '-f', 'framemd5', '-']).toString('utf8')
  const payloads: string[][] = streams.map(() => [])
  for (const line of frames.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(',').map((p) => p.trim())
    payloads[Number(parts[0])].push(`${parts[4]},${parts[5]}`)
  }
  return {hashes, payloads}
}

async function stripAndCheck(input: string, options: {markers?: string[]; dolbyVision?: boolean} = {}) {
  const workDir = path.join(dir, `work-${path.basename(input).replace(/[^A-Za-z0-9.]/g, '_')}`)
  mkdirSync(workDir, {recursive: true})
  const {output, report} = await stripVideo({
    ffmpeg: ffmpegRunner([path.dirname(input), workDir]),
    input,
    workDir,
    head: new Uint8Array(readFileSync(input).subarray(0, 64)),
  })

  const tags = exiftoolTags(output)
  assert.deepEqual(personalTags(tags, options.markers ?? MARKERS), [], `${input}: no personal tags left`)
  assert.ok(!readFileSync(output).toString('latin1').includes('Test'), `${input}: no marker bytes in the file`)

  const before = probe(input)
  const after = probe(output)
  const kept = before
    .map((s, i) => ({s, i}))
    .filter(({s}) => (s.codec_type === 'video' && !(s as {disposition?: {attached_pic?: number}}).disposition?.attached_pic) || s.codec_type === 'audio')
  assert.deepEqual(
    after.map((s) => s.codec_type),
    kept.map(({s}) => s.codec_type),
    `${input}: only the video and audio streams are left, in order`,
  )
  kept.forEach(({s}, j) => {
    const expected = playback(s)
    if (report.notes.some((n) => n.includes('could not be kept'))) {
      expected.side_data = expected.side_data.filter((d) => !d.includes('DOVI'))
    }
    assert.deepEqual(playback(after[j]), expected, `${input}: stream ${j} keeps codec, colour, rotation and side data`)
  })
  if (options.dolbyVision) {
    assert.ok(after[0].side_data_list?.some((d) => d.side_data_type === 'DOVI configuration record'), `${input}: Dolby Vision kept`)
  }

  const a = packets(input, kept.map(({i}) => i))
  const b = packets(output, kept.map((_, j) => j))
  assert.deepEqual(b.hashes, a.hashes, `${input}: every stream's packets have the same sha256`)
  kept.forEach(({s}, j) => {
    if (s.codec_name.startsWith('pcm_')) return // PCM packets are cut from the chunks; the sha256 covers them
    assert.deepEqual(b.payloads[j], a.payloads[j], `${input}: stream ${j} packets have the same sizes and MD5s`)
  })
  return {output, report}
}

test('strips a QuickTime video: GPS keys, user data, timecode, subtitles, chapters; keeps rotation and colour', async () => {
  const raw = path.join(dir, 'raw.mov')
  const chapters = path.join(dir, 'chapters.txt')
  writeFileSync(chapters, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=TestPlace chapter\n')
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-f', 'mov', raw,
  ])
  // Rotation, subtitles, a timecode track, chapters and QuickTime metadata keys, by stream copy.
  const input = path.join(dir, 'tagged.mov')
  ffmpeg([
    '-display_rotation:v:0', '-90', '-i', raw,
    '-f', 'srt', '-i', subtitleFile(),
    '-i', chapters,
    '-map', '0:v', '-map', '0:a', '-map', '1:s', '-map_chapters', '2',
    '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
    '-metadata:s:v:0', 'timecode=01:02:03:04',
    '-movflags', '+use_metadata_tags',
    '-metadata', 'com.apple.quicktime.location.ISO6709=+51.5000-000.1200+012.000/',
    '-metadata', 'com.apple.quicktime.make=TestCameraMake',
    '-metadata', 'com.apple.quicktime.model=TestCameraModel',
    '-metadata', 'comment=TestComment',
    '-metadata', 'creation_time=2020-01-02T03:04:05Z',
    '-metadata:s:v:0', 'handler_name=TestCameraHandler',
    '-f', 'mov', input,
  ])
  tool('exiftool', ['-q', '-overwrite_original', '-UserData:GPSCoordinates=51.5, -0.12, 12', '-UserData:Author=TestPersonName', '-Keys:Author=TestPersonName', '-Keys:Make=TestCameraMake', input])
  assert.ok(personalTags(exiftoolTags(input), MARKERS).length > 0, 'the fixture has personal tags')
  assert.ok(probe(input).some((s) => s.codec_type === 'data'), 'the fixture has a timecode track')

  const {report} = await stripAndCheck(input)
  assert.equal(report.muxer, 'mov')
  assert.ok(report.removed.some((r) => r.includes('com.apple.quicktime.location.ISO6709')))
  assert.ok(report.removed.some((r) => r.includes('subtitle stream')))
})

test('strips an MP4 with 10-bit HLG HEVC, PCM-free audio, rotation and GPS user data', async () => {
  const raw = path.join(dir, 'raw.mp4')
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=2',
    '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-c:a', 'aac', '-metadata', 'title=TestPlace holiday', '-metadata', 'artist=TestPersonName', raw,
  ])
  const input = path.join(dir, 'tagged.mp4')
  ffmpeg(['-display_rotation:v:0', '90', '-i', raw, '-map', '0', '-c', 'copy', '-map_metadata', '0', input])
  tool('exiftool', ['-q', '-overwrite_original', '-UserData:GPSCoordinates=51.5, -0.12, 12', '-UserData:Make=TestCameraMake', '-XMP-dc:Creator=TestPersonName', input])
  const {report} = await stripAndCheck(input)
  assert.equal(report.muxer, 'mp4')
})

test('strips PCM audio in QuickTime (like iPhone clips with mono PCM)', async () => {
  const input = path.join(dir, 'pcm.mov')
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '1',
    '-movflags', '+use_metadata_tags', '-metadata', 'com.apple.quicktime.location.ISO6709=+51.5000-000.1200/',
    '-f', 'mov', input,
  ])
  const {report} = await stripAndCheck(input)
  assert.equal(report.muxer, 'mov')
})

test('strips a Matroska/WebM video: tags, subtitles and attachments', async () => {
  const input = path.join(dir, 'tagged.mkv')
  const font = path.join(dir, 'TestPersonName.txt')
  writeFileSync(font, 'TestPersonName attachment')
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=1',
    '-f', 'srt', '-i', subtitleFile(),
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus', '-c:s', 'webvtt',
    '-attach', font, '-metadata:s:t', 'mimetype=text/plain',
    '-metadata', 'LOCATION=+51.5000-000.1200/', '-metadata', 'ARTIST=TestPersonName', '-metadata', 'COMMENT=TestComment',
    '-metadata:s:v:0', 'title=TestCameraTrack',
    '-f', 'matroska', input,
  ])
  const {report} = await stripAndCheck(input)
  assert.equal(report.muxer, 'webm')
})

let subtitles: string | undefined
function subtitleFile(): string {
  if (!subtitles) {
    subtitles = path.join(dir, 'subs.srt')
    writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:01,000\nTestPlace subtitle\n')
  }
  return subtitles
}

const videos = process.env.PRIVACY_VIDEOS_DIR
test('every video in PRIVACY_VIDEOS_DIR strips losslessly', {skip: !videos || !existsSync(videos)}, async () => {
  for (const name of readdirSync(videos!).sort()) {
    const input = path.join(videos!, name)
    const dolbyVision = probe(input).some((s) => s.side_data_list?.some((d) => d.side_data_type === 'DOVI configuration record'))
    const {report} = await stripAndCheck(input, {markers: [], dolbyVision: dolbyVision && Boolean(LINUX_FFMPEG)})
    if (dolbyVision) assert.equal(report.muxer, 'mp4', `${name}: written as MP4 to keep Dolby Vision`)
  }
})
