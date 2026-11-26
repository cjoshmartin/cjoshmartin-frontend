/**
 * Scans one local file for personal metadata (src/privacy/rules.ts): exiftool for every format it
 * reads (embedded documents and timed metadata included), the track list of videos, and the free
 * text header of STL models, which exiftool does not read.
 */
import {open, readFile, stat} from 'node:fs/promises'
import path from 'node:path'

import {runCommand} from '../video/ffmpeg'
import {scanFile} from './exiftool'
import {listTracks, looksLikeIsobmff} from './isobmff'
import {findDataTracks, findPersonalTags, findStlHeaderFindings, readStlHeader, type Finding, type StlHeader} from './rules'

export type FileKind = 'image' | 'video' | 'stl' | 'pdf' | 'other'

export interface FileScan {
  kind: FileKind
  /** exiftool's file type, e.g. "JPEG", "MOV"; null when exiftool does not know the format. */
  fileType: string | null
  /** Personal tags and data tracks found (tag names only, never values). */
  findings: Finding[]
  /** A reason the file could not be checked completely, or null. */
  unreadable: string | null
  /** Videos: every track (handler and sample entry). */
  tracks?: {index: number; id: number; handler: string; sampleEntry: string}[]
  /** STL models: the header. */
  stlHeader?: StlHeader
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

export async function scanLocalFile(file: string): Promise<FileScan> {
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
  if (mime.startsWith('image/')) return {kind: 'image', fileType: scan.fileType, findings, unreadable: null}
  if (mime === 'application/pdf') return {kind: 'pdf', fileType: scan.fileType, findings, unreadable: null}
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const head = await readHead(file, 16)
    if (looksLikeIsobmff(head)) {
      const tracks = listTracks(await readFile(file))
      return {kind: 'video', fileType: scan.fileType, findings: [...findings, ...findDataTracks(tracks)], unreadable: null, tracks}
    }
    return {kind: 'video', fileType: scan.fileType, findings: [...findings, ...(await nonMediaStreams(file))], unreadable: null}
  }
  return {kind: 'other', fileType: scan.fileType, findings, unreadable: null}
}
