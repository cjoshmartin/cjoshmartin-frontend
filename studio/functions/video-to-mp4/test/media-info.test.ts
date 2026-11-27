/**
 * parseFfmpegInputDescription on real `ffmpeg -hide_banner -i` output (metadata lines trimmed):
 * ffmpeg 6.0 (ffmpeg-static on macOS, side data spelled `displaymatrix`, as in the 7.0.2 Lambda
 * build) and ffmpeg 9.0.1 (`Display Matrix`), from the site's original videos.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  ffmpegErrorLines,
  parseFfmpegInputDescription,
  rotationSwapsSides,
  UnreadableInputError,
} from '../media-info'

const IMG_0169_FFMPEG6 = `Guessed Channel Layout for Input Stream #0.1 : mono
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0169.MOV':
  Metadata:
    major_brand     : qt
  Duration: 00:00:19.82, start: 0.000000, bitrate: 10675 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuvj420p(pc, smpte170m/smpte432/bt709), 1920x1440, 9921 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
    Metadata:
      handler_name    : Core Media Video
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: pcm_s16le (lpcm / 0x6D63706C), 44100 Hz, 1 channels, s16, 705 kb/s (default)
    Metadata:
      handler_name    : Core Media Audio
  Stream #0:2[0x3](und): Data: none (mebx / 0x7862656D), 0 kb/s (default)
  Stream #0:3[0x4](und): Data: none (mebx / 0x7862656D), 34 kb/s (default)
At least one output file must be specified
`

const IMG_3151_FFMPEG9 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_3151.MOV':
  Duration: 00:00:15.68, start: 0.000000, bitrate: 10302 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 10058 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
    Side data:
      DOVI configuration record: version: 1.0, profile: 8, level: 4, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 4
      Display Matrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 190 kb/s (default)
  Stream #0:2[0x3](und): Data: none (mebx / 0x7862656D), 0 kb/s (default)
At least one output file must be specified
`

const IMG_3239_AUDIO_FIRST = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_3239.MOV':
  Duration: 00:00:15.88, start: 0.000000, bitrate: 19987 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 225 kb/s (default)
  Stream #0:1[0x2](und): Video: h264 (High) (avc1 / 0x31637661), yuvj420p(pc, bt709, progressive), 1920x1440, 19722 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
At least one output file must be specified
`

const SCREEN_RECORDING_NO_AUDIO = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'Screen_Recording_2025-05-05_at_2.55.11PM.mov':
  Duration: 00:00:30.80, start: 0.000000, bitrate: 3146 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 3420x2080 [SAR 1:1 DAR 171:104], 3143 kb/s, 60 fps, 60 tbr, 6k tbn (default)
At least one output file must be specified
`

const COVER_ART = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'cover.mp4':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 69 kb/s (default)
  Stream #0:1[0x0]: Video: png, rgb24(pc, gbr/unknown/unknown), 64x64, 90k tbr, 90k tbn (attached pic)
  Stream #0:2[0x2](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240, 25 fps, 25 tbr, 12800 tbn
At least one output file must be specified
`

const NOT_A_VIDEO_FFMPEG9 = `[in#0 @ 0x8b9024000] Format mov,mp4,m4a,3gp,3g2,mj2 detected only with low score of 1, misdetection possible!
[in#0 @ 0x8b9024000] moov atom not found
[in#0 @ 0x8b9020000] Error opening input: Invalid data found when processing input
Error opening input file /tmp/a2-notvideo.mov.
Error opening input files: Invalid data found when processing input
`

describe('parseFfmpegInputDescription', () => {
  it('reads a rotated iPhone HEVC clip with mono PCM audio and data tracks (ffmpeg 6)', () => {
    const info = parseFfmpegInputDescription(IMG_0169_FFMPEG6)
    assert.equal(info.format, 'mov,mp4,m4a,3gp,3g2,mj2')
    assert.equal(info.durationSeconds, 19.82)
    assert.deepEqual(info.video, {
      index: '0:0',
      codec: 'hevc',
      width: 1920,
      height: 1440,
      rotation: -90,
      displayWidth: 1440,
      displayHeight: 1920,
    })
    assert.equal(info.hasAudio, true)
    assert.equal(info.audioStreams, 1)
    assert.equal(info.firstAudioCodec, 'pcm_s16le')
  })

  it('reads the ffmpeg 9 "Display Matrix" spelling and ignores Dolby Vision side data', () => {
    const info = parseFfmpegInputDescription(IMG_3151_FFMPEG9)
    assert.equal(info.video?.rotation, -90)
    assert.equal(info.video?.displayWidth, 1080)
    assert.equal(info.video?.displayHeight, 1920)
    assert.equal(info.firstAudioCodec, 'aac')
  })

  it('finds the video stream when audio comes first', () => {
    const info = parseFfmpegInputDescription(IMG_3239_AUDIO_FIRST)
    assert.equal(info.video?.index, '0:1')
    assert.equal(info.video?.codec, 'h264')
    assert.equal(info.video?.displayWidth, 1440)
    assert.equal(info.hasAudio, true)
  })

  it('reads a screen recording without audio, with a SAR/DAR suffix', () => {
    const info = parseFfmpegInputDescription(SCREEN_RECORDING_NO_AUDIO)
    assert.equal(info.video?.width, 3420)
    assert.equal(info.video?.height, 2080)
    assert.equal(info.video?.rotation, 0)
    assert.equal(info.hasAudio, false)
    assert.equal(info.firstAudioCodec, null)
    assert.equal(info.durationSeconds, 30.8)
  })

  it('skips attached cover art like -map 0:V:0 and reads N/A durations as null', () => {
    const info = parseFfmpegInputDescription(COVER_ART)
    assert.equal(info.video?.index, '0:2')
    assert.equal(info.video?.width, 320)
    assert.equal(info.attachedPictures, 1)
    assert.equal(info.durationSeconds, null)
  })

  it("throws UnreadableInputError with ffmpeg's reason for a file that is not media", () => {
    assert.throws(
      () => parseFfmpegInputDescription(NOT_A_VIDEO_FFMPEG9),
      (error: unknown) =>
        error instanceof UnreadableInputError &&
        /moov atom not found/.test(error.message) &&
        /Invalid data found when processing input/.test(error.message),
    )
  })

  it('reports no video for an audio-only file', () => {
    const info = parseFfmpegInputDescription(`Input #0, mp3, from 'a.mp3':
  Duration: 00:00:03.00, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified`)
    assert.equal(info.video, null)
    assert.equal(info.hasAudio, true)
  })
})

describe('helpers', () => {
  it('rotationSwapsSides', () => {
    for (const r of [90, -90, 270, -270, 90.0001])
      assert.equal(rotationSwapsSides(r), true, String(r))
    for (const r of [0, 180, -180, 360, 45]) assert.equal(rotationSwapsSides(r), false, String(r))
  })

  it('ffmpegErrorLines keeps the reasons, without prefixes, file paths or repeats', () => {
    assert.deepEqual(ffmpegErrorLines(NOT_A_VIDEO_FFMPEG9), [
      'moov atom not found',
      'Error opening input: Invalid data found when processing input',
      'Error opening input files: Invalid data found when processing input',
    ])
    assert.deepEqual(ffmpegErrorLines(NOT_A_VIDEO_FFMPEG9, 1), [
      'Error opening input files: Invalid data found when processing input',
    ])
    assert.deepEqual(ffmpegErrorLines('At least one output file must be specified'), [])
  })
})
