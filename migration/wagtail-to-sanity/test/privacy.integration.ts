/**
 * Runs the real exiftool, ffmpeg, ffprobe and ImageMagick (`npm run test:ffmpeg`): makes a photo, a
 * screenshot and a phone-like video with location and other personal metadata, strips them with the
 * privacy step's code (the Functions' strippers) and checks that the copies are lossless and clean,
 * that an iOS-like leftover movie header in mdat is found and removed, that the verification rejects
 * copies that are not lossless, and that stripping is deterministic. Fails, rather than skips, when
 * a tool is missing.
 */
import assert from 'node:assert/strict'
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
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
    // A photo shown rotated (orientation 6) with a Display P3 profile, GPS, a unique id, a creator,
    // a camera make, a capture time and a creator tool.
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
    // A phone-like video: rotated, with audio, a location atom, a creation time and a timecode (data)
    // track.
    const base = path.join(dir, 'base.mov')
    await run(
      'ffmpeg', '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata', 'location=+00.0000+000.0000/', '-timecode', '00:00:00:00', base,
    )
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-display_rotation', '90', '-i', base, '-map', '0', '-c', 'copy', '-timecode', '00:00:00:00', '-metadata', 'creation_time=2024-05-17T15:15:48Z', video)
  })

  it('finds the personal metadata', async () => {
    const photoScan = await scanLocalFile(photo)
    assert.equal(photoScan.kind, 'image')
    const categories = new Set(photoScan.findings.map((f) => f.category))
    // ffmpeg's encoder name in a JPEG comment is free text too.
    assert.deepEqual([...categories].sort(), ['capture-time', 'comment', 'device', 'identifier', 'location', 'metadata', 'person'])
    assert.ok(!photoScan.findings.some((f) => /Orientation|ICC/.test(f.tag)), 'the orientation and profile are not personal')
    const screenshotTags = (await scanLocalFile(screenshot)).findings.map((f) => f.tag)
    for (const tag of ['EXIF:ExifIFD:Main:ImageUniqueID', 'EXIF:ExifIFD:Main:DateTimeOriginal', 'EXIF:IFD0:Main:Software']) assert.ok(screenshotTags.includes(tag), tag)
    assert.ok(screenshotTags.some((t) => t.startsWith('ImageStrip:')), "the Function's stripper would remove the eXIf chunk")
    const videoScan = await scanLocalFile(video)
    assert.equal(videoScan.kind, 'video')
    assert.ok(videoScan.findings.some((f) => f.category === 'location'), 'the location atom is found')
    assert.ok(videoScan.findings.some((f) => f.category === 'data-track' && f.tag.includes('tmcd')), 'the timecode track is found')
    assert.ok(videoScan.findings.some((f) => f.tag.startsWith('Container:') && /creation and modification times/.test(f.tag)), 'the creation times are found')
  })

  it("strips a photo with the Function's stripper without touching its pixels, orientation or ICC profile", async () => {
    const out = path.join(dir, 'photo-stripped.jpg')
    const method = await stripImage(photo, out)
    assert.equal(method.tool, 'image-strip')
    assert.ok(method.removed.some((r) => /GPS/.test(r)), method.removed.join('; '))
    const verification = await verifyStrippedImage(photo, out)
    assert.equal(verification.orientation, 6)
    assert.ok(verification.iccProfileSha256)
    assert.ok(verification.pixels.ffmpeg, 'ffmpeg decoded the JPEG too')
    assert.ok(verification.removedTags.includes('EXIF:IFD0:Main:Make'))
    assert.deepEqual((await scanLocalFile(out)).findings, [])
  })

  it('strips a PNG eXIf chunk and keeps the pixels', async () => {
    const out = path.join(dir, 'screenshot-stripped.png')
    await stripImage(screenshot, out)
    await verifyStrippedImage(screenshot, out)
    assert.deepEqual((await scanLocalFile(out)).findings, [])
  })

  it('rejects a copy whose pixels changed or that gained a tag', async () => {
    const reencoded = path.join(dir, 'photo-reencoded.jpg')
    await run('ffmpeg', '-hide_banner', '-v', 'error', '-y', '-i', photo, '-q:v', '10', reencoded)
    await assert.rejects(verifyStrippedImage(photo, reencoded), /not a lossless strip/)
    const added = path.join(dir, 'photo-added-tag.jpg')
    await stripImage(photo, added)
    await run('exiftool', '-q', '-overwrite_original', '-XResolution=300', added)
    await assert.rejects(verifyStrippedImage(photo, added), /XResolution (was added|changed)/)
    const a = await pixelHashes(photo)
    const b = await pixelHashes(reencoded)
    assert.notDeepEqual(a.magick, b.magick)
  })

  it('strips a video in place: same packets, rotation and streams, no location, data track or creation time', async () => {
    const out = path.join(dir, 'clip-stripped.mov')
    const result = await stripVideo(video, out)
    assert.ok(result.removals.some((r) => /tmcd/.test(r.what)), result.removals.map((r) => r.what).join('; '))
    assert.ok(result.removals.some((r) => /creation and modification times/.test(r.what)))
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

  it('zeroes a draft movie header that iOS leaves in mdat, which exiftool and ffprobe do not see', async () => {
    // Insert an unreferenced "hoov" box with a location at the end of mdat (moov follows mdat, so
    // no chunk offset moves), as the iPhone files have.
    const bytes = await readFile(video)
    const mdat = bytes.indexOf(Buffer.from('mdat')) - 4
    const size = bytes.readUInt32BE(mdat)
    const hoovText = Buffer.from('keys com.apple.quicktime.location.ISO6709 +12.3456+123.4567+010.000/', 'latin1')
    const hoov = Buffer.alloc(8 + hoovText.length)
    hoov.writeUInt32BE(hoov.length, 0)
    hoov.write('hoov', 4, 'latin1')
    hoovText.copy(hoov, 8)
    const withLeftover = Buffer.concat([bytes.subarray(0, mdat + size), hoov, bytes.subarray(mdat + size)])
    withLeftover.writeUInt32BE(size + hoov.length, mdat)
    const input = path.join(dir, 'clip-hoov.mov')
    await writeFile(input, withLeftover)
    assert.deepEqual(await compareMediaPackets(video, input), [], 'the packets are the same, so players ignore it')
    const scan = await scanLocalFile(input)
    assert.ok(scan.findings.some((f) => /ISO 6709 coordinates found outside the samples/.test(f.tag)), scan.findings.map((f) => f.tag).join('; '))
    const out = path.join(dir, 'clip-hoov-stripped.mov')
    const result = await stripVideo(input, out)
    assert.ok(result.unreferenced.nonZeroBytes >= hoov.length - 3)
    await verifyStrippedVideo(input, out, result.changedRanges)
    assert.ok(!(await readFile(out)).includes(Buffer.from('+12.3456')), 'the location is gone')
    assert.deepEqual((await scanLocalFile(out)).findings, [])
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
