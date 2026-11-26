/**
 * Runs the real ffmpeg and ffprobe (`npm run test:ffmpeg`): converts synthetic clips with the
 * contract settings and checks that verifyMp4 accepts the results and rejects files that break
 * the contract. Fails, rather than skips, when ffmpeg is missing.
 */
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import {convertToMp4, probe, runCommand, summarizeInput, verifyMp4, type InputSummary} from '../src/video/ffmpeg'

const dir = mkdtempSync(path.join(tmpdir(), 'ffmpeg-integration-'))
after(() => rmSync(dir, {recursive: true, force: true}))

async function ffmpeg(...args: string[]): Promise<void> {
  const result = await runCommand('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args])
  assert.equal(result.code, 0, result.stderr)
}

async function input(file: string): Promise<InputSummary> {
  return summarizeInput(await probe(file), file)
}

describe('convert and verify with ffmpeg', () => {
  const rotated = path.join(dir, 'rotated.mov')
  const silent = path.join(dir, 'silent.mp4')

  before(async () => {
    // A phone-like clip: 1280x720 shown rotated by 90 degrees, mono audio, a GPS location tag.
    const base = path.join(dir, 'base.mp4')
    await ffmpeg(
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1',
      '-metadata', 'location=+40.0000-074.0000/', base,
    )
    await ffmpeg('-display_rotation', '90', '-i', base, '-c', 'copy', rotated)
    // Odd-sized, no audio.
    await ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=25:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent)
  })

  it('converts a rotated clip with audio to an upright H.264 High MP4 that passes every check', async () => {
    const source = await input(rotated)
    assert.deepEqual(source.video.displayed, {width: 720, height: 1280})
    const output = path.join(dir, 'rotated-out.mp4')
    await convertToMp4({input: rotated, output, preset: 'superfast', hasAudio: true})
    const result = await verifyMp4(output, source)
    assert.deepEqual(result.problems, [])
    assert.equal(result.output?.width, 720)
    assert.equal(result.output?.height, 1280)
    assert.equal(result.output?.audioChannels, 2)
    assert.equal(result.output?.boxes.indexOf('moov')! < result.output?.boxes.indexOf('mdat')!, true)
  })

  it('converts a clip without audio to an MP4 without an audio track, rounding to even dimensions', async () => {
    const source = await input(silent)
    const output = path.join(dir, 'silent-out.mp4')
    await convertToMp4({input: silent, output, preset: 'superfast', hasAudio: false})
    const result = await verifyMp4(output, source)
    assert.deepEqual(result.problems, [])
    assert.equal(`${result.output?.width}x${result.output?.height}`, '640x360')
    assert.equal(result.output?.audioCodec, null)
  })

  it('rejects an MP4 with moov after mdat, the wrong size, copied metadata and audio the input lacks', async () => {
    const source = await input(silent)
    const bad = path.join(dir, 'bad.mp4')
    await ffmpeg(
      '-i', silent, '-f', 'lavfi', '-i', 'sine=duration=1',
      '-map', '0:v', '-map', '1:a', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=320:180', '-c:a', 'aac',
      '-metadata', 'comment=copied', bad,
    )
    const result = await verifyMp4(bad, source)
    assert.equal(result.ok, false)
    const text = result.problems.map((p) => `${p.check}: ${p.message}`).join('\n')
    assert.match(text, /moov must come before mdat/)
    assert.match(text, /320x180, expected 640x360/)
    assert.match(text, /metadata copied from the input: comment/)
    assert.match(text, /1 audio streams, expected 0/)
  })

  it('rejects a file whose duration differs from the input by more than 0.1 s', async () => {
    const source = await input(silent)
    const short = path.join(dir, 'short.mp4')
    await ffmpeg('-i', silent, '-t', '0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=640:360', '-movflags', '+faststart', short)
    const result = await verifyMp4(short, source)
    assert.deepEqual([...new Set(result.problems.map((p) => p.check))].sort(), ['fileDuration', 'videoDuration'])
    assert.match(result.problems.map((p) => p.message).join('\n'), /lasts 0\.8/)
  })
})
