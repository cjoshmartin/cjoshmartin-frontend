/**
 * Unit tests of the video stripper's parsing, planning and checks, with ffmpeg output written out
 * by hand (the values are made up). The media tests (video-strip.integration.ts) run ffmpeg.
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  checkStrippedDescription,
  comparePackets,
  describeContainer,
  majorBrand,
  parseFrameMd5,
  parseStreamHash,
  planStrip,
  stripArgs,
  VideoStripError,
  type ContainerDescription,
} from '../video-strip'

const IPHONE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mov':
  Metadata:
    major_brand     : qt  
    minor_version   : 0
    compatible_brands: qt  
    creation_time   : 2020-01-02T03:04:05.000000Z
    com.apple.quicktime.location.ISO6709: +00.0000+000.0000+000.000/
    com.apple.quicktime.make: Apple
    com.apple.quicktime.model: iPhone
  Duration: 00:00:15.68, start: 0.000000, bitrate: 10302 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 10058 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Metadata:
        creation_time   : 2020-01-02T03:04:05.000000Z
        handler_name    : Core Media Video
        vendor_id       : [0][0][0][0]
        encoder         : HEVC
      Side data:
        DOVI configuration record: version: 1.0, profile: 8, level: 4, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 4
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 190 kb/s (default)
      Metadata:
        creation_time   : 2020-01-02T03:04:05.000000Z
        handler_name    : Core Media Audio
  Stream #0:2[0x3](und): Data: none (mebx / 0x7862656D), 34 kb/s (default)
      Metadata:
        handler_name    : Core Media Metadata
At least one output file must be specified
`

test('describeContainer reads streams, side data and metadata keys (not values)', () => {
  const d = describeContainer(IPHONE)
  assert.equal(d.demuxer, 'mov,mp4,m4a,3gp,3g2,mj2')
  assert.equal(d.majorBrand, 'qt')
  assert.deepEqual(d.globalMetadataKeys, ['major_brand', 'minor_version', 'compatible_brands', 'creation_time', 'com.apple.quicktime.location.ISO6709', 'com.apple.quicktime.make', 'com.apple.quicktime.model'])
  assert.deepEqual(d.streams.map((s) => [s.index, s.kind, s.codec, s.dolbyVision]), [[0, 'video', 'hevc', true], [1, 'audio', 'aac', false], [2, 'data', 'mebx', false]])
  assert.deepEqual(d.streams[0].details, ['yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)', '1920x1080'])
  assert.deepEqual(d.streams[1].details, ['44100 Hz', 'stereo', 'fltp'])
  assert.deepEqual(d.streams[0].sideData.length, 2)
  assert.deepEqual(d.streams[0].metadataKeys, ['creation_time', 'handler_name', 'vendor_id', 'encoder'])
  assert.ok(!JSON.stringify(d).includes('+00.0000'), 'no metadata values are kept')
  assert.throws(() => describeContainer('Error opening input file'), VideoStripError)
})

test('planStrip keeps video and audio, and writes MP4 to keep Dolby Vision', () => {
  const plan = planStrip(describeContainer(IPHONE))
  assert.equal(plan.muxer, 'mp4')
  assert.deepEqual(plan.kept.map((s) => s.index), [0, 1])
  assert.ok(plan.removed.some((r) => r.includes('com.apple.quicktime.location.ISO6709')))
  assert.ok(plan.removed.includes('data stream 2 (mebx)'))
  assert.deepEqual(plan.notes, ['written as MP4 instead of QuickTime to keep the Dolby Vision configuration'])
  assert.deepEqual(stripArgs(plan, 'in.mov', '/tmp/out.mp4'), [
    '-hide_banner', '-nostdin', '-y', '-i', 'in.mov', '-map', '0:0', '-map', '0:1', '-c', 'copy',
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-strict', 'unofficial', '-f', 'mp4', '/tmp/out.mp4',
  ])
})

function stream(kind: 'video' | 'audio' | 'data' | 'subtitle', codec: string, extra: Partial<ContainerDescription['streams'][number]> = {}) {
  return {index: 0, kind, codec, attachedPicture: false, dolbyVision: false, metadataKeys: [], details: [], sideData: [], ...extra}
}

function container(demuxer: string, brand: string | undefined, streams: ReturnType<typeof stream>[]): ContainerDescription {
  return {demuxer, majorBrand: brand, globalMetadataKeys: [], chapters: 0, streams: streams.map((s, index) => ({...s, index}))}
}

test('planStrip picks the container', () => {
  const mov = 'mov,mp4,m4a,3gp,3g2,mj2'
  assert.equal(planStrip(container(mov, 'qt', [stream('video', 'h264'), stream('audio', 'pcm_s16le')])).muxer, 'mov')
  assert.equal(planStrip(container(mov, 'mp42', [stream('video', 'vp9'), stream('audio', 'aac')])).muxer, 'mp4')
  const pcmDv = planStrip(container(mov, 'qt', [stream('video', 'hevc', {dolbyVision: true}), stream('audio', 'pcm_s16le')]))
  assert.equal(pcmDv.muxer, 'mov')
  assert.match(pcmDv.notes[0], /could not be kept/)
  assert.equal(planStrip(container('matroska,webm', undefined, [stream('video', 'vp9'), stream('audio', 'opus')])).muxer, 'webm')
  assert.equal(planStrip(container('matroska,webm', undefined, [stream('video', 'h264'), stream('audio', 'aac')])).muxer, 'matroska')
  const avi = planStrip(container('avi', undefined, [stream('video', 'mpeg4')]))
  assert.equal(avi.muxer, 'matroska')
  assert.match(avi.notes[0], /written as Matroska/)
  const cover = planStrip(container(mov, 'M4A', [stream('video', 'mjpeg', {attachedPicture: true}), stream('video', 'h264')]))
  assert.deepEqual(cover.kept.map((s) => s.codec), ['h264'])
  assert.throws(() => planStrip(container(mov, 'M4A', [stream('audio', 'aac')])), /no video stream/)
})

test('majorBrand reads ftyp', () => {
  assert.equal(majorBrand(Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20])), 'qt')
  assert.equal(majorBrand(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), undefined)
})

test('checkStrippedDescription finds metadata left, other streams and lost side data', () => {
  const plan = planStrip(describeContainer(IPHONE))
  const good = describeContainer(`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'out.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomdby1iso2mp41
  Duration: 00:00:15.68, start: 0.000000, bitrate: 10258 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 10058 kb/s, 29.97 fps, 29.97 tbr, 19200 tbn (default)
      Metadata:
        handler_name    : VideoHandler
        vendor_id       : [0][0][0][0]
      Side data:
        DOVI configuration record: version: 1.0, profile: 8, level: 4, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 4
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 190 kb/s (default)
      Metadata:
        handler_name    : SoundHandler
        vendor_id       : [0][0][0][0]
`)
  assert.deepEqual(checkStrippedDescription(plan, good), [])
  const bad = structuredClone(good)
  bad.globalMetadataKeys.push('location')
  bad.streams[0].sideData = bad.streams[0].sideData.filter((d) => !d.startsWith('displaymatrix'))
  bad.streams[1].details = ['48000 Hz', 'stereo', 'fltp']
  assert.deepEqual(checkStrippedDescription(plan, bad), [
    'stream 0 lost side data: displaymatrix: rotation of -90.00 degrees',
    'stream 1 changed from "44100 Hz, stereo, fltp" to "48000 Hz, stereo, fltp"',
    'file metadata left: location',
  ])
})

const HEADER = `#format: frame checksums
#version: 2
#hash: MD5
#tb 0: 1/600
#media_type 0: video
#codec_id 0: h264
#tb 1: 1/44100
#media_type 1: audio
#codec_id 1: pcm_s16le
`

function frames(video: string[], audio: string[]): string {
  return HEADER + [...video.map((l) => `0, ${l}`), ...audio.map((l) => `1, ${l}`)].join('\n') + '\n'
}

const HASHES = ['a'.repeat(64), 'b'.repeat(64)]

test('comparePackets accepts identical packets, PCM cut differently, and moved repeated time stamps', () => {
  const input = parseFrameMd5(frames(['-20, 0, 20, 100, aa', '0, 40, 20, 90, bb', '0, 20, 20, 80, cc', '40, 60, 20, 70, dd'], ['0, 0, 1024, 2048, e1', '1024, 1024, 1024, 2048, e2']))
  // Packet 2 has the same decode time as packet 1 in the input; the muxer moved it by 1 tick of a
  // finer time base. PCM came out as one packet.
  const output = parseFrameMd5(
    frames(['-20, 0, 20, 100, aa', '0, 40, 20, 90, bb', '1, 21, 20, 80, cc', '40, 60, 20, 70, dd'], ['0, 0, 2048, 4096, ff']),
  )
  const {problems, timing} = comparePackets(input, output, HASHES, HASHES)
  assert.deepEqual(problems, [])
  assert.equal(timing.adjustedPackets, 1)
  assert.ok(Math.abs(timing.maxAdjustmentSeconds - 1 / 600) < 1e-9)
})

test('comparePackets rejects changed payloads, moved increasing time stamps and other hashes', () => {
  const input = parseFrameMd5(frames(['0, 0, 20, 100, aa', '20, 20, 20, 90, bb'], ['0, 0, 1024, 2048, e1']))
  const changed = parseFrameMd5(frames(['0, 0, 20, 100, aa', '20, 20, 20, 91, bx'], ['0, 0, 1024, 2048, e1']))
  assert.deepEqual(comparePackets(input, changed, HASHES, HASHES).problems, ['stream 0 (h264): packet 1 differs'])
  const moved = parseFrameMd5(frames(['0, 0, 20, 100, aa', '21, 21, 20, 90, bb'], ['0, 0, 1024, 2048, e1']))
  assert.match(comparePackets(input, moved, HASHES, HASHES).problems[0], /packet 1 moved by 1.667 ms/)
  assert.deepEqual(comparePackets(input, input, HASHES, ['c'.repeat(64), HASHES[1]]).problems, ['stream 0 (h264): sha256 of the stream differs'])
  const shorterAudio = parseFrameMd5(frames(['0, 0, 20, 100, aa', '20, 20, 20, 90, bb'], ['0, 0, 1000, 2000, e1']))
  assert.deepEqual(comparePackets(input, shorterAudio, HASHES, HASHES).problems, [
    'stream 1 (pcm_s16le): 2048 bytes became 2000',
    'stream 1 (pcm_s16le): the duration changed',
  ])
})

test('comparePackets allows only the last packet a different duration', () => {
  const input = parseFrameMd5(frames(['0, 0, 20, 100, aa', '20, 20, 20, 90, bb'], []))
  const last = parseFrameMd5(frames(['0, 0, 20, 100, aa', '20, 20, 21, 90, bb'], []))
  const result = comparePackets(input, last, HASHES, HASHES)
  assert.deepEqual(result.problems, [])
  assert.equal(result.timing.lastDurationChanges, 1)
  const first = parseFrameMd5(frames(['0, 0, 21, 100, aa', '20, 20, 20, 90, bb'], []))
  assert.match(comparePackets(input, first, HASHES, HASHES).problems[0], /packet 0 duration changed/)
})

test('parseFrameMd5 reads lines with side data; parseStreamHash reads sha256 lines', () => {
  const parsed = parseFrameMd5(`${HEADER}1,      -2031,      -2031,     1024,        6, cbdc7e26b5b510ac44abfeb0db3f2189, S=1,       10, 20427fd3274ad3676ba943dd82d6eda0\n`)
  assert.equal(parsed.streams[1][0].md5, 'cbdc7e26b5b510ac44abfeb0db3f2189')
  assert.deepEqual(parseStreamHash(`0,v,SHA256=${'a'.repeat(64)}\n1,a,SHA256=${'b'.repeat(64)}\n`), HASHES)
})
