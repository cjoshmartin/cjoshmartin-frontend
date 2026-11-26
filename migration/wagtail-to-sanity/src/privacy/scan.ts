/**
 * Scans one local file for personal metadata (src/privacy/rules.ts, version 2):
 *
 * - exiftool for every format it reads (embedded documents and timed metadata included), with the
 *   rules' categories;
 * - images: what the image-privacy Function's stripper (studio/functions/privacy/image-strip.ts)
 *   would remove as personal, so a migrated image counts as clean exactly when a new upload would;
 * - ISO BMFF / QuickTime videos: the track list, and the in-place stripper's own check
 *   (studio/functions/privacy/isobmff-video.ts, checkStrippedIsobmff): metadata boxes with content,
 *   data tracks, creation times, unused `mdat` bytes that are not zero (an iOS draft movie header
 *   holds the location there, invisible to exiftool and ffprobe) and location or device signatures
 *   anywhere outside the samples. An MP4 made by the video-to-mp4 converter is checked with the
 *   Function's own MP4 rule instead (only the converter's encoder name, zero times);
 * - the free text header of STL models, which exiftool does not read.
 */
import {open, readFile, stat} from 'node:fs/promises'
import path from 'node:path'

import {ImageStripError, stripImage} from '../../../../studio/functions/privacy/image-strip'
import {
  checkStrippedIsobmff,
  fileHandleReader,
  IsobmffUnsupportedError,
  listTracks,
  looksLikeIsobmff,
  planIsobmffStrip,
} from '../../../../studio/functions/privacy/isobmff-video'
import {checkIsobmffBoxes} from '../../../../studio/functions/privacy/video-strip'
import {runCommand} from '../video/ffmpeg'
import {scanFile} from './exiftool'
import {findDataTracks, findPersonalTags, findStlHeaderFindings, readStlHeader, type Finding, type StlHeader} from './rules'

export type FileKind = 'image' | 'video' | 'stl' | 'pdf' | 'other'

export interface FileScan {
  kind: FileKind
  /** exiftool's file type, e.g. "JPEG", "MOV"; null when exiftool does not know the format. */
  fileType: string | null
  /** Personal tags, data tracks and other personal metadata found (names only, never values). */
  findings: Finding[]
  /** A reason the file could not be checked completely, or null. */
  unreadable: string | null
  /** Videos: every track (handler and sample entry). */
  tracks?: {index: number; id: number; handler: string; sampleEntry: string}[]
  /** STL models: the header. */
  stlHeader?: StlHeader
}

export interface ScanOptions {
  /**
   * The file is an MP4 made by the video-to-mp4 converter (asset source "video-to-mp4"): checked
   * with the converter's MP4 rule (checkIsobmffBoxes with its encoder name allowed).
   */
  convertedMp4?: boolean
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const {bytesRead} = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Streams that are neither video nor audio, from ffprobe (for containers that are not ISO BMFF). */
async function nonMediaStreams(file: string): Promise<Finding[]> {
  const result = await runCommand('ffprobe', ['-hide_banner', '-v', 'error', '-show_entries', 'stream=index,codec_type,codec_tag_string', '-of', 'json', file])
  if (result.code !== 0) throw new Error(`ffprobe ${file} exited with ${result.code}: ${result.stderr.slice(-2000)}`)
  const streams = (JSON.parse(result.stdout) as {streams?: {index: number; codec_type?: string; codec_tag_string?: string}[]}).streams ?? []
  return streams
    .filter((s) => s.codec_type !== 'video' && s.codec_type !== 'audio')
    .map((s) => ({tag: `Stream${s.index}:${s.codec_type ?? 'unknown'}/${s.codec_tag_string ?? '?'}`, category: 'data-track' as const}))
}

/** `metadata` findings: what the image-privacy Function's stripper would remove as personal. */
export function imageStripFindings(bytes: Uint8Array): Finding[] {
  return stripImage(bytes).personal.map((what) => ({tag: `ImageStrip:${what}`, category: 'metadata' as const}))
}

/** `metadata` findings of an ISO BMFF video, and its tracks. */
async function isobmffFindings(file: string, options: ScanOptions): Promise<{findings: Finding[]; tracks: FileScan['tracks']}> {
  const handle = await open(file, 'r')
  try {
    const reader = await fileHandleReader(handle)
    const tracks = await listTracks(reader)
    const problems: string[] = []
    if (options.convertedMp4) {
      problems.push(...(await checkIsobmffBoxes(file, {allowEncoderTag: true})))
      const plan = await planIsobmffStrip(reader)
      if (plan.unreferenced.nonZeroBytes > 0) problems.push(`${plan.unreferenced.nonZeroBytes} non-zero mdat bytes no track uses`)
    } else {
      problems.push(...(await checkStrippedIsobmff(reader)))
    }
    return {findings: problems.map((problem) => ({tag: `Container:${problem}`, category: 'metadata' as const})), tracks}
  } finally {
    await handle.close()
  }
}

export async function scanLocalFile(file: string, options: ScanOptions = {}): Promise<FileScan> {
  const scan = await scanFile(file)
  const mimeType = scan.tags['File:File:Main:MIMEType'] ?? scan.tags['File:Main:MIMEType']
  const mime = typeof mimeType === 'string' ? mimeType : ''
  const findings = findPersonalTags(scan.tags)

  if (path.extname(file).toLowerCase() === '.stl' && scan.fileType === null) {
    const {size} = await stat(file)
    const stlHeader = readStlHeader(await readHead(file, 256), size)
    return {kind: 'stl', fileType: null, findings: findStlHeaderFindings(stlHeader), unreadable: null, stlHeader}
  }
  if (scan.error) return {kind: 'other', fileType: scan.fileType, findings, unreadable: `exiftool: ${scan.error}`}
  if (mime.startsWith('image/')) {
    try {
      return {kind: 'image', fileType: scan.fileType, findings: [...findings, ...imageStripFindings(await readFile(file))], unreadable: null}
    } catch (error) {
      if (error instanceof ImageStripError) return {kind: 'image', fileType: scan.fileType, findings, unreadable: `image stripper: ${error.message}`}
      throw error
    }
  }
  if (mime === 'application/pdf') return {kind: 'pdf', fileType: scan.fileType, findings, unreadable: null}
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const head = await readHead(file, 16)
    if (looksLikeIsobmff(head)) {
      try {
        const container = await isobmffFindings(file, options)
        return {
          kind: 'video',
          fileType: scan.fileType,
          findings: [...findings, ...findDataTracks(container.tracks ?? []), ...container.findings],
          unreadable: null,
          tracks: container.tracks,
        }
      } catch (error) {
        if (error instanceof IsobmffUnsupportedError) return {kind: 'video', fileType: scan.fileType, findings, unreadable: `ISO BMFF: ${error.message}`}
        throw error
      }
    }
    return {kind: 'video', fileType: scan.fileType, findings: [...findings, ...(await nonMediaStreams(file))], unreadable: null}
  }
  return {kind: 'other', fileType: scan.fileType, findings, unreadable: null}
}
