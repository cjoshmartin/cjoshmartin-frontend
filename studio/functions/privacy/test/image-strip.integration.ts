/**
 * Media test of the image stripper (`npm run test:media`): makes images in every accepted format
 * with ImageMagick, tags them with exiftool (GPS position and altitude, camera make, model and
 * serial number, author, place, dates, XMP, IPTC, comments, an EXIF thumbnail, orientation 6, an
 * ICC profile), strips them, and checks the result with the tools, not with the stripper:
 * - exiftool -ee -a -G1 finds no personal tag and none of the fixture's marker strings;
 * - the orientation and the ICC profile (sha256) are the same;
 * - every decoded frame is identical (ffmpeg framemd5 without autorotation, ImageMagick's pixel
 *   signature);
 * - stripping the result again finds nothing personal (the image is left alone).
 * Images with no personal metadata are not changed.
 *
 * With PRIVACY_ORIGINALS_DIR set (for example ~/cjoshmartin-migration/gcs/original_images), every
 * image in it is checked the same way.
 */
import assert from 'node:assert/strict'
import {copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'

import {stripImage} from '../image-strip'
import {exifOrientation, exiftoolTags, ffmpegFrames, iccSha256, magickSignatures, personalTags, tool} from './media-tools'

const ICC = '/System/Library/ColorSync/Profiles/Display P3.icc'
const MARKERS = ['TestCamera', 'TestPerson', 'TestSerial', 'TestComment', 'TestPlace']
const dir = mkdtempSync(path.join(os.tmpdir(), 'image-strip-'))

const EXIF_TAGS = [
  '-GPSLatitude=51.5',
  '-GPSLatitudeRef=N',
  '-GPSLongitude=0.12',
  '-GPSLongitudeRef=W',
  '-GPSAltitude=12',
  '-Make=TestCameraMake',
  '-Model=TestCameraModel',
  '-SerialNumber=TestSerial123',
  '-Artist=TestPersonName',
  '-DateTimeOriginal=2020:01:02 03:04:05',
  '-IFD0:Orientation#=6',
]
const XMP_TAGS = ['-XMP-dc:Creator=TestPersonName', '-XMP-photoshop:City=TestPlace']

function exiftool(file: string, args: string[]): void {
  tool('exiftool', ['-q', '-overwrite_original', ...args, file])
}

function magick(args: string[]): void {
  tool('magick', args)
}

const base = (size = '64x48') => [`-size`, size, 'gradient:red-blue', '-attenuate', '0.4', '+noise', 'Gaussian']

interface Case {
  name: string
  file: string
  make: (file: string) => void
}

const cases: Case[] = [
  {
    name: 'JPEG with EXIF, GPS, thumbnail, XMP, IPTC, comment, ICC, orientation and data after EOI',
    file: 'photo.jpg',
    make(file) {
      magick([...base(), '-profile', ICC, '-quality', '85', file])
      magick([...base('16x12'), path.join(dir, 'thumb.jpg')])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS, '-IPTC:By-line=TestPersonName', '-Comment=TestComment', `-ThumbnailImage<=${path.join(dir, 'thumb.jpg')}`])
      // A motion-photo style trailer after EOI.
      writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('TestPlace trailer with a video')]))
    },
  },
  {
    name: 'progressive JPEG',
    file: 'progressive.jpg',
    make(file) {
      magick([...base(), '-interlace', 'JPEG', '-profile', ICC, file])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS])
    },
  },
  {
    name: 'CMYK JPEG (Adobe APP14 kept)',
    file: 'cmyk.jpg',
    make(file) {
      magick([...base(), '-colorspace', 'CMYK', file])
      exiftool(file, [...EXIF_TAGS, '-Comment=TestComment'])
    },
  },
  {
    name: 'PNG with eXIf, XMP, text chunks, tIME and ICC',
    file: 'screen.png',
    make(file) {
      magick([...base(), '-profile', ICC, file])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS, '-PNG:Author=TestPersonName', '-PNG:Comment=TestComment', '-PNG:ModifyDate=2020:01:02 03:04:05'])
    },
  },
  {
    name: 'animated PNG (APNG)',
    file: 'anim.png',
    make(file) {
      tool('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=4', '-frames:v', '3', '-plays', '0', '-f', 'apng', file])
      exiftool(file, [...XMP_TAGS, '-PNG:Comment=TestComment'])
    },
  },
  {
    name: 'lossy WebP with EXIF, XMP and ICC',
    file: 'lossy.webp',
    make(file) {
      magick([...base(), '-profile', ICC, '-quality', '80', file])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS])
    },
  },
  {
    name: 'lossless WebP with alpha, EXIF and XMP',
    file: 'lossless.webp',
    make(file) {
      magick([...base(), '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '50%', '+channel', '-define', 'webp:lossless=true', file])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS])
    },
  },
  {
    name: 'animated GIF with comment and XMP',
    file: 'anim.gif',
    make(file) {
      magick(['-delay', '10', '-loop', '0', ...base('32x24'), '(', ...base('32x24'), ')', '(', ...base('32x24'), ')', file])
      exiftool(file, ['-Comment=TestComment', ...XMP_TAGS])
    },
  },
  {
    name: 'AVIF with EXIF, GPS and XMP items',
    file: 'photo.avif',
    make(file) {
      magick([...base(), '-profile', ICC, '-quality', '60', file])
      exiftool(file, [...EXIF_TAGS.filter((t) => !t.startsWith('-IFD0:Orientation')), ...XMP_TAGS])
    },
  },
  {
    name: 'LZW TIFF with EXIF, GPS, XMP, IPTC, ICC and orientation',
    file: 'scan.tif',
    make(file) {
      magick([...base(), '-profile', ICC, '-compress', 'LZW', file])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS, '-IPTC:By-line=TestPersonName', '-ImageDescription=TestPlace', '-Software=TestCameraApp'])
    },
  },
  {
    name: 'tiled multi-page TIFF',
    file: 'pages.tif',
    make(file) {
      magick([...base(), '(', ...base(), '-flip', ')', '-define', 'tiff:tile-geometry=16x16', '-compress', 'Zip', file])
      exiftool(file, [...EXIF_TAGS, ...XMP_TAGS])
    },
  },
]

for (const c of cases) {
  test(`strips ${c.name}`, () => {
    const input = path.join(dir, c.file)
    c.make(input)
    const before = exiftoolTags(input)
    assert.ok(personalTags(before, MARKERS).length > 0, 'the fixture has personal tags')

    const result = stripImage(new Uint8Array(readFileSync(input)))
    assert.ok(result.output, `stripped: ${result.personal.join('; ')}`)
    const output = path.join(dir, `stripped-${c.file}`)
    writeFileSync(output, result.output)

    const tiff = c.file.endsWith('.tif')
    assert.deepEqual(personalTags(exiftoolTags(output), MARKERS, {tiff}), [], 'no personal tags left')
    assert.ok(!Buffer.from(result.output).toString('latin1').includes('Test'), 'no marker bytes anywhere in the file')
    assert.equal(exifOrientation(output), exifOrientation(input), 'orientation kept')
    assert.equal(iccSha256(output), iccSha256(input), 'ICC profile kept')
    assert.deepEqual(magickSignatures(output), magickSignatures(input), 'ImageMagick decodes the same pixels')
    assert.deepEqual(ffmpegFrames(output), ffmpegFrames(input), 'ffmpeg decodes the same frames')
    assert.equal(stripImage(result.output).output, undefined, 'the stripped file is left alone')
  })
}

test('leaves images without personal metadata unchanged', () => {
  const jpeg = path.join(dir, 'clean.jpg')
  magick([...base(), '-strip', '-profile', ICC, jpeg])
  const png = path.join(dir, 'clean.png')
  magick([...base(), '-strip', '-define', 'png:exclude-chunks=date,time', png])
  const oriented = path.join(dir, 'oriented.jpg')
  copyFileSync(jpeg, oriented)
  // What exiftool writes when it keeps only the orientation: technical EXIF tags, nothing personal.
  exiftool(oriented, ['-IFD0:Orientation#=6', '-XResolution=72', '-YResolution=72', '-ResolutionUnit=inches'])
  for (const file of [jpeg, png, oriented]) {
    const result = stripImage(new Uint8Array(readFileSync(file)))
    assert.deepEqual(result.personal, [], file)
    assert.equal(result.output, undefined, file)
  }
})

const originals = process.env.PRIVACY_ORIGINALS_DIR
test('every image in PRIVACY_ORIGINALS_DIR strips losslessly', {skip: !originals || !existsSync(originals)}, () => {
  let stripped = 0
  for (const name of readdirSync(originals!).sort()) {
    const input = path.join(originals!, name)
    const result = stripImage(new Uint8Array(readFileSync(input)))
    if (!result.output) continue
    stripped += 1
    const output = path.join(dir, `original-${name}`)
    writeFileSync(output, result.output)
    assert.deepEqual(personalTags(exiftoolTags(output), [], {tiff: result.format === 'tiff'}), [], name)
    assert.equal(exifOrientation(output), exifOrientation(input), `${name}: orientation`)
    assert.equal(iccSha256(output), iccSha256(input), `${name}: ICC`)
    assert.deepEqual(magickSignatures(output), magickSignatures(input), `${name}: ImageMagick pixels`)
    assert.deepEqual(ffmpegFrames(output), ffmpegFrames(input), `${name}: ffmpeg frames`)
  }
  assert.ok(stripped > 0)
})
