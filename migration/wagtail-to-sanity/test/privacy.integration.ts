/**
 * Runs the real exiftool, ffmpeg, ffprobe and ImageMagick (`npm run test:ffmpeg`): makes a photo, a
 * screenshot and a phone-like video with location and other personal metadata, strips them with the
 * privacy step's code and checks that the copies are lossless and clean, that the verification
 * rejects copies that are not, and that stripping is deterministic. Fails, rather than skips, when a
 * tool is missing.
 */
import assert from 'node:assert/strict'
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import {dataPaths} from '../src/config'
import {ensureStrippedCopy, type PrivacyMap} from '../src/privacy/copies'
import {pixelHashes, stripImage, verifyStrippedImage} from '../src/privacy/image'
import {PRIVACY_RULES_VERSION} from '../src/privacy/rules'
import {scanLocalFile} from '../src/privacy/scan'
import {compareMediaPackets, stripVideo, verifyStrippedVideo} from '../src/privacy/video'
import {hashFile} from '../src/util'
import {runCommand} from '../src/video/ffmpeg'

const dir = mkdtempSync(path.join(tmpdir(), 'privacy-integration-'))
after(() => rmSync(dir, {recursive: true, force: true}))

async function run(command: string, ...args: string[]): Promise<void> {
  const result = await runCommand(command, args)
  assert.equal(result.code, 0, `${command} ${args.join(' ')}: ${result.stderr}`)
}

const ICC = '/System/Library/ColorSync/Profiles/Display P3.icc'

describe('privacy stripping with the real tools', () => {
  const photo = path.join(dir, 'photo.jpg')
  const screenshot = path.join(dir, 'screenshot.png')
  const video = path.join(dir, 'clip.mov')

  before(async () => {
    // A photo shown rotated (orientation 6) with a Display P3 profile, GPS, a unique id, a creator
    // and a camera make (which is kept).
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', '-q:v', '3', photo)
    await run(
      'exiftool', '-q', '-overwrite_original', '-n',
      '-GPSLatitude=1.5', '-GPSLatitudeRef=N', '-GPSLongitude=2.5', '-GPSLongitudeRef=E',
      '-Orientation=6', '-ImageUniqueID=0123456789abcdef0123456789abcdef', '-XMP-dc:Creator=Someone', '-Make=TestCam',
      '-DateTimeOriginal=2024:05:17 15:15:48', '-ExposureTime=0.01', '-XMP-xmp:CreatorTool=TestCam firmware',
      `-ICC_Profile<=${ICC}`, photo,
    )
    // A screenshot whose PNG eXIf chunk holds a unique id and its capture time, like an Android one.
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=200x100', '-frames:v', '1', screenshot)
    await run('exiftool', '-q', '-overwrite_original', '-ImageUniqueID=fedcba9876543210fedcba9876543210', '-DateTimeOriginal=2024:05:17 15:15:48', '-Software=Screenshotter', screenshot)
    // A phone-like video: rotated, with audio, a location atom and a timecode (data) track.
    const base = path.join(dir, 'base.mov')
    await run(
      'ffmpeg', '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata', 'location=+00.0000+000.0000/', '-timecode', '00:00:00:00', base,
    )
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-display_rotation', '90', '-i', base, '-map', '0', '-c', 'copy', '-timecode', '00:00:00:00', video)
  })

  it('finds the personal metadata', async () => {
    const photoScan = await scanLocalFile(photo)
    assert.equal(photoScan.kind, 'image')
    const categories = new Set(photoScan.findings.map((f) => f.category))
    assert.deepEqual([...categories].sort(), ['identifier', 'location', 'person'])
    assert.ok(!photoScan.findings.some((f) => /Make|Orientation|ICC/.test(f.tag)), 'the make, orientation and profile are not personal')
    assert.deepEqual((await scanLocalFile(screenshot)).findings.map((f) => f.tag), ['EXIF:ExifIFD:Main:ImageUniqueID'])
    const videoScan = await scanLocalFile(video)
    assert.equal(videoScan.kind, 'video')
    assert.ok(videoScan.findings.some((f) => f.category === 'location'), 'the location atom is found')
    assert.ok(videoScan.findings.some((f) => f.category === 'data-track' && f.tag.includes('tmcd')), 'the timecode track is found')
  })

  it('strips a photo without touching its pixels, orientation or ICC profile', async () => {
    const out = path.join(dir, 'photo-stripped.jpg')
    const findings = (await scanLocalFile(photo)).findings
    const {deletions} = await stripImage(photo, out, findings)
    assert.deepEqual(deletions, ['-ExifIFD:ImageUniqueID=', '-GPS:all=', '-XMP-dc:Creator='])
    const verification = await verifyStrippedImage(photo, out, deletions)
    assert.equal(verification.orientation, 6)
    assert.ok(verification.iccProfileSha256)
    assert.ok(verification.pixels.ffmpeg, 'ffmpeg decoded the JPEG too')
    assert.deepEqual((await scanLocalFile(out)).findings, [])
    const make = await runCommand('exiftool', ['-s3', '-Make', out])
    assert.equal(make.stdout.trim(), 'TestCam')
  })

  it('strips a PNG eXIf chunk and keeps the pixels', async () => {
    const out = path.join(dir, 'screenshot-stripped.png')
    const findings = (await scanLocalFile(screenshot)).findings
    const {deletions} = await stripImage(screenshot, out, findings)
    await verifyStrippedImage(screenshot, out, deletions)
    assert.deepEqual((await scanLocalFile(out)).findings, [])
  })

  it('refuses a strip in which exiftool also drops tags that are not personal', async () => {
    // exiftool deletes an EXIF IFD that is left with only the tags it adds itself (ExifVersion,
    // ComponentsConfiguration, ColorSpace). The verification must notice and refuse.
    const bare = path.join(dir, 'bare.png')
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x32', '-frames:v', '1', bare)
    await run('exiftool', '-q', '-overwrite_original', '-ImageUniqueID=00112233445566778899aabbccddeeff', bare)
    const out = path.join(dir, 'bare-stripped.png')
    const {deletions} = await stripImage(bare, out, (await scanLocalFile(bare)).findings)
    await assert.rejects(verifyStrippedImage(bare, out, deletions), /ColorSpace was removed although it is not personal/)
  })

  it('rejects a copy whose pixels or other tags changed', async () => {
    const reencoded = path.join(dir, 'photo-reencoded.jpg')
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-i', photo, '-q:v', '10', reencoded)
    await assert.rejects(verifyStrippedImage(photo, reencoded, []), /not a lossless strip/)
    const otherTag = path.join(dir, 'photo-other-tag.jpg')
    const {deletions} = await stripImage(photo, otherTag, (await scanLocalFile(photo)).findings)
    await run('exiftool', '-q', '-overwrite_original', '-Make=', otherTag)
    await assert.rejects(verifyStrippedImage(photo, otherTag, deletions), /Make was removed although it is not personal/)
    const a = await pixelHashes(photo)
    const b = await pixelHashes(reencoded)
    assert.notDeepEqual(a.magick, b.magick)
  })

  it('strips a video in place: same packets, rotation and streams, no location and no data track', async () => {
    const out = path.join(dir, 'clip-stripped.mov')
    const result = await stripVideo(video, out)
    assert.deepEqual(result.removedTracks.map((t) => t.handler), ['tmcd'])
    assert.ok(result.removals.some((r) => /tref \(to removed tracks/.test(r.what)), "the video track's link to the timecode track goes too")
    const verification = await verifyStrippedVideo(video, out, result.changedRanges)
    assert.deepEqual(verification.streams.map((s) => s.codecType), ['video', 'audio'])
    assert.ok(verification.sideData.includes('Display Matrix'), 'the rotation is kept')
    assert.deepEqual(await compareMediaPackets(video, out), [])
    assert.deepEqual((await scanLocalFile(out)).findings, [])
    // A copy with re-encoded video is rejected.
    const reencoded = path.join(dir, 'clip-reencoded.mov')
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-i', out, '-c:v', 'libx264', '-crf', '30', '-c:a', 'copy', reencoded)
    assert.notDeepEqual(await compareMediaPackets(video, reencoded), [])
  })

  it('makes the same copy every time, and reuses a verified copy', async () => {
    const root = path.join(dir, 'data')
    const paths = dataPaths(root)
    const original = path.join(dir, 'photo-original.jpg')
    copyFileSync(photo, original)
    const sha1 = await hashFile(original, 'sha1')
    const findings = (await scanLocalFile(original)).findings
    const map: PrivacyMap = {rulesVersion: PRIVACY_RULES_VERSION, tools: {exiftool: '', ffprobe: '', magick: ''}, updatedAt: '', bucket: {}, copies: {}}
    const first = await ensureStrippedCopy(paths, map, {file: original, sha1, filename: 'photo.jpg', kind: 'image', findings})
    const reused = await ensureStrippedCopy(paths, map, {file: original, sha1, filename: 'photo.jpg', kind: 'image', findings})
    assert.equal(reused.sha1, first.sha1)
    assert.equal(reused.strippedAt, first.strippedAt)
    rmSync(path.join(paths.privacy, first.file))
    const again = await ensureStrippedCopy(paths, map, {file: original, sha1, filename: 'photo.jpg', kind: 'image', findings})
    assert.equal(again.sha1, first.sha1, 'stripping again gives the same bytes')
    await assert.rejects(
      ensureStrippedCopy(paths, map, {file: original, sha1, filename: 'model.stl', kind: 'stl', findings}),
      /strips only images and ISO BMFF/,
    )
  })
})
