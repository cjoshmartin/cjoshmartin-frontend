/**
 * Strips personal metadata from an image with the image-privacy Function's own stripper
 * (studio/functions/privacy/image-strip.ts), so a migrated image ends up exactly as a new upload
 * would: only the orientation, the ICC profile and the technical data a decoder needs are kept,
 * and the coded image is copied byte for byte. The stripper checks its own result (same coded
 * image, orientation and ICC profile, nothing personal left, idempotent).
 *
 * verifyStrippedImage proves it again on the two files, with other tools:
 * - the decoded pixels of every frame are identical, decoded by two independent decoders
 *   (ImageMagick's pixel signature and ffmpeg's frame hash where ffmpeg reads the format);
 * - the orientation and the ICC profile are unchanged (exiftool);
 * - every tag left has the value it had before: nothing was added or changed, only removed;
 * - a new scan (src/privacy/scan.ts: exiftool rules and the stripper's own analysis) finds nothing
 *   personal.
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {open, readFile, writeFile} from 'node:fs/promises'

import {IMAGE_STRIP_VERSION} from '../../../../studio/functions/privacy/constants'
import {stripImage as stripImageBytes} from '../../../../studio/functions/privacy/image-strip'
import {runCommand} from '../video/ffmpeg'
import {scanFile, type ExiftoolScan} from './exiftool'
import {parseTagKey} from './rules'
import {scanLocalFile} from './scan'

/** Groups that describe the file (size, dates, exiftool's own) and change with any rewrite. */
const FILE_GROUPS = new Set(['ExifTool', 'File', 'System'])

export interface PixelHashes {
  /** ImageMagick pixel signature (SHA-256 of the decoded pixels) of every frame. */
  magick: string[]
  /** sha256 over every decoded frame, from ffmpeg; null when ffmpeg cannot decode the format. */
  ffmpeg: string | null
}

/** Whether the file starts like a JPEG (SOI and a marker). */
async function isJpeg(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(3)
    const {bytesRead} = await handle.read(head, 0, 3, 0)
    return bytesRead === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  } finally {
    await handle.close()
  }
}

/**
 * Decoded-pixel hashes of an image with two decoders.
 *
 * A JPEG is decoded by ffmpeg with the plain JPEG demuxer, first frame only: the primary image.
 * ffmpeg 9.1's file demuxer reads a JPEG's MPF index (HDR gain maps of iPhone photos) and then
 * cuts the primary image's data short ("overread 8"), so the last row of blocks decodes wrong for
 * the original but not for a copy without the gain map. ffmpeg 9.0.1 and ImageMagick decode both
 * the same, and so does 9.1 this way.
 */
export async function pixelHashes(file: string): Promise<PixelHashes> {
  const magick = await runCommand('magick', ['identify', '-format', '%#\\n', file])
  if (magick.code !== 0) throw new Error(`magick identify ${file} exited with ${magick.code ?? magick.signal}: ${magick.stderr.slice(-2000)}`)
  const signatures = magick.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (signatures.length === 0 || !signatures.every((s) => /^[0-9a-f]{64}$/.test(s))) {
    throw new Error(`magick identify printed no pixel signature for ${file}`)
  }
  const input = (await isJpeg(file)) ? ['-f', 'jpeg_pipe', '-i', file, '-map', '0:v', '-frames:v', '1'] : ['-i', file, '-map', '0:v']
  const ffmpeg = await runCommand('ffmpeg', ['-hide_banner', '-v', 'error', ...input, '-f', 'hash', '-hash', 'sha256', '-'])
  const match = /^SHA256=([0-9a-f]{64})$/m.exec(ffmpeg.stdout)
  return {magick: signatures, ffmpeg: ffmpeg.code === 0 && !ffmpeg.stderr.trim() && match ? match[1]! : null}
}

/** sha256 of a binary tag's bytes (`exiftool -b`; read raw, since the bytes are binary). */
function binaryTagHash(file: string, tag: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('exiftool', ['-b', `-${tag}`, '--', file], {stdio: ['ignore', 'pipe', 'pipe']})
    const hash = createHash('sha256')
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(hash.digest('hex'))
      else reject(new Error(`exiftool -b -${tag} ${file} exited with ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`))
    })
  })
}

export interface ImageVerification {
  pixels: PixelHashes
  /** Tags that are gone (keys only). */
  removedTags: string[]
  /** The original's orientation tag (2-8 rotate or mirror; unchanged in effect); null when it has none. */
  orientation: number | null
  /** sha256 of the ICC profile, byte-identical before and after; null when the image has none. */
  iccProfileSha256: string | null
}

/**
 * WebP's VP8X header flags which chunks follow; removing the EXIF and XMP chunks must clear their
 * flags. Any other flag (ICC profile, alpha, animation) must stay as it was.
 */
function onlyMetadataFlagsCleared(before: unknown, after: unknown): boolean {
  const flags = (value: unknown) => new Set(String(value).split(',').map((f) => f.trim()).filter(Boolean))
  const a = flags(before)
  const b = flags(after)
  return [...b].every((f) => a.has(f)) && [...a].filter((f) => !b.has(f)).every((f) => f === 'EXIF' || f === 'XMP')
}

function isFileGroup(key: string): boolean {
  const tag = parseTagKey(key)
  return !tag || FILE_GROUPS.has(tag.family0)
}

/** Whether the main document has a tag with this name. */
function hasMainTag(scan: ExiftoolScan, name: string): boolean {
  return Object.keys(scan.tags).some((key) => {
    const tag = parseTagKey(key)
    return tag !== null && tag.family3 === 'Main' && tag.name === name
  })
}

/** The numeric orientation (`exiftool -n`; EXIF, or the HEIF/AVIF rotation and mirroring), or null. */
async function orientationOf(file: string): Promise<number | null> {
  const result = await runCommand('exiftool', ['-s3', '-n', '-Orientation', '--', file])
  if (result.code !== 0) throw new Error(`exiftool -Orientation ${file} exited with ${result.code}`)
  const text = result.stdout.trim()
  return text === '' ? null : Number(text)
}

/**
 * Proves that `stripped` is `original` without its personal metadata (see the top of this file).
 * Throws with every problem it finds.
 */
export async function verifyStrippedImage(original: string, stripped: string): Promise<ImageVerification> {
  const problems: string[] = []
  const [before, after] = await Promise.all([scanFile(original), scanFile(stripped)])
  if (after.error) problems.push(`exiftool reports an error on the stripped file: ${after.error}`)

  const scan = await scanLocalFile(stripped)
  if (scan.unreadable) problems.push(`the stripped file cannot be checked: ${scan.unreadable}`)
  if (scan.findings.length) problems.push(`personal metadata remains: ${scan.findings.map((f) => f.tag).join(', ')}`)

  const removedTags: string[] = []
  for (const key of Object.keys(before.tags)) {
    if (isFileGroup(key)) continue
    if (!(key in after.tags)) removedTags.push(key)
  }
  for (const [key, value] of Object.entries(after.tags)) {
    if (isFileGroup(key)) continue
    const tag = parseTagKey(key)!
    if (!(key in before.tags)) {
      // Composite tags are computed from others (for example from the rewritten EXIF block).
      if (tag.family0 !== 'Composite') problems.push(`${key} was added`)
      continue
    }
    if (tag.family0 === 'Composite') continue
    if (JSON.stringify(before.tags[key]) === JSON.stringify(value)) continue
    if (tag.name === 'WebP_Flags' && onlyMetadataFlagsCleared(before.tags[key], value)) continue
    problems.push(`${key} changed`)
  }

  // Only 2-8 rotate or mirror: no tag, 1 and invalid values (Android writes 0) all show the image as
  // stored, and the stripper does not write a tag that only says "not rotated".
  const effective = (value: number | null) => (value !== null && value >= 2 && value <= 8 ? value : 1)
  const [orientation, orientationAfter] = await Promise.all([orientationOf(original), orientationOf(stripped)])
  if (effective(orientationAfter) !== effective(orientation)) problems.push(`the orientation changed from ${orientation ?? 'none'} to ${orientationAfter ?? 'none'}`)
  let iccProfileSha256: string | null = null
  if (hasMainTag(before, 'ProfileDescription') || hasMainTag(after, 'ProfileDescription')) {
    const [a, b] = await Promise.all([binaryTagHash(original, 'ICC_Profile'), binaryTagHash(stripped, 'ICC_Profile')])
    if (a !== b) problems.push('the ICC profile changed')
    iccProfileSha256 = a
  }

  const [pixelsBefore, pixelsAfter] = await Promise.all([pixelHashes(original), pixelHashes(stripped)])
  if (JSON.stringify(pixelsBefore.magick) !== JSON.stringify(pixelsAfter.magick)) problems.push('the decoded pixels differ (ImageMagick)')
  if (pixelsBefore.ffmpeg !== pixelsAfter.ffmpeg) problems.push('the decoded pixels differ (ffmpeg)')

  if (problems.length) throw new Error(`${stripped} is not a lossless strip of ${original}:\n- ${problems.join('\n- ')}`)
  return {pixels: pixelsAfter, removedTags: removedTags.sort(), orientation, iccProfileSha256}
}

export interface ImageStripMethod {
  tool: 'image-strip'
  /** IMAGE_STRIP_VERSION of the Functions' stripper that made the copy. */
  version: string
  /** What the stripper removed (its item names, never values). */
  removed: string[]
}

/**
 * Writes `output` = `input` without its personal metadata (the image-privacy Function's stripper).
 * Throws when the image has nothing to remove: such an image is not copied.
 */
export async function stripImage(input: string, output: string): Promise<ImageStripMethod> {
  const result = stripImageBytes(await readFile(input))
  if (!result.output) throw new Error(`${input} has no personal metadata the image stripper removes`)
  await writeFile(output, result.output, {flag: 'wx'})
  return {tool: 'image-strip', version: IMAGE_STRIP_VERSION, removed: result.personal}
}
