/**
 * The MP4 checks: SPS and AAC config parsing from known byte sequences, and verifyConvertedMp4
 * on summaries. test/convert.integration.ts runs inspectMp4 on real ffmpeg output.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {durationTolerance, parseAvcC, parseEsds, verifyConvertedMp4, type Mp4Summary} from '../mp4'

/** x264 High@4.0 1920x1080 SPS (with an emulation prevention byte), as in an avcC box. */
const HIGH_SPS = [
  0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03,
  0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c, 0x60, 0xc6, 0x58,
]
const avcC = (sps: number[]) =>
  Buffer.from([
    0x01,
    sps[1],
    sps[2],
    sps[3],
    0xff,
    0xe1,
    0x00,
    sps.length,
    ...sps,
    0x01,
    0x00,
    0x04,
    0x68,
    0xeb,
    0xe3,
    0xcb,
  ])

/** esds payload (after version and flags) of ffmpeg's AAC LC stereo 44.1 kHz. */
const AAC_LC_STEREO = Buffer.from([
  0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00,
  0x00, 0x01, 0xf4, 0x00, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02,
])

describe('parsers', () => {
  it('parseAvcC reads High profile, 4:2:0, 8 bit', () => {
    assert.deepEqual(parseAvcC(avcC(HIGH_SPS)), {
      profileIdc: 100,
      chromaFormatIdc: 1,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
    })
  })

  it('parseAvcC reads Main profile without chroma fields as 4:2:0 8 bit', () => {
    const main = [0x67, 0x4d, 0x40, 0x1f, 0xe8, 0x80, 0x28, 0x02, 0xdd, 0x80]
    assert.equal(parseAvcC(avcC(main)).profileIdc, 77)
  })

  it('parseAvcC reads a 10-bit High 4:2:2 SPS', () => {
    // profile 122, sps_id 0 ('1'), chroma_format_idc 2 ('011'), luma +2 ('011'), chroma +2 ('011').
    // Bits: 1 011 011 011 + padding -> 1011 0110 1100 0000
    const hi422 = [0x67, 0x7a, 0x00, 0x28, 0xb6, 0xc0]
    assert.deepEqual(parseAvcC(avcC(hi422)), {
      profileIdc: 122,
      chromaFormatIdc: 2,
      bitDepthLuma: 10,
      bitDepthChroma: 10,
    })
  })

  it('parseEsds reads AAC LC stereo', () => {
    assert.deepEqual(parseEsds(AAC_LC_STEREO), {
      objectTypeIndication: 0x40,
      audioObjectType: 2,
      channelConfiguration: 2,
    })
  })

  it('rejects truncated data', () => {
    assert.throws(() => parseAvcC(Buffer.from([0x01, 0x64])))
    assert.throws(() => parseEsds(Buffer.from([0x04, 0x01, 0x00])))
  })
})

function goodSummary(overrides: Partial<Mp4Summary> = {}): Mp4Summary {
  return {
    fileSize: 1000,
    topLevel: [
      {type: 'ftyp', offset: 0, size: 32},
      {type: 'moov', offset: 32, size: 500},
      {type: 'free', offset: 532, size: 8},
      {type: 'mdat', offset: 540, size: 460},
    ],
    faststart: true,
    durationSeconds: 19.82,
    tracks: [
      {
        handler: 'vide',
        sampleEntry: 'avc1',
        sampleCount: 594,
        identityMatrix: true,
        width: 1440,
        height: 1920,
        avc: {profileIdc: 100, chromaFormatIdc: 1, bitDepthLuma: 8, bitDepthChroma: 8},
      },
      {
        handler: 'soun',
        sampleEntry: 'mp4a',
        sampleCount: 855,
        identityMatrix: true,
        channelCount: 2,
        aac: {objectTypeIndication: 0x40, audioObjectType: 2, channelConfiguration: 2},
      },
    ],
    ...overrides,
  }
}

const expected = {width: 1440, height: 1920, hasAudio: true, inputDurationSeconds: 19.82}

describe('verifyConvertedMp4', () => {
  it('accepts a correct file', () => {
    assert.deepEqual(verifyConvertedMp4(goodSummary(), expected), [])
  })

  it('reports every broken promise', () => {
    const bad = goodSummary({
      topLevel: [
        {type: 'ftyp', offset: 0, size: 32},
        {type: 'mdat', offset: 32, size: 460},
        {type: 'moov', offset: 492, size: 508},
      ],
      faststart: false,
      durationSeconds: 12,
      tracks: [
        {
          handler: 'vide',
          sampleEntry: 'hvc1',
          sampleCount: 0,
          identityMatrix: false,
          width: 1441,
          height: 1922,
          avc: {profileIdc: 66, chromaFormatIdc: 2, bitDepthLuma: 10, bitDepthChroma: 10},
        },
        {
          handler: 'soun',
          sampleEntry: 'mp4a',
          sampleCount: 1,
          identityMatrix: true,
          channelCount: 1,
          aac: {objectTypeIndication: 0x40, audioObjectType: 5, channelConfiguration: 1},
        },
        {handler: 'meta', sampleEntry: 'mebx', sampleCount: 1, identityMatrix: true},
      ],
    })
    const problems = verifyConvertedMp4(bad, expected)
    for (const pattern of [
      /moov is not before mdat/,
      /unexpected tracks: meta/,
      /not avc1/,
      /profile_idc 66/,
      /chroma_format_idc 2/,
      /bit depth 10\/10/,
      /frame size 1441x1922, expected 1440x1920/,
      /odd frame size/,
      /longest side 1922/,
      /rotation/,
      /no frames/,
      /AAC object type 5/,
      /channel configuration 1/,
      /channel count 1/,
      /duration 12.00 s, input 19.82 s/,
    ]) {
      assert.ok(
        problems.some((p) => pattern.test(p)),
        `${pattern} in ${JSON.stringify(problems)}`,
      )
    }
  })

  it('requires no audio track when the input has none, and one when it has', () => {
    assert.match(
      verifyConvertedMp4(goodSummary(), {...expected, hasAudio: false}).join(),
      /1 audio tracks, but the input has no audio/,
    )
    const silent = goodSummary({tracks: goodSummary().tracks.slice(0, 1)})
    assert.match(verifyConvertedMp4(silent, expected).join(), /0 audio tracks instead of 1/)
    assert.deepEqual(verifyConvertedMp4(silent, {...expected, hasAudio: false}), [])
  })

  it('skips the duration comparison only when the input reported none', () => {
    assert.deepEqual(
      verifyConvertedMp4(goodSummary({durationSeconds: 5}), {
        ...expected,
        inputDurationSeconds: null,
      }),
      [],
    )
    assert.match(
      verifyConvertedMp4(goodSummary({durationSeconds: null}), expected).join(),
      /no movie duration/,
    )
  })

  it('tolerates half a second or 1 % of the duration', () => {
    assert.equal(durationTolerance(10), 0.5)
    assert.ok(Math.abs(durationTolerance(164.4) - 1.644) < 1e-9)
    assert.deepEqual(verifyConvertedMp4(goodSummary({durationSeconds: 20.3}), expected), [])
  })
})
