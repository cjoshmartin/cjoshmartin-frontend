/**
 * Unit tests of the image stripper with fixtures built byte by byte (no tools needed). The media
 * tests (image-strip.integration.ts) check real files with exiftool and two decoders.
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {crc32, deflateSync, inflateSync} from 'node:zlib'

import {concat, ImageStripError, orientationExif, summarizeExif, TiffReader} from '../exif'
import {analyzeImage, detectImageFormat, stripImage} from '../image-strip'

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAWEAEBAQAAAAAAAAAAAAAAAAAAFWL/xAAVAQEBAAAAAAAAAAAAAAAAAAAFB//EABkRAAEFAAAAAAAAAAAAAAAAAAAFFlOR8P/aAAwDAQACEQMRAD8AjdnQCtM1Jj1DLsU5NZ//2Q==',
  'base64',
)
const TINY_WEBP_LOSSLESS = Buffer.from('UklGRiYAAABXRUJQVlA4TBoAAAAvA8AAAB8QU/XV//kPJ4FAgDBp0qSNiP7HCQ==', 'base64')
const enc = (text: string) => new TextEncoder().encode(text)

// ---------------------------------------------------------------------------------------------
// Builders.

interface Entry {
  tag: number
  type: number
  count: number
  value: Uint8Array
}

/** A big-endian TIFF structure: IFD0 entries, optional sub-IFDs and an optional IFD1. */
function tiffStructure(ifd0: Entry[], subIfds: Record<number, Entry[]> = {}, ifd1?: Entry[]): Uint8Array {
  // Layout: header, IFD0, sub-IFDs, IFD1, then all out-of-line values.
  const ifdSize = (entries: Entry[]) => 2 + entries.length * 12 + 4
  const pointerTags = Object.keys(subIfds).map(Number)
  const ifd0Entries = [...ifd0, ...pointerTags.map((tag) => ({tag, type: 4, count: 1, value: new Uint8Array(4)}))].sort((a, b) => a.tag - b.tag)
  let cursor = 8
  const ifd0Offset = cursor
  cursor += ifdSize(ifd0Entries)
  const subOffsets: Record<number, number> = {}
  for (const tag of pointerTags) {
    subOffsets[tag] = cursor
    cursor += ifdSize(subIfds[tag])
  }
  const ifd1Offset = ifd1 ? cursor : 0
  if (ifd1) cursor += ifdSize(ifd1)
  const out = new Uint8Array(cursor + 4096)
  const view = new DataView(out.buffer)
  out.set([0x4d, 0x4d, 0x00, 0x2a])
  view.setUint32(4, ifd0Offset)
  let valueCursor = cursor
  const writeIfd = (offset: number, entries: Entry[], next: number) => {
    view.setUint16(offset, entries.length)
    entries.forEach((e, i) => {
      const at = offset + 2 + i * 12
      view.setUint16(at, e.tag)
      view.setUint16(at + 2, e.type)
      view.setUint32(at + 4, e.count)
      const value = pointerTags.includes(e.tag) && e.type === 4 && offset === ifd0Offset ? u32(subOffsets[e.tag]) : e.value
      if (value.length <= 4) out.set(value, at + 8)
      else {
        view.setUint32(at + 8, valueCursor)
        out.set(value, valueCursor)
        valueCursor += value.length + (value.length % 2)
      }
    })
    view.setUint32(offset + 2 + entries.length * 12, next)
  }
  writeIfd(ifd0Offset, ifd0Entries, ifd1Offset)
  for (const tag of pointerTags) writeIfd(subOffsets[tag], subIfds[tag], 0)
  if (ifd1) writeIfd(ifd1Offset, ifd1, 0)
  return out.slice(0, valueCursor)
}

const u16 = (n: number) => Uint8Array.from([n >> 8, n & 0xff])
const u32 = (n: number) => Uint8Array.from([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
const ascii = (tag: number, text: string): Entry => ({tag, type: 2, count: text.length + 1, value: enc(`${text}\0`)})
const short = (tag: number, value: number): Entry => ({tag, type: 3, count: 1, value: concat([u16(value), new Uint8Array(2)])})
const rational = (tag: number, num: number, den: number): Entry => ({tag, type: 5, count: 1, value: concat([u32(num), u32(den)])})

/** EXIF with orientation, Make, a GPS IFD and optionally a thumbnail IFD. */
function personalExif(orientation: number, thumbnail = false): Uint8Array {
  return tiffStructure(
    [ascii(271, 'TestCameraMake'), short(274, orientation)],
    {34853: [ascii(1, 'N'), rational(2, 51, 1)]},
    thumbnail ? [short(259, 6)] : undefined,
  )
}

function jpegSegment(marker: number, data: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([0xff, marker]), u16(data.length + 2), data])
}

/** TINY_JPEG with segments inserted after its JFIF APP0 and bytes appended after EOI. */
function jpegWith(segments: Uint8Array[], trailing = new Uint8Array(0)): Uint8Array {
  const jfifEnd = 2 + 2 + ((TINY_JPEG[4] << 8) | TINY_JPEG[5])
  return concat([TINY_JPEG.subarray(0, jfifEnd), ...segments, TINY_JPEG.subarray(jfifEnd), trailing])
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([enc(type), data])
  return concat([u32(data.length), body, u32(crc32(body))])
}

/** A 2x2 RGB PNG with the given extra chunks between IHDR and IDAT. */
function pngWith(extra: Uint8Array[]): {file: Uint8Array; idat: Uint8Array} {
  const ihdr = concat([u32(2), u32(2), Uint8Array.from([8, 2, 0, 0, 0])])
  const raw = Uint8Array.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9])
  const idat = pngChunk('IDAT', deflateSync(raw))
  const file = concat([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), ...extra, idat, pngChunk('IEND', new Uint8Array(0))])
  return {file, idat}
}

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, data.length, true)
  return concat([enc(fourcc), size, data, data.length % 2 ? new Uint8Array(1) : new Uint8Array(0)])
}

function webpWith(chunks: Uint8Array[], flags: number): Uint8Array {
  const vp8x = new Uint8Array(10)
  vp8x[0] = flags
  vp8x.set([3, 0, 0, 3, 0, 0], 4) // canvas 4x4
  const body = concat([enc('WEBP'), riffChunk('VP8X', vp8x), ...chunks])
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, body.length, true)
  return concat([enc('RIFF'), size, body])
}

const TINY_VP8L = TINY_WEBP_LOSSLESS.subarray(12)

function gifWith(extensions: Uint8Array[]): Uint8Array {
  const header = concat([enc('GIF89a'), Uint8Array.from([1, 0, 1, 0, 0x80, 0, 0]), Uint8Array.from([0, 0, 0, 255, 255, 255])])
  const image = Uint8Array.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00])
  return concat([header, ...extensions, image, Uint8Array.from([0x3b])])
}

function gifApplication(id: string, data: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([0x21, 0xff, 11]), enc(id), Uint8Array.from([data.length]), data, Uint8Array.from([0])])
}

// ---------------------------------------------------------------------------------------------
// EXIF helpers.

test('summarizeExif finds personal tags, the orientation and a thumbnail', () => {
  const summary = summarizeExif(personalExif(6, true))
  assert.equal(summary.orientation, 6)
  assert.deepEqual(summary.personal, ['Make', 'GPS', 'thumbnail (IFD1)'])
})

test('summarizeExif treats orientation, resolution and colour space as technical', () => {
  const exif = tiffStructure([short(274, 3), rational(282, 72, 1), rational(283, 72, 1), short(296, 2)], {34665: [short(40961, 1)]})
  assert.deepEqual(summarizeExif(exif), {orientation: 3, personal: []})
})

test('orientationExif is one big-endian IFD with only the orientation', () => {
  const exif = orientationExif(8)
  const reader = new TiffReader(exif)
  const ifd = reader.ifd(reader.firstIfdOffset)
  assert.deepEqual(ifd.entries.map((e) => [e.tag, reader.integers(e)[0]]), [[274, 8]])
  assert.equal(ifd.next, 0)
  assert.throws(() => orientationExif(1), RangeError)
})

test('a malformed EXIF block is an error, not a guess', () => {
  assert.throws(() => summarizeExif(Uint8Array.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 200])), ImageStripError)
  assert.throws(() => summarizeExif(Uint8Array.from([0x4d, 0x4d, 0, 43, 0, 8, 0, 0, 0, 0, 0, 0, 0, 16])), /BigTIFF/)
})

// ---------------------------------------------------------------------------------------------
// JPEG.

test('JPEG: removes EXIF, XMP, IPTC, comments, MPF and trailing data; keeps JFIF, ICC, Adobe and the orientation', () => {
  const icc = jpegSegment(0xe2, concat([enc('ICC_PROFILE\0'), Uint8Array.from([1, 1]), enc('fake-icc-profile')]))
  const adobe = jpegSegment(0xee, concat([enc('Adobe'), Uint8Array.from([0, 100, 0, 0, 0, 0, 1])]))
  const input = jpegWith(
    [
      jpegSegment(0xe1, concat([enc('Exif\0\0'), personalExif(6, true)])),
      jpegSegment(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>TestPersonName</x:xmpmeta>')),
      icc,
      jpegSegment(0xed, enc('Photoshop 3.0\0TestPersonName')),
      jpegSegment(0xe2, enc('MPF\0MM\0*')),
      adobe,
      jpegSegment(0xfe, enc('TestComment')),
    ],
    enc('TestPlace motion photo'),
  )
  const result = stripImage(input)
  assert.equal(result.format, 'jpeg')
  assert.deepEqual(result.personal, [
    'EXIF: Make, GPS, thumbnail (IFD1)',
    'XMP',
    'APP13 (Photoshop/IPTC)',
    'MPF (multi-picture index)',
    'comment (COM)',
    '22 bytes after the end of the image (e.g. MPF secondary images, motion photo)',
  ])
  const output = result.output!
  assert.ok(!Buffer.from(output).toString('latin1').includes('Test'))
  const jfifEnd = 2 + 2 + ((TINY_JPEG[4] << 8) | TINY_JPEG[5])
  const exif = jpegSegment(0xe1, concat([enc('Exif\0\0'), orientationExif(6)]))
  assert.deepEqual(output, concat([TINY_JPEG.subarray(0, jfifEnd), exif, icc, adobe, TINY_JPEG.subarray(jfifEnd)]))
  assert.equal(analyzeImage(output).orientation, 6)
  assert.equal(stripImage(output).output, undefined, 'stripping again changes nothing')
})

test('JPEG: an image with only technical EXIF is left alone', () => {
  const input = jpegWith([jpegSegment(0xe1, concat([enc('Exif\0\0'), tiffStructure([short(274, 6), rational(282, 72, 1)])]))])
  const result = stripImage(input)
  assert.deepEqual(result.personal, [])
  assert.equal(result.output, undefined)
  assert.equal(result.orientation, 6)
})

test('JPEG: a JFIF thumbnail is removed and the JFIF header kept', () => {
  const jfif = concat([enc('JFIF\0'), Uint8Array.from([1, 1, 0, 0, 1, 0, 1, 1, 1]), Uint8Array.from([1, 2, 3])])
  const input = concat([Uint8Array.from([0xff, 0xd8]), jpegSegment(0xe0, jfif), TINY_JPEG.subarray(20)])
  const result = stripImage(input)
  assert.deepEqual(result.personal, ['JFIF thumbnail'])
  assert.deepEqual(result.output!.subarray(0, 20), concat([Uint8Array.from([0xff, 0xd8]), jpegSegment(0xe0, concat([enc('JFIF\0'), Uint8Array.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]))]))
})

test('JPEG: errors for files that are not complete JPEGs', () => {
  assert.throws(() => stripImage(TINY_JPEG.subarray(0, 100)), ImageStripError)
  assert.throws(() => stripImage(concat([TINY_JPEG.subarray(0, 20), Uint8Array.from([0x12, 0x34])])), /unexpected data/)
})

// ---------------------------------------------------------------------------------------------
// PNG.

test('PNG: removes eXIf (keeps the orientation), text, XMP, tIME and iDOT; keeps iCCP and pixels', () => {
  const iccp = pngChunk('iCCP', concat([enc('ICC Profile\0\0'), deflateSync(enc('fake-icc'))]))
  const {file, idat} = pngWith([
    iccp,
    pngChunk('eXIf', personalExif(6)),
    pngChunk('tEXt', enc('Author\0TestPersonName')),
    pngChunk('iTXt', enc('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>TestPlace</x:xmpmeta>')),
    pngChunk('tIME', Uint8Array.from([7, 228, 1, 2, 3, 4, 5])),
    pngChunk('iDOT', new Uint8Array(28)),
  ])
  const result = stripImage(file)
  assert.deepEqual(result.personal, ['EXIF: Make, GPS', 'text "Author" (tEXt)', 'XMP', 'modification time (tIME)'])
  const {file: expected} = pngWith([iccp, pngChunk('eXIf', orientationExif(6))])
  assert.deepEqual(result.output, expected)
  assert.ok(Buffer.from(result.output!).includes(Buffer.from(idat)))
  // The pixels decode the same: the same IDAT.
  assert.deepEqual(inflateSync(idat.subarray(8, idat.length - 4)), Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]))
})

test('PNG: only Apple iDOT and technical EXIF is not personal', () => {
  const {file} = pngWith([pngChunk('eXIf', tiffStructure([short(274, 1)])), pngChunk('iDOT', new Uint8Array(28))])
  assert.equal(stripImage(file).output, undefined)
})

test('PNG: unknown ancillary chunks and data after IEND are personal', () => {
  const {file} = pngWith([pngChunk('zzZz', enc('TestPersonName'))])
  const result = stripImage(concat([file, enc('TestPlace')]))
  assert.deepEqual(result.personal, ['unknown chunk zzZz', '9 bytes after IEND'])
  assert.deepEqual(result.output, pngWith([]).file)
})

// ---------------------------------------------------------------------------------------------
// WebP.

test('WebP: removes EXIF (keeps the orientation) and XMP and fixes the VP8X flags and RIFF size', () => {
  const input = webpWith(
    [riffChunk('VP8L', TINY_VP8L.subarray(8)), riffChunk('EXIF', personalExif(3)), riffChunk('XMP ', enc('<x:xmpmeta>TestPersonName</x:xmpmeta>'))],
    0x08 | 0x04,
  )
  const result = stripImage(input)
  assert.deepEqual(result.personal, ['EXIF: Make, GPS', 'XMP'])
  const expected = webpWith([riffChunk('VP8L', TINY_VP8L.subarray(8)), riffChunk('EXIF', orientationExif(3))], 0x08)
  assert.deepEqual(result.output, expected)
  assert.equal(new DataView(expected.buffer).getUint32(4, true), expected.length - 8)
})

test('WebP: a simple lossless file has nothing to remove', () => {
  const result = stripImage(TINY_WEBP_LOSSLESS)
  assert.equal(result.format, 'webp')
  assert.deepEqual(result.removed, [])
})

// ---------------------------------------------------------------------------------------------
// GIF.

test('GIF: removes comments and XMP; keeps looping and graphic control', () => {
  const netscape = gifApplication('NETSCAPE2.0', Uint8Array.from([1, 0, 0]))
  const gce = Uint8Array.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0])
  const input = gifWith([
    netscape,
    Uint8Array.from([0x21, 0xfe, 11, ...enc('TestComment'), 0]),
    gifApplication('XMP DataXMP', enc('<x:xmpmeta>TestPersonName</x:xmpmeta>')),
    gce,
  ])
  const result = stripImage(input)
  assert.deepEqual(result.personal, ['comment extension', 'XMP'])
  assert.deepEqual(result.output, gifWith([netscape, gce]))
})

// ---------------------------------------------------------------------------------------------
// TIFF.

test('TIFF: keeps only image tags, the orientation and ICC; copies the pixels; drops EXIF, GPS and XMP', () => {
  const pixels = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])
  const placeholder = {tag: 273, type: 4, count: 1, value: u32(0)}
  const icc = enc('fake-icc-profile')
  const entries: Entry[] = [
    {tag: 256, type: 3, count: 1, value: concat([u16(2), new Uint8Array(2)])},
    {tag: 257, type: 3, count: 1, value: concat([u16(2), new Uint8Array(2)])},
    {tag: 258, type: 3, count: 3, value: concat([u16(8), u16(8), u16(8)])},
    short(259, 1),
    short(262, 2),
    ascii(271, 'TestCameraMake'),
    placeholder,
    short(274, 8),
    short(277, 3),
    short(278, 2),
    {tag: 279, type: 4, count: 1, value: u32(pixels.length)},
    ascii(315, 'TestPersonName'),
    {tag: 700, type: 1, count: 13, value: enc('TestPlace XMP')},
    {tag: 34675, type: 7, count: icc.length, value: icc},
  ]
  let file = tiffStructure(entries, {34853: [ascii(1, 'N')], 34665: [ascii(36867, '2020:01:02 03:04:05')]})
  // Append the pixels and point StripOffsets at them.
  const offset = file.length
  file = concat([file, pixels])
  const reader = new TiffReader(file)
  const stripEntry = reader.ifd(reader.firstIfdOffset).entries.find((e) => e.tag === 273)!
  new DataView(file.buffer).setUint32(stripEntry.valueOffset, offset)

  const result = stripImage(file)
  assert.equal(result.format, 'tiff')
  assert.deepEqual(result.personal, ['TIFF: Make, Artist, XMP, EXIF IFD, GPS'])
  const out = new TiffReader(result.output!)
  const ifd = out.ifd(out.firstIfdOffset)
  assert.deepEqual(ifd.entries.map((e) => e.tag), [256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 34675])
  const strip = ifd.entries.find((e) => e.tag === 273)!
  const start = out.integers(strip)[0]
  assert.deepEqual(result.output!.subarray(start, start + pixels.length), pixels)
  assert.equal(result.orientation, 8)
  assert.deepEqual(out.value(ifd.entries.find((e) => e.tag === 34675)!), icc)
  assert.ok(!Buffer.from(result.output!).toString('latin1').includes('Test'))
  assert.equal(stripImage(result.output!).output, undefined)
})

// ---------------------------------------------------------------------------------------------
// Formats that are not accepted.

test('detects formats from the bytes and refuses SVG and unknown files', () => {
  assert.equal(detectImageFormat(TINY_JPEG), 'jpeg')
  assert.equal(detectImageFormat(TINY_WEBP_LOSSLESS), 'webp')
  assert.equal(detectImageFormat(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg')
  assert.throws(() => stripImage(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), /SVG images are not supported/)
  assert.throws(() => stripImage(enc('BM this is a bitmap')), ImageStripError)
})
