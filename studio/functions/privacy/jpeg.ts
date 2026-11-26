/**
 * JPEG: removes EXIF (except the orientation), XMP, IPTC/Photoshop, comments, MPF indexes, JFIF
 * thumbnails, all other APPn segments and anything after the end of the image (MPF secondary
 * images such as HDR gain maps and depth maps, motion-photo videos). Keeps JFIF (without a
 * thumbnail), the ICC profile (APP2 ICC_PROFILE), the Adobe APP14 segment (it tells the decoder
 * how to convert colours) and every segment of the coded image byte for byte.
 */
import {
  concat,
  EXIF_PREFIX,
  ImageStripError,
  orientationExif,
  startsWith,
  summarizeExif,
} from './exif'
import type {ImageAnalysis, RemovedItem} from './image-format'

interface Segment {
  marker: number
  /** Offset of the 0xFF of the marker. */
  start: number
  /** End (exclusive); for SOS this includes the entropy-coded data after the header. */
  end: number
}

const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const APP0 = 0xe0
const APP1 = 0xe1
const APP2 = 0xe2
const APP14 = 0xee
const COM = 0xfe

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0'
const XMP_EXTENDED_ID = 'http://ns.adobe.com/xmp/extension/\0'
const ICC_ID = 'ICC_PROFILE\0'

function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
}

/** Splits the file into segments up to and including EOI. */
function readSegments(bytes: Uint8Array): {segments: Segment[]; end: number} {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) {
    throw new ImageStripError('not a JPEG file (no SOI marker)')
  }
  const segments: Segment[] = [{marker: SOI, start: 0, end: 2}]
  let pos = 2
  for (;;) {
    if (pos >= bytes.length) throw new ImageStripError('JPEG ends without an EOI marker')
    if (bytes[pos] !== 0xff) {
      throw new ImageStripError(`JPEG has unexpected data at byte ${pos} (expected a marker)`)
    }
    // Fill bytes: any number of 0xFF before the marker code.
    let markerPos = pos
    while (markerPos + 1 < bytes.length && bytes[markerPos + 1] === 0xff) markerPos++
    if (markerPos + 1 >= bytes.length) throw new ImageStripError('JPEG ends inside a marker')
    const marker = bytes[markerPos + 1]
    if (marker === 0x00) throw new ImageStripError(`JPEG has a stuffed byte outside a scan at ${pos}`)
    if (marker === EOI) {
      segments.push({marker, start: pos, end: markerPos + 2})
      return {segments, end: markerPos + 2}
    }
    if (isStandalone(marker)) {
      segments.push({marker, start: pos, end: markerPos + 2})
      pos = markerPos + 2
      continue
    }
    if (markerPos + 4 > bytes.length) throw new ImageStripError('JPEG segment header is truncated')
    const length = (bytes[markerPos + 2] << 8) | bytes[markerPos + 3]
    if (length < 2) throw new ImageStripError(`JPEG segment 0x${marker.toString(16)} has length ${length}`)
    let end = markerPos + 2 + length
    if (end > bytes.length) {
      throw new ImageStripError(`JPEG segment 0x${marker.toString(16)} runs past the end of the file`)
    }
    if (marker === SOS) {
      // Entropy-coded data follows the scan header up to the next marker that is not a stuffed
      // 0xFF00 or a restart marker.
      let p = end
      for (;;) {
        if (p + 1 >= bytes.length) throw new ImageStripError('JPEG scan data is truncated')
        if (bytes[p] === 0xff) {
          const next = bytes[p + 1]
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            p += 2
            continue
          }
          if (next === 0xff) {
            p += 1
            continue
          }
          break
        }
        p += 1
      }
      end = p
    }
    segments.push({marker, start: pos, end})
    pos = end
  }
}

function payload(bytes: Uint8Array, segment: Segment): Uint8Array {
  // Skip fill bytes, the marker and the 2-byte length.
  let p = segment.start
  while (bytes[p + 1] === 0xff) p++
  return bytes.subarray(p + 4, segment.end)
}

function identifier(data: Uint8Array): string {
  const end = Math.min(data.length, 32)
  let id = ''
  for (let i = 0; i < end; i++) {
    const c = data[i]
    if (c === 0) break
    id += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?'
  }
  return id
}

/** Builds a JPEG segment from a marker and its payload. */
function segmentBytes(marker: number, data: Uint8Array): Uint8Array {
  const length = data.length + 2
  if (length > 0xffff) throw new ImageStripError('JPEG segment would be too long')
  return concat([Uint8Array.from([0xff, marker, length >> 8, length & 0xff]), data])
}

export function analyzeJpeg(bytes: Uint8Array): ImageAnalysis {
  const {segments, end} = readSegments(bytes)
  const removed: RemovedItem[] = []
  const kept: Segment[] = []
  /** A JFIF APP0 that had a thumbnail, rewritten without it. */
  const rewritten = new Map<Segment, Uint8Array>()
  /** Kept segments that the decoder reads: compared between input and output. */
  const imageSegments = new Set<Segment>()
  const iccChunks: {sequence: number; data: Uint8Array}[] = []
  let orientation: number | undefined
  let exifSeen = false

  for (const segment of segments) {
    const {marker} = segment
    const isApp = marker >= APP0 && marker <= 0xef
    if (!isApp && marker !== COM) {
      // SOI, EOI and every segment of the coded image (DQT, DHT, SOFn, DRI, SOS with its data,
      // the JPEG-LS and other extension markers 0xF0-0xFD).
      kept.push(segment)
      imageSegments.add(segment)
      continue
    }
    if (marker === COM) {
      removed.push({what: 'comment (COM)', personal: true})
      continue
    }
    const data = payload(bytes, segment)
    const id = identifier(data)
    if (marker === APP0) {
      if (startsWith(data, 'JFIF\0') && data.length >= 14) {
        const thumbnailPixels = data[12] * data[13]
        if (thumbnailPixels > 0) {
          removed.push({what: 'JFIF thumbnail', personal: true})
          const header = data.slice(0, 14)
          header[12] = 0
          header[13] = 0
          rewritten.set(segment, segmentBytes(APP0, header))
        }
        kept.push(segment)
      } else {
        removed.push({what: id === 'JFXX' ? 'JFIF extension thumbnail (JFXX)' : `APP0 "${id}"`, personal: true})
      }
      continue
    }
    if (marker === APP1 && startsWith(data, EXIF_PREFIX)) {
      const summary = summarizeExif(data.subarray(EXIF_PREFIX.length))
      if (!exifSeen) {
        // Browsers and Sanity's image pipeline read the orientation from the first EXIF block.
        orientation = summary.orientation
        exifSeen = true
      }
      removed.push(
        summary.personal.length > 0
          ? {what: `EXIF: ${summary.personal.join(', ')}`, personal: true}
          : {what: 'EXIF (technical tags only)', personal: false},
      )
      continue
    }
    if (marker === APP1 && startsWith(data, XMP_ID)) {
      removed.push({what: 'XMP', personal: true})
      continue
    }
    if (marker === APP1 && startsWith(data, XMP_EXTENDED_ID)) {
      removed.push({what: 'XMP (extended)', personal: true})
      continue
    }
    if (marker === APP2 && startsWith(data, ICC_ID) && data.length >= 14) {
      iccChunks.push({sequence: data[12], data: data.subarray(14)})
      kept.push(segment)
      continue
    }
    if (marker === APP14 && startsWith(data, 'Adobe')) {
      kept.push(segment)
      imageSegments.add(segment)
      continue
    }
    const name =
      marker === APP2 && id === 'MPF'
        ? 'MPF (multi-picture index)'
        : marker === 0xed
          ? 'APP13 (Photoshop/IPTC)'
          : `APP${marker - 0xe0} "${id}"`
    removed.push({what: name, personal: true})
  }

  if (end < bytes.length) {
    const trailing = bytes.subarray(end)
    removed.push({
      what: `${trailing.length} bytes after the end of the image (e.g. MPF secondary images, motion photo)`,
      personal: trailing.some((b) => b !== 0),
    })
  }

  iccChunks.sort((a, b) => a.sequence - b.sequence)
  const icc = iccChunks.length > 0 ? concat(iccChunks.map((c) => c.data)) : undefined
  const imageData = kept
    .filter((s) => imageSegments.has(s))
    .map((s) => bytes.subarray(s.start, s.end))

  return {
    format: 'jpeg',
    removed,
    orientation,
    icc,
    imageData,
    strip() {
      const parts: Uint8Array[] = [Uint8Array.from([0xff, SOI])]
      const rest = kept.filter((s) => s.marker !== SOI)
      // JFIF must stay the first segment when it was first.
      if (rest[0]?.marker === APP0) {
        const first = rest.shift() as Segment
        parts.push(rewritten.get(first) ?? bytes.subarray(first.start, first.end))
      }
      if (orientation !== undefined) {
        parts.push(segmentBytes(APP1, concat([EXIF_PREFIX, orientationExif(orientation)])))
      }
      for (const segment of rest) {
        parts.push(rewritten.get(segment) ?? bytes.subarray(segment.start, segment.end))
      }
      return concat(parts)
    },
  }
}
