/**
 * GIF: removes comment extensions, unknown extensions, anything after the trailer and every
 * application extension except three that are kept: looping (NETSCAPE2.0, ANIMEXTS1.0) and the ICC
 * profile (ICCRGBG1). So XMP and ImageMagick's IPTC/8BIM blocks go. Keeps the header, colour tables,
 * graphic control and plain text extensions and every image's data byte for byte. GIF has no
 * orientation.
 */
import {concat, ImageStripError, startsWith} from './exif'
import type {ImageAnalysis, RemovedItem} from './image-format'

const KEPT_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1'])

interface Block {
  kind: 'header' | 'image' | 'extension' | 'trailer'
  start: number
  end: number
  label?: number
  application?: string
}

/** End of a run of data sub-blocks starting at `pos` (after the 0 terminator). */
function subBlocksEnd(bytes: Uint8Array, pos: number): number {
  let p = pos
  for (;;) {
    if (p >= bytes.length) throw new ImageStripError('GIF data sub-blocks are truncated')
    const size = bytes[p]
    p += 1
    if (size === 0) return p
    p += size
  }
}

/** Concatenated payload of the sub-blocks starting at `pos`. */
function subBlocksData(bytes: Uint8Array, pos: number): Uint8Array {
  const parts: Uint8Array[] = []
  let p = pos
  for (;;) {
    const size = bytes[p]
    if (size === 0) return concat(parts)
    parts.push(bytes.subarray(p + 1, p + 1 + size))
    p += 1 + size
  }
}

export function analyzeGif(bytes: Uint8Array): ImageAnalysis {
  if (!startsWith(bytes, 'GIF87a') && !startsWith(bytes, 'GIF89a')) throw new ImageStripError('not a GIF file')
  if (bytes.length < 13) throw new ImageStripError('GIF header is truncated')
  const blocks: Block[] = []
  const packed = bytes[10]
  let pos = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0)
  if (pos > bytes.length) throw new ImageStripError('GIF global colour table is truncated')
  blocks.push({kind: 'header', start: 0, end: pos})
  let trailerEnd: number | undefined
  while (trailerEnd === undefined) {
    if (pos >= bytes.length) throw new ImageStripError('GIF ends without a trailer')
    const introducer = bytes[pos]
    if (introducer === 0x3b) {
      blocks.push({kind: 'trailer', start: pos, end: pos + 1})
      trailerEnd = pos + 1
    } else if (introducer === 0x2c) {
      if (pos + 10 > bytes.length) throw new ImageStripError('GIF image descriptor is truncated')
      const local = bytes[pos + 9]
      let p = pos + 10 + (local & 0x80 ? 3 * 2 ** ((local & 0x07) + 1) : 0)
      p += 1 // LZW minimum code size
      const end = subBlocksEnd(bytes, p)
      blocks.push({kind: 'image', start: pos, end})
      pos = end
    } else if (introducer === 0x21) {
      if (pos + 2 > bytes.length) throw new ImageStripError('GIF extension is truncated')
      const label = bytes[pos + 1]
      const end = subBlocksEnd(bytes, pos + 2)
      let application: string | undefined
      if (label === 0xff) {
        if (bytes[pos + 2] !== 11) throw new ImageStripError('GIF application extension has no 11-byte identifier')
        application = String.fromCharCode(...bytes.subarray(pos + 3, pos + 14))
      }
      blocks.push({kind: 'extension', start: pos, end, label, application})
      pos = end
    } else {
      throw new ImageStripError(`GIF has an unknown block 0x${introducer.toString(16)} at byte ${pos}`)
    }
  }

  const removed: RemovedItem[] = []
  const kept: Block[] = []
  let icc: Uint8Array | undefined
  for (const block of blocks) {
    if (block.kind !== 'extension') {
      kept.push(block)
      continue
    }
    if (block.label === 0xf9 || block.label === 0x01) {
      kept.push(block) // graphic control (frame timing, transparency), plain text (drawn text)
    } else if (block.label === 0xff && block.application && KEPT_APPLICATIONS.has(block.application)) {
      if (block.application === 'ICCRGBG1') icc = subBlocksData(bytes, block.start + 14)
      kept.push(block)
    } else if (block.label === 0xfe) {
      removed.push({what: 'comment extension', personal: true})
    } else if (block.label === 0xff) {
      const app = (block.application ?? '').replace(/[^\x20-\x7e]/g, '?')
      removed.push({what: app.startsWith('XMP Data') ? 'XMP' : `application extension "${app}"`, personal: true})
    } else {
      removed.push({what: `extension 0x${(block.label ?? 0).toString(16)}`, personal: true})
    }
  }
  if (trailerEnd < bytes.length) {
    const trailing = bytes.subarray(trailerEnd)
    removed.push({what: `${trailing.length} bytes after the trailer`, personal: trailing.some((b) => b !== 0)})
  }

  return {
    format: 'gif',
    removed,
    orientation: undefined,
    icc,
    imageData: kept
      .filter((b) => b.application !== 'ICCRGBG1')
      .map((b) => bytes.subarray(b.start, b.end)),
    strip() {
      return concat(kept.map((b) => bytes.subarray(b.start, b.end)))
    },
  }
}
