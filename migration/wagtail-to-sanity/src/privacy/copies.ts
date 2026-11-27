/**
 * Local copies without personal metadata, made once and shared by both datasets
 * (privacy/stripped/<sha1 of the original>/<file name>), and the privacy map that lists them
 * (privacy/privacy-map.json).
 *
 * The map is the record the assets and videos steps upload from: a bucket file with personal
 * metadata is never uploaded, its stripped copy is. Asset ids are content hashes, so the same copy
 * gives the same asset id in every dataset.
 *
 * The copies are made with the Functions' own strippers (studio/functions/privacy), so a migrated
 * asset is stripped exactly like a new upload. Every copy is verified whenever it is used: images by
 * their decoded pixels (two decoders), ICC profile, orientation and every tag left
 * (src/privacy/image.ts); videos by every packet of every kept stream, their stream descriptions
 * and every byte outside the changed ranges (src/privacy/video.ts). Both scan the copy again and
 * must find nothing personal.
 */
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {IMAGE_STRIP_VERSION, VIDEO_STRIP_VERSION} from '../../../../studio/functions/privacy/constants'

import type {DataPaths} from '../config'
import {hashFile, readJson, writeJson} from '../util'
import {runCommand, toolVersion} from '../video/ffmpeg'
import {exiftoolVersion} from './exiftool'
import {stripImage, verifyStrippedImage, type ImageStripMethod, type ImageVerification} from './image'
import {PRIVACY_RULES_VERSION, type Finding} from './rules'
import type {FileKind} from './scan'
import {stripVideo, verifyStrippedVideo, type VideoStripMethod, type VideoVerification} from './video'

export interface StrippedCopy {
  originalSha1: string
  originalFilename: string
  kind: 'image' | 'video'
  /** Relative to the privacy folder: stripped/<original sha1>/<original file name>. */
  file: string
  sha1: string
  size: number
  /** The personal tags (names only) the original had. */
  findings: Finding[]
  /** Short names of what was removed, for the asset's `privacy.removed`. */
  removed: string[]
  method: ImageStripMethod | VideoStripMethod
  verification: ImageVerification | VideoVerification
  strippedAt: string
  verifiedAt: string
}

export interface BucketFileScan {
  sha1: string
  kind: FileKind
  findings: Finding[]
}

export interface PrivacyMap {
  rulesVersion: string
  /** STRIPPERS of the run that made the copies; another value makes every copy again. */
  strippers?: Strippers
  tools: Tools
  updatedAt: string
  /** Every bucket content file (path relative to gcs/) and what the scan found in it. */
  bucket: Record<string, BucketFileScan>
  /** Original sha1 -> its stripped copy. */
  copies: Record<string, StrippedCopy>
}

export interface Tools {
  exiftool: string
  ffprobe: string
  magick: string
}

/** The Functions' strippers the copies are made with, and a fingerprint of their code. */
export interface Strippers {
  imageStripVersion: string
  videoStripVersion: string
  /** sha256 over the stripper source files (STRIPPER_SOURCES), so any change to them is noticed. */
  sourceSha256: string
}

/** The source files of the strippers (studio/functions/privacy), relative to that folder. */
export const STRIPPER_SOURCES = [
  'constants.ts', 'exif.ts', 'gif.ts', 'image-format.ts', 'image-strip.ts', 'isobmff-image.ts',
  'isobmff-video.ts', 'jpeg.ts', 'png.ts', 'tiff.ts', 'webp.ts',
] as const

export function stripperVersions(): Strippers {
  const dir = fileURLToPath(new URL('../../../../studio/functions/privacy/', import.meta.url))
  const hash = createHash('sha256')
  for (const file of STRIPPER_SOURCES) {
    hash.update(`${file}\0`)
    hash.update(readFileSync(path.join(dir, file)))
  }
  return {imageStripVersion: IMAGE_STRIP_VERSION, videoStripVersion: VIDEO_STRIP_VERSION, sourceSha256: hash.digest('hex')}
}

export async function toolVersions(): Promise<Tools> {
  const magick = await runCommand('magick', ['-version'])
  if (magick.code !== 0) throw new Error(`magick -version exited with ${magick.code}`)
  return {
    exiftool: await exiftoolVersion(),
    ffprobe: await toolVersion('ffprobe'),
    magick: magick.stdout.split('\n')[0]?.trim() ?? '',
  }
}

export function privacyMapPath(paths: DataPaths): string {
  return path.join(paths.privacy, 'privacy-map.json')
}

export function readPrivacyMap(paths: DataPaths): PrivacyMap | null {
  const file = privacyMapPath(paths)
  return existsSync(file) ? readJson<PrivacyMap>(file) : null
}

export function writePrivacyMap(paths: DataPaths, map: PrivacyMap): void {
  const sortKeys = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  writeJson(privacyMapPath(paths), {...map, bucket: sortKeys(map.bucket), copies: sortKeys(map.copies)})
}

/**
 * The privacy map, required to be current: it exists, uses the current rules and covers every
 * given bucket file with the same sha1. The assets and videos steps call this before uploading, so
 * a file nobody checked is never uploaded.
 */
export function requirePrivacyMap(paths: DataPaths, files: readonly {path: string; sha1: string}[]): PrivacyMap {
  const map = readPrivacyMap(paths)
  if (!map) throw new Error(`${privacyMapPath(paths)} does not exist; run the privacy step first (--steps privacy)`)
  if (map.rulesVersion !== PRIVACY_RULES_VERSION) {
    throw new Error(`${privacyMapPath(paths)} was made with rules ${map.rulesVersion}, the current rules are ${PRIVACY_RULES_VERSION}; run the privacy step again`)
  }
  if (map.strippers?.sourceSha256 !== stripperVersions().sourceSha256) {
    throw new Error(`${privacyMapPath(paths)} was made with other stripper code (studio/functions/privacy); run the privacy step again`)
  }
  const stale = files.filter((f) => map.bucket[f.path]?.sha1 !== f.sha1).map((f) => f.path)
  if (stale.length) throw new Error(`The privacy map does not cover ${stale.length} bucket files with their current bytes (${stale.slice(0, 5).join(', ')}); run the privacy step again`)
  for (const entry of Object.values(map.bucket)) {
    if (entry.findings.length && !map.copies[entry.sha1]) throw new Error(`The privacy map lists personal metadata in a file with sha1 ${entry.sha1} but no stripped copy; run the privacy step again`)
  }
  return map
}

/** Where a planned upload's bytes come from when they are a stripped copy. */
export interface StrippedSource {
  /** sha1 of the bucket file the copy was made from. */
  originalSha1: string
  /** The copy, relative to the privacy folder. */
  file: string
}

/**
 * A planned upload of the bucket file with sha1 `sha1`, switched to its stripped copy when the file
 * has personal metadata: the upload then has the copy's sha1 and bytes, and its `source` has no
 * `url`. The bucket URL is where the unstripped original is, and asset documents are public, so a
 * copy never links to it.
 */
export function withStrippedCopy<T extends {sha1: string; source?: {name: string; id: string; url?: string}}>(
  planned: T,
  map: PrivacyMap,
): T & {strippedCopy?: StrippedSource} {
  const copy = map.copies[planned.sha1]
  if (!copy) return planned
  return {
    ...planned,
    ...(planned.source ? {source: withoutUrl(planned.source)} : {}),
    sha1: copy.sha1,
    strippedCopy: {originalSha1: copy.originalSha1, file: copy.file},
  }
}

/** A `source` without its `url` (the location of the unstripped original). */
export function withoutUrl<S extends {url?: string}>(source: S): Omit<S, 'url'> {
  const {url: _url, ...rest} = source
  return rest
}

/** The copy a planned upload uses, from the map (throws when the map no longer lists it). */
export function copyFor(map: PrivacyMap, source: StrippedSource): StrippedCopy {
  const copy = map.copies[source.originalSha1]
  if (!copy || copy.file !== source.file) throw new Error(`The privacy map has no copy ${source.file} of ${source.originalSha1}`)
  return copy
}

/** Absolute path of a copy's file. */
export function copyPath(paths: DataPaths, copy: StrippedCopy): string {
  return path.join(paths.privacy, copy.file)
}

/** What was removed, as short names: the image stripper's items, or the removed boxes and data. */
export function removedNames(method: StrippedCopy['method']): string[] {
  if (method.tool === 'image-strip') return [...method.removed]
  return method.removals.map((r) => r.what)
}

/**
 * The verified stripped copy of `original` (whose bytes have `originalSha1`): reused when the map
 * has one whose file still has the recorded sha1, otherwise made now. Either way it is verified
 * again before it is returned.
 */
export async function ensureStrippedCopy(
  paths: DataPaths,
  map: PrivacyMap,
  original: {file: string; sha1: string; filename: string; kind: FileKind; findings: Finding[]},
): Promise<StrippedCopy> {
  if (original.kind !== 'image' && original.kind !== 'video') {
    throw new Error(
      `${original.filename} (sha1 ${original.sha1}) is a ${original.kind} file with personal metadata ` +
        `(${original.findings.map((f) => f.tag).join(', ')}); the privacy step strips only images and ISO BMFF/QuickTime videos. ` +
        'Remove the metadata from the file by hand, replace the asset, and run the step again.',
    )
  }
  const now = new Date().toISOString()
  const recorded = map.copies[original.sha1]
  if (recorded && existsSync(copyPath(paths, recorded)) && (await hashFile(copyPath(paths, recorded), 'sha1')) === recorded.sha1) {
    const verification = recorded.method.tool === 'image-strip'
      ? await verifyStrippedImage(original.file, copyPath(paths, recorded))
      : await verifyStrippedVideo(original.file, copyPath(paths, recorded), recorded.method.changedRanges)
    const copy: StrippedCopy = {...recorded, verification, verifiedAt: now}
    map.copies[original.sha1] = copy
    return copy
  }

  const relative = path.join('stripped', original.sha1, original.filename)
  const output = path.join(paths.privacy, relative)
  rmSync(path.dirname(output), {recursive: true, force: true})
  mkdirSync(path.dirname(output), {recursive: true, mode: 0o700})
  let method: StrippedCopy['method']
  let verification: StrippedCopy['verification']
  if (original.kind === 'image') {
    method = await stripImage(original.file, output)
    verification = await verifyStrippedImage(original.file, output)
  } else {
    method = await stripVideo(original.file, output)
    verification = await verifyStrippedVideo(original.file, output, method.changedRanges)
  }
  const sha1 = await hashFile(output, 'sha1')
  if (recorded && recorded.sha1 !== sha1) {
    throw new Error(
      `Stripping ${original.filename} again gave sha1 ${sha1}, the map recorded ${recorded.sha1}. The copies must be ` +
        'deterministic (both datasets and every rerun use the same asset id); check the stripper versions.',
    )
  }
  const copy: StrippedCopy = {
    originalSha1: original.sha1,
    originalFilename: original.filename,
    kind: original.kind,
    file: relative,
    sha1,
    size: statSync(output).size,
    findings: original.findings,
    removed: removedNames(method),
    method,
    verification,
    strippedAt: recorded?.strippedAt ?? now,
    verifiedAt: now,
  }
  map.copies[original.sha1] = copy
  return copy
}
