/**
 * The showinfo parser and the frame-time comparison, with log lines as ffmpeg 7.0.2 (the
 * Function's binary, linux/arm64) and 9.0.1 (Homebrew) print them with `-loglevel level+info`
 * for media/step_count.mp4.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {chooseInputMode, DOWNLOAD_LIMIT_BYTES} from '../convert'
import {
  compareFrameTimes,
  FRAME_TIME_TOLERANCE_SECONDS,
  FrameTimesCollector,
  frameTimeProblems,
} from '../frames'
import {ffmpegErrorLines, ffmpegLogLevel, isInformationalLogLine} from '../media-info'

const FFMPEG_7_0_2 = [
  "[info] Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/w/in/step_count.mp4':",
  '[info] Stream mapping:',
  '[Parsed_showinfo_0 @ 0xffff8c001710] [info] config in time_base: 1/90000, frame_rate: 279000/31723',
  '[Parsed_showinfo_0 @ 0xffff8c001710] [info] config out time_base: 0/0, frame_rate: 0/0',
  '[Parsed_showinfo_0 @ 0xffff8c001710] [info] n:   0 pts:      0 pts_time:0       duration:   6834 duration_time:0.0759333 fmt:yuv420p cl:left sar:0/1 s:1004x2176 i:P iskey:1 type:I ',
  '[Parsed_showinfo_0 @ 0xffff8c001710] [info] color_range:tv color_space:bt709 color_primaries:bt709 color_trc:bt709',
  "[info] Output #0, null, to 'pipe:':",
  '[Parsed_showinfo_0 @ 0xffff8c001710] [info] n:   1 pts:   6834 pts_time:0.0759333 duration:   1844 duration_time:0.0204889 fmt:yuv420p cl:left sar:0/1 s:1004x2176 i:P iskey:0 type:P ',
  '[Parsed_showinfo_0 @ 0xffff8c001710] [info] n:   2 pts:   8678 pts_time:0.0964222 duration:   1496 duration_time:0.0166222 fmt:yuv420p cl:left sar:0/1 s:1004x2176 i:P iskey:0 type:P ',
]

const FFMPEG_9_0_1 = [
  '[Parsed_showinfo_0 @ 0x9fac05b00] [info] config in time_base: 1/90000, frame_rate: 279000/31723',
  '[Parsed_showinfo_0 @ 0x9fac05b00] [info] n:   0 pts:      0 pts_time:0       duration:   6834 duration_time:0.0759333 fmt:yuv420p cl:left sar:0/1 s:1004x2176 i:P iskey:1 type:I ',
  '[Parsed_showinfo_0 @ 0x9fac05b00] [info] n:   1 pts:   6834 pts_time:0.0759333 duration:   1844 duration_time:0.0204889 fmt:yuv420p cl:left sar:0/1 s:1004x2176 i:P iskey:0 type:P ',
  '[Parsed_showinfo_0 @ 0x9fac05b00] [info] n:   2 pts:   8678 pts_time:0.0964222 duration:   1496 duration_time:0.0166222 fmt:yuv420p cl:left sar:0/1 s:1004x2176 i:P iskey:0 type:P ',
]

function collect(lines: string[]): {times: number[]; consumed: number} {
  const collector = new FrameTimesCollector()
  let consumed = 0
  for (const line of lines) if (collector.push(line)) consumed += 1
  return {times: collector.result().seconds, consumed}
}

describe('FrameTimesCollector', () => {
  it('reads the frame times of ffmpeg 7.0.2 and 9.0.1 in the time base showinfo reports', () => {
    for (const lines of [FFMPEG_7_0_2, FFMPEG_9_0_1]) {
      const {times} = collect(lines)
      assert.deepEqual(times, [0, 6834 / 90000, 8678 / 90000])
    }
  })

  it('consumes only the showinfo lines', () => {
    const {consumed} = collect(FFMPEG_7_0_2)
    assert.equal(consumed, FFMPEG_7_0_2.filter((l) => l.startsWith('[Parsed_showinfo_')).length)
  })

  it('follows a change of time base and counts frames without a timestamp', () => {
    const collector = new FrameTimesCollector()
    collector.push('[Parsed_showinfo_0 @ 0x1] [info] config in time_base: 1/600, frame_rate: 30/1')
    collector.push('[Parsed_showinfo_0 @ 0x1] [info] n:   0 pts:    600 pts_time:1 duration: 20')
    collector.push('[Parsed_showinfo_0 @ 0x1] [info] config in time_base: 1/1000, frame_rate: 30/1')
    collector.push('[Parsed_showinfo_0 @ 0x1] [info] n:   1 pts:   1500 pts_time:1.5 duration: 33')
    collector.push('[Parsed_showinfo_0 @ 0x1] [info] n:   2 pts:NOPTS pts_time:NOPTS duration: 33')
    assert.deepEqual(collector.result(), {seconds: [1, 1.5], withoutTimestamp: 1})
  })

  it('fails on a frame logged before its time base', () => {
    const collector = new FrameTimesCollector()
    assert.throws(
      () =>
        collector.push(
          '[Parsed_showinfo_0 @ 0x1] [info] n:   0 pts:      0 pts_time:0 duration: 1',
        ),
      /before its time base/,
    )
  })
})

describe('compareFrameTimes', () => {
  // media/step_count.mp4: 25 frames in the first 0.53 s, then about 2 per second.
  const input = [0, 0.0759, 0.0964, 0.113, 0.1338, 0.5155, 0.5335, 0.9402, 1.4583, 1.9086, 3.4463]

  it('accepts the same times, also with a start offset', () => {
    const shifted = input.map((t) => t + 0.0964)
    assert.deepEqual(compareFrameTimes(input, shifted), {
      inputFrames: input.length,
      outputFrames: input.length,
      missing: 0,
      added: 0,
      maxShiftSeconds: compareFrameTimes(input, shifted).maxShiftSeconds,
    })
    assert.ok(compareFrameTimes(input, shifted).maxShiftSeconds < 1e-9)
  })

  it('counts dropped frames (v1 with ffmpeg 9.0.1 kept 13 of 31)', () => {
    const dropped = input.filter((_, i) => i % 2 === 0)
    const result = compareFrameTimes(input, dropped)
    assert.equal(result.missing, input.length - dropped.length)
    assert.equal(result.added, 0)
  })

  it('counts resampled frames (v1 with ffmpeg 7.0.2: evenly spaced, same count)', () => {
    const step = input.at(-1)! / (input.length - 1)
    const even = input.map((_, i) => i * step)
    const result = compareFrameTimes(input, even)
    assert.equal(result.outputFrames, result.inputFrames)
    assert.ok(result.missing > 0 && result.added > 0)
    assert.deepEqual(
      frameTimeProblems({seconds: input, withoutTimestamp: 0}, {seconds: even, withoutTimestamp: 0})
        .length,
      1,
    )
  })

  it('counts duplicated frames (v1 with ffmpeg 7.0.2 filled a pause at a constant rate)', () => {
    const withDuplicates = [...input, 2.4, 2.9].sort((a, b) => a - b)
    const result = compareFrameTimes(input, withDuplicates)
    assert.equal(result.missing, 0)
    assert.equal(result.added, 2)
  })

  it(`allows ${FRAME_TIME_TOLERANCE_SECONDS * 1000} ms, not more`, () => {
    assert.equal(compareFrameTimes([0, 1], [0, 1 + FRAME_TIME_TOLERANCE_SECONDS * 0.9]).missing, 0)
    assert.equal(compareFrameTimes([0, 1], [0, 1 + FRAME_TIME_TOLERANCE_SECONDS * 1.5]).missing, 1)
  })
})

describe('frameTimeProblems', () => {
  it('is empty when every frame is kept', () => {
    assert.deepEqual(
      frameTimeProblems(
        {seconds: [0, 0.5], withoutTimestamp: 0},
        {seconds: [0, 0.5], withoutTimestamp: 0},
      ),
      [],
    )
  })

  it('reports missing logs and frames without timestamps', () => {
    assert.match(
      frameTimeProblems({seconds: [], withoutTimestamp: 0}, {seconds: [0], withoutTimestamp: 0})[0],
      /no input frame times/,
    )
    assert.match(
      frameTimeProblems(
        {seconds: [0], withoutTimestamp: 0},
        {seconds: [0], withoutTimestamp: 2},
      )[0],
      /2 MP4 frames have no timestamp/,
    )
  })
})

describe('level-tagged ffmpeg log lines', () => {
  it('reads the level and keeps only warnings and errors', () => {
    assert.equal(ffmpegLogLevel('[info] Stream mapping:'), 'info')
    assert.equal(
      ffmpegLogLevel('[in#0 @ 0x33068760] [error] Error opening input: No such file'),
      'error',
    )
    assert.equal(ffmpegLogLevel('no tag here'), null)
    assert.equal(isInformationalLogLine('[info] Output #0, null'), true)
    assert.equal(isInformationalLogLine('[libx264 @ 0x1] [warning] something'), false)
  })

  it('strips context prefixes and level tags from error messages', () => {
    const lines = [
      '[in#0 @ 0x33068760] [error] Error opening input: No such file or directory',
      '[error] Error opening input file /nonexistent.mov.',
      '[fatal] Error opening input files: No such file or directory',
    ].join('\n')
    assert.deepEqual(ffmpegErrorLines(lines), [
      'Error opening input: No such file or directory',
      'Error opening input files: No such file or directory',
    ])
  })
})

describe('chooseInputMode', () => {
  const MB = 1000 * 1000

  it('downloads when the upload and an MP4 one and a half times its size fit in /tmp', () => {
    assert.equal(chooseInputMode(100 * MB, 512 * MB), 'download')
    assert.equal(chooseInputMode(200 * MB, 500 * MB), 'download')
    // Small files still keep at least 64 MB for the MP4.
    assert.equal(chooseInputMode(1 * MB, 64 * MB), 'proxy')
    assert.equal(chooseInputMode(1 * MB, 65 * MB), 'download')
  })

  it('reads through the range proxy when the MP4 might not fit next to the download', () => {
    // The review's case: a 300 MB low-bitrate upload with 512 MB free.
    assert.equal(chooseInputMode(300 * MB, 512 * MB), 'proxy')
    assert.equal(chooseInputMode(205 * MB, 512 * MB), 'proxy')
  })

  it('reads through the range proxy above the download limit or without a known size', () => {
    assert.equal(chooseInputMode(DOWNLOAD_LIMIT_BYTES + 1, 10_000 * MB), 'proxy')
    assert.equal(chooseInputMode(undefined, 10_000 * MB), 'proxy')
    assert.equal(chooseInputMode(10 * MB, 10_000 * MB, 5 * MB), 'proxy')
  })
})
