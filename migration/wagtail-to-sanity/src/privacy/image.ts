/**
 * Strips personal metadata from an image with exiftool and proves that nothing else changed.
 *
 * exiftool deletes exactly the personal tags (src/privacy/rules.ts): whole groups for GPS, maker
 * notes and face/person regions, single tags otherwise. It rewrites only metadata segments and
 * chunks and never recompresses image data, so the pixels stay as they were. The orientation and
 * the ICC profile are not personal and are kept, like every other tag that is not personal.
 *
 * verifyStrippedImage proves it on the two files:
 * - the decoded pixels of every frame are identical, decoded by two independent decoders
 *   (ImageMagick's pixel signature and ffmpeg's frame hash where ffmpeg reads the format);
 * - embedded images (EXIF thumbnail, preview, MPF images such as an HDR gain map) are byte-identical;
 * - every tag that is not personal still has the same value, except pointers exiftool has to update
 *   when segments move (POINTER_TAGS); only personal tags (and composites derived from them) are gone;
 * - the orientation and the ICC profile are unchanged;
 * - a new scan finds no personal tag.
 */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'

import {runCommand} from '../video/ffmpeg'
import {scanFile, writeWithoutTags, type ExiftoolScan} from './exiftool'
import {classifyTag, findPersonalTags, parseTagKey, type Finding} from './rules'

/** XMP namespaces that only hold person or face regions; they are deleted as a whole. */
const REGION_NAMESPACES = new Set(['XMP-mwg-rs', 'XMP-MP', 'XMP-MPRI', 'XMP-MPReg'])

/** Tags whose value is a byte offset that changes when exiftool moves a segment. */
const POINTER_TAGS = new Set(['ThumbnailOffset', 'PreviewImageStart', 'MPImageStart', 'JpgFromRawStart', 'OtherImageStart'])

/** Tags exiftool sets itself when it rewrites XMP. */
const REWRITTEN_TAGS = new Set(['XMPToolkit'])

/** Groups that describe the file (size, dates, exiftool's own) and change with any rewrite. */
const FILE_GROUPS = new Set(['ExifTool', 'File', 'System'])

/** Embedded images and the ICC profile: binary data that must be copied byte for byte. */
const EMBEDDED_BINARY_TAG = /^(ThumbnailImage|PreviewImage|MPImage\d+|JpgFromRaw|OtherImage)$/

/**
 * The exiftool deletion arguments for these findings. Throws for a personal tag exiftool cannot
 * delete in place: one inside an embedded document (an MPF image or an embedded file).
 */
export function imageDeletionArgs(findings: readonly Finding[]): string[] {
  const args = new Set<string>()
  for (const finding of findings) {
    const tag = parseTagKey(finding.tag)
    if (!tag) throw new Error(`Unexpected tag key ${finding.tag}`)
    if (tag.family0 === 'Composite') continue // derived from other tags; goes with them
    if (tag.family3 !== 'Main') {
      throw new Error(`${finding.tag} is inside an embedded document (${tag.family3}); exiftool cannot delete it in place`)
    }
    if (tag.family0 === 'MakerNotes' || finding.category === 'maker-notes') args.add('-MakerNotes:all=')
    else if (tag.family1 === 'GPS') args.add('-GPS:all=')
    else if (REGION_NAMESPACES.has(tag.family1)) args.add(`-${tag.family1}:all=`)
    else args.add(`-${tag.family1}:${tag.name}=`)
  }
  return [...args].sort()
}

export interface PixelHashes {
  /** ImageMagick pixel signature (SHA-256 of the decoded pixels) of every frame. */
  magick: string[]
  /** sha256 over every decoded frame, from ffmpeg; null when ffmpeg cannot decode the format. */
  ffmpeg: string | null
}

/** Decoded-pixel hashes of an image with two decoders. */
export async function pixelHashes(file: string): Promise<PixelHashes> {
  const magick = await runCommand('magick', ['identify', '-format', '%#\\n', file])
  if (magick.code !== 0) throw new Error(`magick identify ${file} exited with ${magick.code ?? magick.signal}: ${magick.stderr.slice(-2000)}`)
  const signatures = magick.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (signatures.length === 0 || !signatures.every((s) => /^[0-9a-f]{64}$/.test(s))) {
    throw new Error(`magick identify printed no pixel signature for ${file}`)
  }
  const ffmpeg = await runCommand('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:v', '-f', 'hash', '-hash', 'sha256', '-'])
  const match = /^SHA256=([0-9a-f]{64})$/m.exec(ffmpeg.stdout)
  return {magick: signatures, ffmpeg: ffmpeg.code === 0 && !ffmpeg.stderr.trim() && match ? match[1]! : null}
}

/** sha256 of an embedded image's bytes (`exiftool -b`; read raw, since the bytes are binary). */
function embeddedBinaryHash(file: string, tag: string): Promise<string> {
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
  /** Embedded images compared byte for byte (tag name -> sha256). */
  embeddedImages: Record<string, string>
  /** Tags that are gone (keys only). */
  removedTags: string[]
  /** Pointer tags whose value changed. */
  movedPointers: string[]
  /** EXIF orientation (1-8), unchanged; null when the image has none. */
  orientation: number | null
  /** sha256 of the ICC profile, byte-identical before and after; null when the image has none. */
  iccProfileSha256: string | null
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

/** The numeric EXIF orientation (`exiftool -n`), or null. */
async function orientationOf(file: string): Promise<number | null> {
  const result = await runCommand('exiftool', ['-s3', '-n', '-EXIF:Orientation', '--', file])
  if (result.code !== 0) throw new Error(`exiftool -Orientation ${file} exited with ${result.code}`)
  const text = result.stdout.trim()
  return text === '' ? null : Number(text)
}

/**
 * Proves that `stripped` is `original` without its personal tags (see the top of this file).
 * Throws with every problem it finds.
 */
export async function verifyStrippedImage(original: string, stripped: string, deletions: readonly string[]): Promise<ImageVerification> {
  const problems: string[] = []
  const [before, after] = await Promise.all([scanFile(original), scanFile(stripped)])
  if (after.error) problems.push(`exiftool reports an error on the stripped file: ${after.error}`)

  const remaining = findPersonalTags(after.tags)
  if (remaining.length) problems.push(`personal tags remain: ${remaining.map((f) => f.tag).join(', ')}`)

  const deletedGroups = new Set(deletions.filter((d) => d.endsWith(':all=')).map((d) => d.slice(1, -':all='.length)))
  const removedTags: string[] = []
  const movedPointers: string[] = []
  for (const [key, value] of Object.entries(before.tags)) {
    if (isFileGroup(key)) continue
    const tag = parseTagKey(key)!
    const personal = classifyTag(key) !== null
    const inDeletedGroup = deletedGroups.has(tag.family0) || deletedGroups.has(tag.family1)
    if (!(key in after.tags)) {
      if (personal || inDeletedGroup || tag.family0 === 'Composite') removedTags.push(key)
      else problems.push(`${key} was removed although it is not personal`)
      continue
    }
    if (personal) continue // reported above as remaining
    if (JSON.stringify(after.tags[key]) === JSON.stringify(value)) continue
    if (POINTER_TAGS.has(tag.name)) movedPointers.push(key)
    else if (REWRITTEN_TAGS.has(tag.name) || tag.family0 === 'Composite') continue
    else problems.push(`${key} changed although it is not personal`)
  }
  for (const key of Object.keys(after.tags)) {
    if (isFileGroup(key) || key in before.tags) continue
    const tag = parseTagKey(key)!
    if (REWRITTEN_TAGS.has(tag.name)) continue
    problems.push(`${key} was added`)
  }

  const [orientation, orientationAfter] = await Promise.all([orientationOf(original), orientationOf(stripped)])
  if (orientationAfter !== orientation) problems.push(`the orientation changed from ${orientation} to ${orientationAfter}`)
  let iccProfileSha256: string | null = null
  if (hasMainTag(before, 'ProfileDescription') || hasMainTag(after, 'ProfileDescription')) {
    const [a, b] = await Promise.all([embeddedBinaryHash(original, 'ICC_Profile'), embeddedBinaryHash(stripped, 'ICC_Profile')])
    if (a !== b) problems.push('the ICC profile changed')
    iccProfileSha256 = a
  }

  const [pixelsBefore, pixelsAfter] = await Promise.all([pixelHashes(original), pixelHashes(stripped)])
  if (JSON.stringify(pixelsBefore.magick) !== JSON.stringify(pixelsAfter.magick)) problems.push('the decoded pixels differ (ImageMagick)')
  if (pixelsBefore.ffmpeg !== pixelsAfter.ffmpeg) problems.push('the decoded pixels differ (ffmpeg)')

  const embeddedImages: Record<string, string> = {}
  for (const key of Object.keys(before.tags)) {
    const tag = parseTagKey(key)
    if (!tag || tag.family3 !== 'Main' || !EMBEDDED_BINARY_TAG.test(tag.name) || tag.name in embeddedImages) continue
    const [a, b] = await Promise.all([embeddedBinaryHash(original, tag.name), embeddedBinaryHash(stripped, tag.name)])
    if (a !== b) problems.push(`the embedded ${tag.name} differs`)
    embeddedImages[tag.name] = a
  }

  if (problems.length) throw new Error(`${stripped} is not a lossless strip of ${original}:\n- ${problems.join('\n- ')}`)
  return {pixels: pixelsAfter, embeddedImages, removedTags: removedTags.sort(), movedPointers: movedPointers.sort(), orientation, iccProfileSha256}
}

/**
 * Writes `output` = `input` without the personal tags `findings`. Returns the deletion arguments and
 * the benign warnings exiftool printed.
 */
export async function stripImage(input: string, output: string, findings: readonly Finding[]): Promise<{deletions: string[]; warnings: string[]}> {
  const deletions = imageDeletionArgs(findings)
  const warnings = await writeWithoutTags(input, output, deletions)
  return {deletions, warnings}
}
