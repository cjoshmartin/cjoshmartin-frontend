/**
 * Local tools for the media tests (`npm run test:media`): exiftool 13, ImageMagick 7 and ffmpeg /
 * ffprobe 7 or newer must be on PATH. They make the fixtures (with GPS, camera and author tags) and
 * check the results independently of the strippers' own checks.
 */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

export function tool(command: string, args: string[], input?: Buffer): Buffer {
  return execFileSync(command, args, {input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']})
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Every tag exiftool finds (`-ee -a -G1`), including embedded and duplicate ones, by "Group:Tag". */
export function exiftoolTags(file: string): Record<string, unknown> {
  const out = tool('exiftool', ['-q', '-q', '-ee', '-a', '-G1', '-n', '-j', file]).toString('utf8')
  return (JSON.parse(out) as Record<string, unknown>[])[0]
}

/** Tag groups that only describe the file, the decoder's view of the image or its ICC profile. */
const NEUTRAL_GROUPS = new Set([
  'ExifTool',
  'System',
  'File',
  'Composite',
  'JFIF',
  'ICC-header',
  'ICC_Profile',
  'ICC-meas',
  'ICC-view',
  'ICC-chrm',
  'PNG',
  'PNG-pHYs',
  'PNG-sRGB',
  'PNG-gAMA',
  'PNG-cHRM',
  'PNG-iCCP',
  'APNG',
  'RIFF',
  'GIF',
  'QuickTime',
  'Meta',
  'Adobe',
  'Track1',
  'Track2',
  'Track3',
  'Track4',
  'Track5',
  'Track6',
  'Matroska',
  'Info',
])

/** Neutral tags allowed in other groups. */
const NEUTRAL_TAGS = new Set(['IFD0:Orientation'])

/** The tags that make up a TIFF file's images (IFD0, IFD1, ... are its pages). */
const TIFF_STRUCTURE = new Set([
  'SubfileType', 'OldSubfileType', 'ImageWidth', 'ImageHeight', 'BitsPerSample', 'Compression',
  'PhotometricInterpretation', 'FillOrder', 'StripOffsets', 'SamplesPerPixel', 'RowsPerStrip',
  'StripByteCounts', 'PlanarConfiguration', 'PageNumber', 'Predictor', 'WhitePoint',
  'PrimaryChromaticities', 'XResolution', 'YResolution', 'ResolutionUnit', 'Orientation',
  'TileWidth', 'TileLength', 'TileOffsets', 'TileByteCounts', 'ExtraSamples', 'SampleFormat',
  'YCbCrSubSampling', 'YCbCrPositioning', 'ReferenceBlackWhite', 'ColorMap', 'TransferFunction',
  'JPEGTables', 'MinSampleValue', 'MaxSampleValue', 'ICC_Profile',
])

/** Words that never belong in a stripped file's tag names or values. */
const PERSONAL_WORDS = /gps|location|latitude|longitude|make|model|serial|software|artist|copyright|owner|creator|author|comment|by-line|lens|maker|userdata|keys|itemlist|history|documentid|instanceid|thumbnail|mpimage|testplace|testcamera|testperson/i

/**
 * Tags in a stripped file that are not neutral, plus any value that still contains one of the
 * fixture's marker strings. Empty means clean.
 */
export function personalTags(
  tags: Record<string, unknown>,
  markers: string[],
  options: {tiff?: boolean} = {},
): string[] {
  const found: string[] = []
  for (const [key, value] of Object.entries(tags)) {
    if (key === 'SourceFile') continue
    const group = key.split(':')[0]
    if (options.tiff && /^IFD\d+$/.test(group) && TIFF_STRUCTURE.has(key.split(':')[1] ?? '')) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (markers.some((m) => text.includes(m))) {
      found.push(`${key} (contains a marker)`)
      continue
    }
    if (NEUTRAL_TAGS.has(key) || NEUTRAL_GROUPS.has(group)) {
      // Dates in neutral groups (QuickTime creation dates) must be zero.
      if (/Date/.test(key) && !/^0000:00:00 00:00:00/.test(text) && !/ProfileDateTime|^File:|^System:/.test(key) && text !== '0') {
        found.push(`${key}=${text}`)
      }
      // The ICC profile is kept whole (owner decision), including its own description and copyright.
      if (group !== 'System' && group !== 'File' && group !== 'ExifTool' && !group.startsWith('ICC') && PERSONAL_WORDS.test(key.split(':')[1] ?? '') && !/^ICC|ProfileDescription|ProfileCreator|DeviceModel|DeviceManufacturer|HandlerVendorID|HandlerDescription|VendorID|CompressorName|Encoder|MajorBrand|CompatibleBrands/.test(key.split(':')[1] ?? '')) {
        found.push(key)
      }
      continue
    }
    found.push(key)
  }
  return found
}

/** Decoded frames as ffmpeg sees them, without applying the orientation (one MD5 per frame). */
export function ffmpegFrames(file: string): string[] {
  const out = tool('ffmpeg', ['-v', 'error', '-noautorotate', '-i', file, '-map', '0:v', '-f', 'framemd5', '-']).toString('utf8')
  return out.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
}

/** ImageMagick's pixel signature of every frame (sha256 of the decoded pixel values). */
export function magickSignatures(file: string): string[] {
  return tool('magick', ['identify', '-format', '%#\n', file]).toString('utf8').split('\n').filter(Boolean)
}

/** The embedded ICC profile's sha256, or null. */
export function iccSha256(file: string): string | null {
  const out = tool('exiftool', ['-icc_profile', '-b', file])
  return out.length > 0 ? sha256(out) : null
}

export function exifOrientation(file: string): number | null {
  const tags = exiftoolTags(file)
  const value = tags['IFD0:Orientation']
  return typeof value === 'number' && value >= 2 && value <= 8 ? value : null
}
