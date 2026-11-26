/**
 * Image stripper used by the image-privacy Function: finds the personal metadata in an image and,
 * when there is any, builds a copy without it. Lossless: the coded image is never decoded or
 * re-encoded, only the metadata around it is removed, and the orientation and ICC profile are kept.
 * Pure (no I/O, no network, no dependencies); test/image-strip.test.ts proves with exiftool and
 * independent decoders that no personal tag remains and the decoded pixels are identical.
 *
 * Supported: JPEG, PNG/APNG, WebP, GIF, AVIF/HEIF, TIFF (not BigTIFF, not old-style JPEG-in-TIFF).
 * Everything else throws ImageStripError, which the Function records as a failure and the Studio
 * shows; the Studio's image fields only accept the formats in ACCEPTED_IMAGE_MIME_TYPES.
 */
import {createHash} from 'node:crypto'

import {bytesEqual, ImageStripError, startsWith} from './exif'
import {analyzeGif} from './gif'
import type {ImageAnalysis, ImageFormat, RemovedItem} from './image-format'
import {analyzeIsobmffImage} from './isobmff-image'
import {analyzeJpeg} from './jpeg'
import {analyzePng} from './png'
import {analyzeTiff} from './tiff'
import {analyzeWebp} from './webp'

export {ImageStripError} from './exif'
export type {ImageFormat, RemovedItem} from './image-format'

export const IMAGE_MIME_TYPES: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heif: 'image/heif',
  tiff: 'image/tiff',
}

/** The format from the file's first bytes (never from its name or MIME type). */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | 'svg' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (startsWith(bytes, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a')) return 'gif'
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) return 'webp'
  if (startsWith(bytes, 'II*\0') || startsWith(bytes, 'MM\0*') || startsWith(bytes, 'II+\0') || startsWith(bytes, 'MM\0+')) {
    return 'tiff'
  }
  if (startsWith(bytes, 'ftyp', 4)) {
    const brands = new TextDecoder('latin1').decode(bytes.subarray(8, Math.min(bytes.length, 64)))
    return /avif|avis/.test(brands) ? 'avif' : 'heif'
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head.replace(/^﻿/, ''))) {
    return 'svg'
  }
  return null
}

export function analyzeImage(bytes: Uint8Array): ImageAnalysis {
  const format = detectImageFormat(bytes)
  switch (format) {
    case 'jpeg':
      return analyzeJpeg(bytes)
    case 'png':
      return analyzePng(bytes)
    case 'webp':
      return analyzeWebp(bytes)
    case 'gif':
      return analyzeGif(bytes)
    case 'tiff':
      return analyzeTiff(bytes)
    case 'avif':
    case 'heif':
      return analyzeIsobmffImage(bytes)
    case 'svg':
      throw new ImageStripError(
        'SVG images are not supported: their metadata is free-form XML that cannot be removed with a guarantee that the drawing stays the same. Export the image as PNG.',
      )
    default:
      throw new ImageStripError('the file is not an image format that can be checked (JPEG, PNG, WebP, GIF, AVIF or TIFF)')
  }
}

function digest(parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(part.length))
    hash.update(length)
    hash.update(part)
  }
  return hash.digest('hex')
}

export interface ImageStripResult {
  format: ImageFormat
  /** Everything stripping removes or would remove. */
  removed: RemovedItem[]
  /** The personal items among them; empty means the image is left as it is. */
  personal: string[]
  /** The stripped file: only when `personal` is not empty. */
  output?: Uint8Array
  orientation: number | undefined
  /** sha256 over the coded image parts; the same for the input and the output. */
  imageDataSha256: string
}

/**
 * Checks `input` and strips it when it has personal metadata. The output is verified before it is
 * returned: same format, no personal metadata left, the same coded image parts (sha256), the same
 * orientation and ICC profile, and stripping it again changes nothing. Throws ImageStripError when
 * the file cannot be read or the check fails (never returns a file it could not verify).
 */
export function stripImage(input: Uint8Array): ImageStripResult {
  const analysis = analyzeImage(input)
  const personal = analysis.removed.filter((item) => item.personal).map((item) => item.what)
  const imageDataSha256 = digest(analysis.imageData)
  const base = {
    format: analysis.format,
    removed: analysis.removed,
    personal,
    orientation: analysis.orientation,
    imageDataSha256,
  }
  if (personal.length === 0) return base

  const output = analysis.strip()
  const again = analyzeImage(output)
  const problems: string[] = []
  if (again.format !== analysis.format) problems.push(`format changed to ${again.format}`)
  const left = again.removed.filter((item) => item.personal).map((item) => item.what)
  if (left.length > 0) problems.push(`personal metadata left: ${left.join('; ')}`)
  if (digest(again.imageData) !== imageDataSha256) problems.push('the coded image data changed')
  if (again.orientation !== analysis.orientation) {
    problems.push(`orientation changed from ${analysis.orientation ?? 1} to ${again.orientation ?? 1}`)
  }
  const iccBefore = analysis.icc ?? new Uint8Array(0)
  const iccAfter = again.icc ?? new Uint8Array(0)
  if (!bytesEqual(iccBefore, iccAfter)) problems.push('the ICC profile changed')
  if (!bytesEqual(again.strip(), output)) problems.push('stripping the result again changes it')
  if (problems.length > 0) {
    throw new ImageStripError(`the stripped ${analysis.format} failed its checks: ${problems.join('; ')}`)
  }
  return {...base, output}
}
