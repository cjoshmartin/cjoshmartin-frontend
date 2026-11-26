/**
 * WebP: removes the EXIF chunk (except the orientation), the XMP chunk, every unknown chunk and
 * anything after the RIFF data, and clears the matching VP8X flags. Keeps ICCP, ANIM, ANMF, ALPH,
 * VP8 and VP8L byte for byte.
 */
import {concat, EXIF_PREFIX, ImageStripError, orientationExif, startsWith, summarizeExif} from './exif'
import type {ImageAnalysis, RemovedItem} from './image-format'

const FLAG_EXIF = 0x08
const FLAG_XMP = 0x04
const IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])

interface Chunk {
  fourcc: string
  start: number
  /** End including the padding byte. */
  end: number
  dataStart: number
  dataEnd: number
}

function chunkBytes(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length + (data.length % 2)
  const out = new Uint8Array(8 + padded)
  out.set(new TextEncoder().encode(fourcc), 0)
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  return out
}

export function analyzeWebp(bytes: Uint8Array): ImageAnalysis {
  if (bytes.length < 20 || !startsWith(bytes, 'RIFF') || !startsWith(bytes, 'WEBP', 8)) {
    throw new ImageStripError('not a WebP file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riffEnd = 8 + view.getUint32(4, true)
  if (riffEnd > bytes.length) throw new ImageStripError('WebP RIFF data runs past the end of the file')
  const chunks: Chunk[] = []
  let pos = 12
  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) throw new ImageStripError('WebP chunk header is truncated')
    const fourcc = String.fromCharCode(...bytes.subarray(pos, pos + 4))
    const size = view.getUint32(pos + 4, true)
    const dataEnd = pos + 8 + size
    const end = dataEnd + (size % 2)
    if (dataEnd > riffEnd) throw new ImageStripError(`WebP chunk ${JSON.stringify(fourcc)} runs past the RIFF data`)
    chunks.push({fourcc, start: pos, end: Math.min(end, riffEnd), dataStart: pos + 8, dataEnd})
    pos = end
  }
  const first = chunks[0]?.fourcc
  if (first !== 'VP8 ' && first !== 'VP8L' && first !== 'VP8X') {
    throw new ImageStripError(`WebP starts with chunk ${JSON.stringify(first)}, not VP8, VP8L or VP8X`)
  }

  const removed: RemovedItem[] = []
  const kept: Chunk[] = []
  let orientation: number | undefined
  let exifPosition: number | undefined
  let icc: Uint8Array | undefined
  for (const chunk of chunks) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataEnd)
    if (IMAGE_CHUNKS.has(chunk.fourcc)) {
      if (chunk.fourcc === 'ICCP') icc = data
      kept.push(chunk)
      continue
    }
    if (chunk.fourcc === 'EXIF') {
      // Some writers keep the JPEG "Exif\0\0" prefix in front of the TIFF header.
      const tiff = startsWith(data, EXIF_PREFIX) ? data.subarray(EXIF_PREFIX.length) : data
      const summary = summarizeExif(tiff)
      if (exifPosition === undefined) {
        orientation = summary.orientation
        exifPosition = kept.length
      }
      removed.push(
        summary.personal.length > 0
          ? {what: `EXIF: ${summary.personal.join(', ')}`, personal: true}
          : {what: 'EXIF (technical tags only)', personal: false},
      )
      continue
    }
    removed.push({
      what: chunk.fourcc === 'XMP ' ? 'XMP' : `unknown chunk ${JSON.stringify(chunk.fourcc)}`,
      personal: true,
    })
  }
  if (riffEnd < bytes.length) {
    const trailing = bytes.subarray(riffEnd)
    removed.push({what: `${trailing.length} bytes after the RIFF data`, personal: trailing.some((b) => b !== 0)})
  }
  if (orientation !== undefined && first !== 'VP8X') {
    // Only the extended format can carry EXIF; a simple file with EXIF is malformed.
    throw new ImageStripError('WebP has an EXIF chunk but no VP8X header')
  }

  /** VP8X with the EXIF and XMP flags set to what the stripped file contains. */
  const vp8xData = (chunk: Chunk): Uint8Array => {
    const data = bytes.slice(chunk.dataStart, chunk.dataEnd)
    if (data.length < 10) throw new ImageStripError('WebP VP8X chunk is too short')
    data[0] = (data[0] & ~(FLAG_EXIF | FLAG_XMP)) | (orientation !== undefined ? FLAG_EXIF : 0)
    return data
  }

  return {
    format: 'webp',
    removed,
    orientation,
    icc,
    imageData: kept
      .filter((c) => c.fourcc !== 'ICCP')
      .map((c) => {
        if (c.fourcc !== 'VP8X') return bytes.subarray(c.start, c.end)
        const data = bytes.slice(c.dataStart, c.dataEnd)
        data[0] &= ~(FLAG_EXIF | FLAG_XMP)
        return data
      }),
    strip() {
      const body: Uint8Array[] = []
      kept.forEach((chunk, index) => {
        if (index === exifPosition && orientation !== undefined) {
          body.push(chunkBytes('EXIF', orientationExif(orientation)))
        }
        body.push(
          chunk.fourcc === 'VP8X'
            ? chunkBytes('VP8X', vp8xData(chunk))
            : bytes.subarray(chunk.start, chunk.end),
        )
      })
      if (exifPosition !== undefined && exifPosition >= kept.length && orientation !== undefined) {
        body.push(chunkBytes('EXIF', orientationExif(orientation)))
      }
      const content = concat(body)
      const header = new Uint8Array(12)
      header.set(new TextEncoder().encode('RIFF'), 0)
      new DataView(header.buffer).setUint32(4, 4 + content.length, true)
      header.set(new TextEncoder().encode('WEBP'), 8)
      return concat([header, content])
    },
  }
}
