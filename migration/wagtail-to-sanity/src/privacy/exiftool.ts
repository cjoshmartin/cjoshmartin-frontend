/**
 * exiftool for the privacy step: reading every tag of a file (embedded documents and timed
 * metadata included) and removing tags from images without touching their pixels.
 *
 * Tag values stay in memory. Reports and state files only ever hold tag names, so no coordinate
 * or other personal value is written anywhere.
 */
import {runCommand} from '../video/ffmpeg'

/** Oldest exiftool these rules were checked with (the scan output format and the PNG/WebP writers). */
export const MIN_EXIFTOOL_VERSION = 13.0

export async function exiftoolVersion(): Promise<string> {
  const result = await runCommand('exiftool', ['-ver'])
  if (result.code !== 0) throw new Error(`exiftool -ver exited with ${result.code ?? result.signal}: ${result.stderr.slice(-2000)}`)
  const version = result.stdout.trim()
  if (!(Number.parseFloat(version) >= MIN_EXIFTOOL_VERSION)) {
    throw new Error(`exiftool ${version} is too old; the privacy step needs ${MIN_EXIFTOOL_VERSION} or newer`)
  }
  return version
}

/**
 * Arguments for reading every tag: all duplicates (-a), unknown tags too (-u), embedded documents
 * and timed metadata samples (-ee), keys "<family 0>:<family 1>:<family 3>:<name>" (-G0:1:3),
 * plain tag names (-s), JSON (-j). `-api largefilesupport=1` reads files over 2 GB.
 */
export const SCAN_ARGS: readonly string[] = ['-j', '-a', '-u', '-ee', '-G0:1:3', '-s', '-api', 'largefilesupport=1']

export interface ExiftoolScan {
  /** Every tag, keyed as above. */
  tags: Record<string, unknown>
  /** exiftool's file type ("JPEG", "PNG", "MOV", ...), or null when it does not know the format. */
  fileType: string | null
  /** exiftool's own error for the file (e.g. an unknown file type), or null. */
  error: string | null
}

/** Reads every tag of `file`. */
export async function scanFile(file: string): Promise<ExiftoolScan> {
  // `--` ends the options, so a file name can never be read as one.
  const result = await runCommand('exiftool', [...SCAN_ARGS, '--', file])
  // exiftool exits 1 when a file has an error (an unknown format); its JSON still says which.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`exiftool on ${file} exited with ${result.code ?? result.signal}: ${result.stderr.slice(-2000)}`)
  }
  let parsed: Record<string, unknown>[]
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>[]
  } catch {
    throw new Error(`exiftool printed no JSON for ${file} (exit ${result.code}): ${result.stderr.slice(-2000)}`)
  }
  if (parsed.length !== 1) throw new Error(`exiftool returned ${parsed.length} results for ${file}`)
  const tags = parsed[0]!
  const fileType = tags['File:File:Main:FileType']
  const error = tags['ExifTool:ExifTool:Main:Error']
  return {
    tags,
    fileType: typeof fileType === 'string' ? fileType : null,
    error: typeof error === 'string' ? error : null,
  }
}

/**
 * Warnings exiftool may print while writing that only describe a repair of the metadata structure
 * it rewrites anyway. Every tag value is compared after the write (src/privacy/image.ts), so such a
 * repair cannot change anything unnoticed. Any other warning fails the write.
 */
const BENIGN_WRITE_WARNINGS: readonly RegExp[] = [
  // Android screenshots store IFD0 entries out of tag order; exiftool writes them sorted.
  /^Warning: \[minor\] Entries in IFD\d+ were out of sequence\. Fixed\. - /,
]

/**
 * Writes `input` to `output` with the given tags deleted (`-TAG=` arguments), changing nothing else
 * exiftool does not have to (it never recompresses image data). Fails when exiftool reports an
 * error or a warning that is not in BENIGN_WRITE_WARNINGS, or when `output` already exists
 * (exiftool refuses to overwrite). Returns the benign warnings it printed.
 */
export async function writeWithoutTags(input: string, output: string, deletions: readonly string[]): Promise<string[]> {
  if (deletions.length === 0) throw new Error('writeWithoutTags: nothing to delete')
  for (const deletion of deletions) {
    if (!/^-[A-Za-z0-9-]+:[A-Za-z0-9-]+=$/.test(deletion)) throw new Error(`writeWithoutTags: unexpected argument ${deletion}`)
  }
  const result = await runCommand('exiftool', ['-q', '-o', output, ...deletions, '--', input])
  const messages = result.stderr.split('\n').map((line) => line.trim()).filter(Boolean)
  const unexpected = messages.filter((line) => !BENIGN_WRITE_WARNINGS.some((pattern) => pattern.test(line)))
  if (result.code !== 0 || unexpected.length) {
    throw new Error(`exiftool could not write ${output} (exit ${result.code ?? result.signal}): ${(result.stderr || result.stdout).slice(-2000)}`)
  }
  // The input path is in each message; keep only the warning itself.
  return messages.map((line) => line.replace(/ - .*$/, ''))
}
