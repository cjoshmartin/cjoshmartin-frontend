/**
 * PNG (and APNG): removes eXIf (except the orientation), every text chunk (tEXt, zTXt, iTXt: XMP,
 * comments, author, creation time, ImageMagick's embedded EXIF), tIME, C2PA manifests (caBX), every
 * unknown ancillary chunk and anything after IEND. Apple's iDOT decoding hint is removed too (it
 * stores offsets that removing other chunks would break). Keeps the critical chunks and every
 * registered chunk that changes how the image is shown (colour, transparency, animation, physical
 * size) byte for byte, including iCCP.
 */
import {crc32} from 'node:zlib'

import {concat, ImageStripError, orientationExif, startsWith, summarizeExif} from './exif'
import type {ImageAnalysis, RemovedItem} from './image-format'

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Registered ancillary chunks that affect decoding or display. Kept byte for byte. */
const KEPT_ANCILLARY = new Set([
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'cICP',
  'mDCV',
  'cLLI',
  'bKGD',
  'hIST',
  'pHYs',
  'sPLT',
  'acTL',
  'fcTL',
  'fdAT',
  'oFFs',
  'pCAL',
  'sCAL',
  'sTER',
  'gIFg',
])

interface Chunk {
  type: string
  start: number
  end: number
  dataStart: number
  dataEnd: number
}

function readChunks(bytes: Uint8Array): {chunks: Chunk[]; end: number} {
  if (!startsWith(bytes, SIGNATURE)) throw new ImageStripError('not a PNG file (bad signature)')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Chunk[] = []
  let pos = SIGNATURE.length
  for (;;) {
    if (pos + 12 > bytes.length) throw new ImageStripError('PNG ends without an IEND chunk')
    const length = view.getUint32(pos)
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8))
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageStripError(`PNG chunk at ${pos} has an invalid type`)
    const end = pos + 12 + length
    if (end > bytes.length) throw new ImageStripError(`PNG chunk ${type} runs past the end of the file`)
    chunks.push({type, start: pos, end, dataStart: pos + 8, dataEnd: pos + 8 + length})
    pos = end
    if (type === 'IEND') return {chunks, end}
  }
}

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function keyword(data: Uint8Array): string {
  const nul = data.indexOf(0)
  const raw = data.subarray(0, nul === -1 ? Math.min(data.length, 79) : Math.min(nul, 79))
  return String.fromCharCode(...raw).replace(/[^\x20-\x7e]/g, '?')
}

export function analyzePng(bytes: Uint8Array): ImageAnalysis {
  const {chunks, end} = readChunks(bytes)
  if (chunks[0]?.type !== 'IHDR') throw new ImageStripError('PNG does not start with IHDR')
  const removed: RemovedItem[] = []
  const kept: Chunk[] = []
  let orientation: number | undefined
  let exifPosition: number | undefined
  let icc: Uint8Array | undefined

  for (const chunk of chunks) {
    const {type} = chunk
    const data = bytes.subarray(chunk.dataStart, chunk.dataEnd)
    const critical = type[0] === type[0].toUpperCase()
    if (critical || KEPT_ANCILLARY.has(type)) {
      if (type === 'iCCP') icc = data
      kept.push(chunk)
      continue
    }
    switch (type) {
      case 'eXIf': {
        const summary = summarizeExif(data)
        if (exifPosition === undefined) {
          orientation = summary.orientation
          exifPosition = kept.length
        }
        removed.push(
          summary.personal.length > 0
            ? {what: `EXIF: ${summary.personal.join(', ')}`, personal: true}
            : {what: 'EXIF (technical tags only)', personal: false},
        )
        break
      }
      case 'tEXt':
      case 'zTXt':
      case 'iTXt': {
        const name = keyword(data)
        removed.push({what: name === 'XML:com.adobe.xmp' ? 'XMP' : `text "${name}" (${type})`, personal: true})
        break
      }
      case 'tIME':
        removed.push({what: 'modification time (tIME)', personal: true})
        break
      case 'iDOT':
        removed.push({what: "Apple's decoding hint (iDOT)", personal: false})
        break
      case 'caBX':
        removed.push({what: 'C2PA manifest (caBX)', personal: true})
        break
      default:
        removed.push({what: `unknown chunk ${type}`, personal: true})
    }
  }

  if (end < bytes.length) {
    const trailing = bytes.subarray(end)
    removed.push({what: `${trailing.length} bytes after IEND`, personal: trailing.some((b) => b !== 0)})
  }

  return {
    format: 'png',
    removed,
    orientation,
    icc,
    imageData: kept.filter((c) => c.type !== 'iCCP').map((c) => bytes.subarray(c.start, c.end)),
    strip() {
      const parts: Uint8Array[] = [SIGNATURE]
      kept.forEach((chunk, index) => {
        if (index === exifPosition && orientation !== undefined) {
          parts.push(chunkBytes('eXIf', orientationExif(orientation)))
        }
        parts.push(bytes.subarray(chunk.start, chunk.end))
      })
      return concat(parts)
    },
  }
}
