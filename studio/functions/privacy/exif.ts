/**
 * TIFF structure (the format of EXIF blocks and of TIFF files): a reader for image file
 * directories (IFDs), the classification of an EXIF block into technical and personal tags, and
 * the minimal EXIF block the strippers write to keep the orientation. No I/O, no dependencies.
 */

export class ImageStripError extends Error {
  override name = 'ImageStripError'
}

/** Byte sizes of the TIFF field types (6.0 plus BigTIFF's 16-18, which only BigTIFF uses). */
const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
}

export const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  Compression: 259,
  StripOffsets: 273,
  Orientation: 274,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  ResolutionUnit: 296,
  SubIFDs: 330,
  TileOffsets: 324,
  TileByteCounts: 325,
  JPEGInterchangeFormat: 513,
  JPEGInterchangeFormatLength: 514,
  YCbCrPositioning: 531,
  ExifIFD: 34665,
  GPSIFD: 34853,
  InteropIFD: 40965,
  ICCProfile: 34675,
} as const

export interface TiffEntry {
  tag: number
  type: number
  count: number
  /** Absolute offset (in the reader's buffer) of the value bytes. */
  valueOffset: number
  /** Byte length of the value (count * type size). */
  byteLength: number
  /** Offset of the 12-byte entry itself. */
  entryOffset: number
}

export interface TiffIfd {
  offset: number
  entries: TiffEntry[]
  /** Offset of the next IFD (relative to the TIFF header), 0 at the end of the chain. */
  next: number
}

/**
 * Reads a TIFF structure that starts at `base` in `bytes` (an EXIF block after "Exif\0\0", or a
 * whole TIFF file). Offsets inside the structure are relative to `base`. Throws ImageStripError
 * for anything malformed: the strippers never guess.
 */
export class TiffReader {
  readonly littleEndian: boolean
  readonly firstIfdOffset: number
  private readonly view: DataView

  constructor(
    readonly bytes: Uint8Array,
    readonly base = 0,
    readonly end = bytes.length,
  ) {
    if (end - base < 8) throw new ImageStripError('TIFF header is truncated')
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const order = String.fromCharCode(bytes[base], bytes[base + 1])
    if (order === 'II') this.littleEndian = true
    else if (order === 'MM') this.littleEndian = false
    else throw new ImageStripError(`TIFF byte order mark is ${JSON.stringify(order)}, not II or MM`)
    const magic = this.u16(base + 2)
    if (magic === 43) throw new ImageStripError('BigTIFF is not supported')
    if (magic !== 42) throw new ImageStripError(`TIFF magic number is ${magic}, not 42`)
    this.firstIfdOffset = this.u32(base + 4)
  }

  u16(offset: number): number {
    this.check(offset, 2)
    return this.view.getUint16(offset, this.littleEndian)
  }

  u32(offset: number): number {
    this.check(offset, 4)
    return this.view.getUint32(offset, this.littleEndian)
  }

  private check(offset: number, length: number): void {
    if (offset < this.base || offset + length > this.end) {
      throw new ImageStripError(`TIFF structure points outside its data (offset ${offset - this.base})`)
    }
  }

  /** The IFD at `relativeOffset` (from the TIFF header). */
  ifd(relativeOffset: number): TiffIfd {
    const offset = this.base + relativeOffset
    const count = this.u16(offset)
    this.check(offset, 2 + count * 12 + 4)
    const entries: TiffEntry[] = []
    for (let i = 0; i < count; i++) {
      const entryOffset = offset + 2 + i * 12
      const tag = this.u16(entryOffset)
      const type = this.u16(entryOffset + 2)
      const valueCount = this.u32(entryOffset + 4)
      const size = TYPE_SIZES[type]
      if (size === undefined) {
        // An unknown type: its size is unknown, so the value cannot be located. Recorded with
        // length 0; callers treat the tag as removable metadata and never copy it.
        entries.push({tag, type, count: valueCount, valueOffset: entryOffset + 8, byteLength: 0, entryOffset})
        continue
      }
      const byteLength = size * valueCount
      const valueOffset = byteLength <= 4 ? entryOffset + 8 : this.base + this.u32(entryOffset + 8)
      if (byteLength > 4) this.check(valueOffset, byteLength)
      entries.push({tag, type, count: valueCount, valueOffset, byteLength, entryOffset})
    }
    return {offset, entries, next: this.u32(offset + 2 + count * 12)}
  }

  /** Unsigned integer values of a BYTE, SHORT, LONG or IFD entry. */
  integers(entry: TiffEntry): number[] {
    const values: number[] = []
    for (let i = 0; i < entry.count; i++) {
      switch (entry.type) {
        case 1:
        case 7:
          values.push(this.bytes[entry.valueOffset + i])
          break
        case 3:
          values.push(this.u16(entry.valueOffset + i * 2))
          break
        case 4:
        case 13:
          values.push(this.u32(entry.valueOffset + i * 4))
          break
        default:
          throw new ImageStripError(`TIFF tag ${entry.tag} has type ${entry.type}, not an integer type`)
      }
    }
    return values
  }

  /** The value bytes of an entry. */
  value(entry: TiffEntry): Uint8Array {
    return this.bytes.subarray(entry.valueOffset, entry.valueOffset + entry.byteLength)
  }
}

/** Orientation values 2..8 change how the image is shown; 1 and anything invalid do not. */
export function meaningfulOrientation(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 2 && value <= 8 ? value : undefined
}

/**
 * EXIF tags that describe how to decode or show the image and nothing about where, when, by whom or
 * with which device it was made. An EXIF block with only these tags is not personal metadata (it is
 * what exiftool writes when it keeps only the orientation), so an image that has nothing else is
 * left alone.
 */
const TECHNICAL_IFD0_TAGS = new Set<number>([
  TAG.ImageWidth,
  TAG.ImageLength,
  TAG.Orientation,
  TAG.XResolution,
  TAG.YResolution,
  TAG.ResolutionUnit,
  TAG.YCbCrPositioning,
  529, // YCbCrCoefficients
  532, // ReferenceBlackWhite
  TAG.ExifIFD,
])

const TECHNICAL_EXIF_TAGS = new Set<number>([
  36864, // ExifVersion
  37121, // ComponentsConfiguration
  40960, // FlashpixVersion
  40961, // ColorSpace
  40962, // PixelXDimension
  40963, // PixelYDimension
  42240, // Gamma
  TAG.InteropIFD,
])

const TECHNICAL_INTEROP_TAGS = new Set<number>([
  1, // InteroperabilityIndex
  2, // InteroperabilityVersion
])

/** Names of the personal EXIF tags most often found, for the report. Others are named by number. */
const TAG_NAMES: Record<number, string> = {
  269: 'DocumentName',
  270: 'ImageDescription',
  271: 'Make',
  272: 'Model',
  305: 'Software',
  306: 'DateTime',
  315: 'Artist',
  316: 'HostComputer',
  33432: 'Copyright',
  [TAG.GPSIFD]: 'GPS',
  [TAG.ExifIFD]: 'EXIF IFD',
  37500: 'MakerNote',
  36867: 'DateTimeOriginal',
  36868: 'DateTimeDigitized',
  36880: 'OffsetTime',
  36881: 'OffsetTimeOriginal',
  36882: 'OffsetTimeDigitized',
  37520: 'SubSecTime',
  37521: 'SubSecTimeOriginal',
  37522: 'SubSecTimeDigitized',
  37510: 'UserComment',
  33434: 'ExposureTime',
  33437: 'FNumber',
  34855: 'ISO',
  37384: 'LightSource',
  37385: 'Flash',
  37386: 'FocalLength',
  41990: 'SceneCaptureType',
  40091: 'XPTitle',
  40092: 'XPComment',
  40093: 'XPAuthor',
  40094: 'XPKeywords',
  40095: 'XPSubject',
  42016: 'ImageUniqueID',
  42032: 'CameraOwnerName',
  42033: 'BodySerialNumber',
  42034: 'LensSpecification',
  42035: 'LensMake',
  42036: 'LensModel',
  42037: 'LensSerialNumber',
  50735: 'CameraSerialNumber',
  700: 'XMP',
  33723: 'IPTC',
  34377: 'Photoshop',
}

export function tagName(tag: number): string {
  return TAG_NAMES[tag] ?? `tag ${tag}`
}

export interface ExifSummary {
  orientation: number | undefined
  /** Personal tags found (names), empty when the block is technical only. */
  personal: string[]
}

/**
 * Classifies an EXIF block (the TIFF structure, without any "Exif\0\0" prefix): its orientation and
 * the personal tags in it. A thumbnail (IFD1) counts as personal: it may show the photo before it
 * was cropped. Throws ImageStripError when the block cannot be read, because the orientation would
 * then be unknown.
 */
export function summarizeExif(tiff: Uint8Array): ExifSummary {
  const reader = new TiffReader(tiff)
  const personal: string[] = []
  const ifd0 = reader.ifd(reader.firstIfdOffset)
  let orientation: number | undefined
  for (const entry of ifd0.entries) {
    if (entry.tag === TAG.Orientation && (entry.type === 3 || entry.type === 4) && entry.count >= 1) {
      orientation = reader.integers(entry)[0]
    }
    if (!TECHNICAL_IFD0_TAGS.has(entry.tag)) personal.push(tagName(entry.tag))
  }
  const exifPointer = ifd0.entries.find((e) => e.tag === TAG.ExifIFD)
  if (exifPointer) {
    const exif = reader.ifd(reader.integers(exifPointer)[0])
    for (const entry of exif.entries) {
      if (!TECHNICAL_EXIF_TAGS.has(entry.tag)) personal.push(tagName(entry.tag))
    }
    const interopPointer = exif.entries.find((e) => e.tag === TAG.InteropIFD)
    if (interopPointer) {
      const interop = reader.ifd(reader.integers(interopPointer)[0])
      for (const entry of interop.entries) {
        if (!TECHNICAL_INTEROP_TAGS.has(entry.tag)) personal.push(`Interop ${tagName(entry.tag)}`)
      }
    }
  }
  if (ifd0.next !== 0) personal.push('thumbnail (IFD1)')
  return {orientation: meaningfulOrientation(orientation), personal: [...new Set(personal)]}
}

/**
 * The smallest EXIF block that keeps an orientation: a big-endian TIFF header and one IFD with the
 * Orientation tag, no thumbnail. The same bytes every time, so stripping an already stripped image
 * changes nothing.
 */
export function orientationExif(orientation: number): Uint8Array {
  if (meaningfulOrientation(orientation) === undefined) {
    throw new RangeError(`orientation ${orientation} does not need an EXIF block`)
  }
  const bytes = new Uint8Array(8 + 2 + 12 + 4)
  const view = new DataView(bytes.buffer)
  bytes.set([0x4d, 0x4d, 0x00, 0x2a], 0) // "MM", 42
  view.setUint32(4, 8) // IFD0 right after the header
  view.setUint16(8, 1) // one entry
  view.setUint16(10, TAG.Orientation)
  view.setUint16(12, 3) // SHORT
  view.setUint32(14, 1) // count
  view.setUint16(18, orientation) // value, left-justified in the 4-byte field
  view.setUint32(22, 0) // no next IFD
  return bytes
}

/** "Exif\0\0", the prefix of an EXIF APP1 segment in JPEG. */
export const EXIF_PREFIX = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00])

export function startsWith(bytes: Uint8Array, prefix: Uint8Array | string, at = 0): boolean {
  const p = typeof prefix === 'string' ? new TextEncoder().encode(prefix) : prefix
  if (at + p.length > bytes.length) return false
  for (let i = 0; i < p.length; i++) if (bytes[at + i] !== p[i]) return false
  return true
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
