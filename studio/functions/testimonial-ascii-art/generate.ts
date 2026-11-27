/**
 * Testimonial photo -> colored ASCII-art HTML.
 *
 * This is an exact port of what the Django backend did for every testimonial image
 * (cjoshmartin-backend/home/serializers.py, TestimonialImageSerializedField):
 *
 *   image = Image.open(...).convert("RGB")
 *   image = image.point(lambda p: 8 + p * (255 - 8) // 255)
 *   html = AsciiArt.from_pillow_image(image).to_html(columns=35)   # ascii-magic==2.3.0
 *   etree.tostring(lxml.html.fromstring(html), encoding="unicode", pretty_print=True)
 *
 * The character ramp, grid-size arithmetic, luma conversion, color formula, Pillow's bicubic
 * resample (pillow-resample.ts) and the markup produced by lxml's pretty printer are all
 * reproduced bit for bit. The pixels come from the Sanity image CDN as a lossless PNG of the
 * whole image, which for sRGB/untagged JPEGs and for PNGs decodes to exactly the bytes Pillow
 * decodes, so for those images the output is byte-identical to the Django output
 * (see generateAsciiArtForSanityImage for the exceptions).
 *
 * Pure JavaScript only (pngjs), so it runs inside a Sanity Function (Node 24) and in the
 * migration scripts (tsx).
 */
import {PNG} from 'pngjs'

import {pillowResizeBicubic} from './pillow-resample'

/** ascii_magic.constants.CHARS_BY_DENSITY in 2.3.0, from lightest to densest. */
export const CHARS_BY_DENSITY =
  ' .`-_\':,;^=+/"|)\\<>)iv%xclrs{*}I?!][1taeo7zjLunT#JCwfy325Fp6mqSghVd4EgXPGZbYkOA&8U$@KHDBWNMR0Q'

/** `to_html(columns=35)` in the Django serializer. */
export const DEFAULT_COLUMNS = 35

/** Default `width_ratio` of ascii-magic's `to_html`. */
export const DEFAULT_WIDTH_RATIO = 2.2

/** ASCII_ART_MIN_BRIGHTNESS in the Django serializer. */
export const MIN_BRIGHTNESS = 8

export interface AsciiGridSize {
  columns: number
  rows: number
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`)
  }
}

/**
 * The grid size ascii-magic picks for a source image, computed with the same floating-point
 * operations in the same order as `AsciiArt._img_to_art`:
 *
 *   scalar = img_w * width_ratio / columns
 *   img_w = int(img_w * width_ratio / scalar)
 *   img_h = int(img_h / scalar)
 *
 * Note that the column count can come out one lower than requested because of float rounding
 * (e.g. some widths give 34 columns for columns=35), and rows can be 0 for very wide images.
 */
export function asciiGridSize(
  width: number,
  height: number,
  columns: number = DEFAULT_COLUMNS,
  widthRatio: number = DEFAULT_WIDTH_RATIO,
): AsciiGridSize {
  assertPositiveInteger('width', width)
  assertPositiveInteger('height', height)
  assertPositiveInteger('columns', columns)
  if (!(widthRatio > 0)) throw new RangeError(`widthRatio must be positive, got ${widthRatio}`)
  const scalar = (width * widthRatio) / columns
  return {
    columns: Math.trunc((width * widthRatio) / scalar),
    rows: Math.trunc(height / scalar),
  }
}

/** `lambda p: floor + p * (255 - floor) // 255` from the Django serializer, for one channel value. */
export function brightnessFloor(value: number, floor: number = MIN_BRIGHTNESS): number {
  return floor + Math.floor((value * (255 - floor)) / 255)
}

/**
 * Applies the brightness floor to every R, G and B value (alpha is left untouched).
 * Returns a new array; the input is not modified.
 */
export function applyBrightnessFloor(
  pixels: ArrayLike<number>,
  channels: 3 | 4,
  floor: number = MIN_BRIGHTNESS,
): Uint8Array {
  if (pixels.length % channels !== 0) {
    throw new RangeError(`pixel buffer length ${pixels.length} is not a multiple of ${channels}`)
  }
  const table = new Uint8Array(256)
  for (let v = 0; v < 256; v++) table[v] = brightnessFloor(v, floor)
  const out = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    out[i] = channels === 4 && i % 4 === 3 ? pixels[i] : table[pixels[i]]
  }
  return out
}

/**
 * Pillow's RGB -> "L" conversion (ITU-R 601-2 luma in 16.16 fixed point, rounded), which
 * ascii-magic uses for brightness. Verified against Pillow for all 2^24 colors.
 */
export function pillowLuma(r: number, g: number, b: number): number {
  return (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16
}

/** Index into CHARS_BY_DENSITY: `int(brightness * (len(chars) - 1))` with brightness = L / 255. */
export function charIndexForLuma(luma: number): number {
  return Math.trunc((luma / 255) * (CHARS_BY_DENSITY.length - 1))
}

/**
 * One color channel of the `<span style="color: #rrggbb">`: ascii-magic converts each channel
 * to linear light with `(v / 255.0) ** 2.2` and then formats `int(c * 200 + 55)` as hex.
 */
export function hexComponent(value: number): number {
  return Math.trunc(Math.pow(value / 255, 2.2) * 200 + 55)
}

const HEX_BY_VALUE: readonly string[] = Array.from({length: 256}, (_, v) =>
  hexComponent(v).toString(16).padStart(2, '0'),
)

/** Text escaping done by lxml's serializer for the characters of the ramp. */
function escapeText(char: string): string {
  if (char === '&') return '&amp;'
  if (char === '<') return '&lt;'
  if (char === '>') return '&gt;'
  return char
}

/**
 * Renders an already-resized pixel grid exactly like ascii-magic 2.3.0
 * `to_html(full_color=True)` followed by `lxml.html.fromstring` and
 * `etree.tostring(..., encoding="unicode", pretty_print=True)`.
 *
 * `pixels` is row-major RGB (channels = 3) or RGBA (channels = 4) data of exactly
 * `columns * rows` pixels. Alpha is ignored, like Pillow's RGBA -> RGB conversion.
 * No brightness floor is applied here (see applyBrightnessFloor).
 *
 * Markup produced (what lxml makes of `<span ...>c</span>...<br />...`):
 * - more than one element: a wrapping `<span>`, one child per line indented by two spaces,
 *   `<br/>` between rows, and a trailing newline;
 * - a 1x1 grid: the single `<span style=...>c</span>` and a newline;
 * - an empty grid: "" (lxml raises "Document is empty" and the serializer returned "").
 */
export function renderAsciiArtHtml(
  pixels: ArrayLike<number>,
  columns: number,
  rows: number,
  channels: 3 | 4 = 4,
): string {
  if (!Number.isInteger(columns) || columns < 0 || !Number.isInteger(rows) || rows < 0) {
    throw new RangeError(`invalid grid ${columns}x${rows}`)
  }
  if (pixels.length !== columns * rows * channels) {
    throw new RangeError(
      `expected ${columns * rows * channels} values for a ${columns}x${rows} grid with ${channels} channels, got ${pixels.length}`,
    )
  }
  if (columns === 0 || rows === 0) return ''

  const elements: string[] = []
  for (let y = 0; y < rows; y++) {
    if (y > 0) elements.push('<br/>')
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * channels
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      const char = CHARS_BY_DENSITY[charIndexForLuma(pillowLuma(r, g, b))]
      const color = `#${HEX_BY_VALUE[r]}${HEX_BY_VALUE[g]}${HEX_BY_VALUE[b]}`
      elements.push(`<span style="color: ${color}">${escapeText(char)}</span>`)
    }
  }

  if (elements.length === 1) return `${elements[0]}\n`
  return `<span>\n${elements.map((element) => `  ${element}\n`).join('')}</span>\n`
}

export interface ParsedImageAssetId {
  hash: string
  width: number
  height: number
  format: string
}

const IMAGE_ASSET_ID = /^image-([A-Za-z0-9]+)-(\d+)x(\d+)-([A-Za-z0-9]+)$/

/**
 * Parses a Sanity image asset `_id` (`image-<hash>-<width>x<height>-<format>`). The
 * dimensions in the id are the displayed (EXIF-oriented) dimensions, the same ones the
 * image CDN works with.
 */
export function parseImageAssetId(assetId: string): ParsedImageAssetId {
  const match = IMAGE_ASSET_ID.exec(assetId)
  if (!match) throw new Error(`not a Sanity image asset id: ${JSON.stringify(assetId)}`)
  return {
    hash: match[1],
    width: Number(match[2]),
    height: Number(match[3]),
    format: match[4],
  }
}

/**
 * Sources whose longer edge is at most this many pixels are fetched at full size, which makes
 * the result byte-identical to Pillow's. Larger ones are first scaled down by the CDN so the
 * PNG stays a few MB (a 4032x3024 photo is about 17 MB as PNG); Pillow's bicubic filter then
 * does the final step from there. Measured on 4032x3024 and 3680x2128 photos, that costs a few
 * percent of exact characters and keeps 100% within one ramp step.
 */
export const MAX_SOURCE_EDGE = 2048

export interface AsciiArtSourceUrlOptions {
  projectId: string
  dataset: string
  assetId: string
  /** Default MAX_SOURCE_EDGE. */
  maxEdge?: number
}

export interface AsciiArtSource {
  url: string
  /** True when the CDN returns the image at its original size (no CDN resampling). */
  fullSize: boolean
}

/**
 * Sanity image CDN URL for the pixels the generator works from: the whole image (no crop or
 * hotspot, like the Django version), as PNG so nothing is lost to compression, at full size
 * unless its longer edge exceeds `maxEdge`.
 *
 * Note: the CDN applies EXIF orientation and converts images with an embedded non-sRGB ICC
 * profile (e.g. iPhone Display P3) to sRGB; Pillow did neither. `cs=origin` does not change
 * that for PNG output (checked), so it is not used.
 */
export function asciiArtSourceUrl({
  projectId,
  dataset,
  assetId,
  maxEdge = MAX_SOURCE_EDGE,
}: AsciiArtSourceUrlOptions): AsciiArtSource {
  if (!/^[a-z0-9]+$/.test(projectId))
    throw new Error(`invalid projectId ${JSON.stringify(projectId)}`)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(dataset))
    throw new Error(`invalid dataset ${JSON.stringify(dataset)}`)
  assertPositiveInteger('maxEdge', maxEdge)
  const {hash, width, height, format} = parseImageAssetId(assetId)
  const params = new URLSearchParams()
  const fullSize = Math.max(width, height) <= maxEdge
  if (!fullSize) {
    if (width >= height) params.set('w', String(maxEdge))
    else params.set('h', String(maxEdge))
    params.set('fit', 'max')
  }
  params.set('fm', 'png')
  return {
    url: `https://cdn.sanity.io/images/${projectId}/${dataset}/${hash}-${width}x${height}.${format}?${params}`,
    fullSize,
  }
}

/**
 * Raised when the CDN answered but the asset cannot be turned into pixels (for example an SVG,
 * which the image pipeline does not rasterize, or a corrupt file). The Django serializer
 * returned "" in that situation; callers decide what to store.
 */
export class UnsupportedImageError extends Error {
  override name = 'UnsupportedImageError'
}

/** Drops the alpha channel of 8-bit RGBA data, like Pillow's RGBA -> RGB conversion. */
export function rgbaToRgb(rgba: ArrayLike<number>): Uint8Array {
  if (rgba.length % 4 !== 0)
    throw new RangeError(`RGBA buffer length ${rgba.length} is not a multiple of 4`)
  const rgb = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]
    rgb[j + 1] = rgba[i + 1]
    rgb[j + 2] = rgba[i + 2]
  }
  return rgb
}

/**
 * The Django pipeline after decoding: brightness floor on the full-resolution RGB pixels,
 * Pillow bicubic resize to the grid, then the ascii-magic HTML.
 *
 * `grid` must be computed from the original image size (asciiGridSize), which differs from
 * `width` x `height` when the CDN supplied a scaled-down source.
 */
export function asciiArtFromRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  grid: AsciiGridSize,
): string {
  if (grid.columns === 0 || grid.rows === 0)
    return renderAsciiArtHtml([], grid.columns, grid.rows, 3)
  const floored = applyBrightnessFloor(rgb, 3)
  const resized = pillowResizeBicubic(floored, width, height, grid.columns, grid.rows)
  return renderAsciiArtHtml(resized, grid.columns, grid.rows, 3)
}

export interface GenerateAsciiArtOptions {
  projectId: string
  dataset: string
  /** Image asset `_id`, e.g. `image-<sha1>-800x800-jpg`. */
  assetId: string
  /** Requested columns, default 35 like the Django serializer. */
  columns?: number
  /** Default MAX_SOURCE_EDGE. */
  maxEdge?: number
  /** Injected fetch, for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number
  /** Attempts for transient CDN failures (network errors, 429, 5xx). Default 3. */
  attempts?: number
}

export interface AsciiArtResult {
  html: string
  columns: number
  rows: number
  /** The CDN URL the pixels came from, or null when the grid has zero rows and nothing was fetched. */
  url: string | null
  /** Whether the source was fetched at full size (byte-identical path). */
  fullSize: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function fetchPng(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  attempts: number,
): Promise<PNG> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs)})
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await sleep(500 * 3 ** (attempt - 1))
        continue
      }
      break
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`image CDN returned HTTP ${response.status} for ${url}`)
      await response.body?.cancel()
      if (attempt < attempts) {
        await sleep(500 * 3 ** (attempt - 1))
        continue
      }
      break
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300)
      if (response.status === 400 || response.status === 415 || response.status === 422) {
        throw new UnsupportedImageError(
          `image CDN returned HTTP ${response.status} for ${url}: ${body}`,
        )
      }
      throw new Error(`image CDN returned HTTP ${response.status} for ${url}: ${body}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/png')) {
      await response.body?.cancel()
      throw new UnsupportedImageError(
        `image CDN returned ${contentType || 'no content type'} instead of image/png for ${url}`,
      )
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    try {
      return PNG.sync.read(bytes)
    } catch (error) {
      throw new UnsupportedImageError(`could not decode the PNG from ${url}`, {cause: error})
    }
  }
  throw new Error(`could not fetch ${url} after ${attempts} attempts`, {cause: lastError})
}

/**
 * Generates the testimonial ASCII-art HTML for a Sanity image asset, the same way the Django
 * serializer did: grid size from the asset dimensions, full-resolution pixels (lossless PNG
 * from the CDN, decoded with pngjs), brightness floor, Pillow bicubic resize, ascii-magic HTML.
 *
 * Byte-identical to the Django output for sRGB or untagged JPEGs and for PNGs up to
 * MAX_SOURCE_EDGE. Differences: larger images are pre-scaled by the CDN (a few characters
 * differ), images with a non-sRGB ICC profile are converted to sRGB by the CDN, and EXIF
 * orientation is applied (Pillow ignored it, so such photos used to come out sideways).
 *
 * Returns html "" without fetching when the grid has zero rows (very wide images), which is
 * what the Django serializer produced. Throws UnsupportedImageError when the CDN cannot
 * produce a PNG for the asset, and a plain Error for transient failures after retries.
 */
export async function generateAsciiArtForSanityImage(
  options: GenerateAsciiArtOptions,
): Promise<AsciiArtResult> {
  const {projectId, dataset, assetId} = options
  const fetchImpl = options.fetch ?? globalThis.fetch
  const {width, height} = parseImageAssetId(assetId)
  const grid = asciiGridSize(width, height, options.columns ?? DEFAULT_COLUMNS)
  if (grid.columns === 0 || grid.rows === 0) {
    return {
      html: renderAsciiArtHtml([], grid.columns, grid.rows, 3),
      ...grid,
      url: null,
      fullSize: true,
    }
  }

  const {url, fullSize} = asciiArtSourceUrl({projectId, dataset, assetId, maxEdge: options.maxEdge})
  const png = await fetchPng(url, fetchImpl, options.timeoutMs ?? 30000, options.attempts ?? 3)
  if (fullSize && (png.width !== width || png.height !== height)) {
    throw new Error(
      `image CDN returned ${png.width}x${png.height} for ${url}, expected the original ${width}x${height}`,
    )
  }
  // pngjs always decodes to 8-bit RGBA, whatever the PNG color type or bit depth.
  const html = asciiArtFromRgb(rgbaToRgb(png.data), png.width, png.height, grid)
  return {html, ...grid, url, fullSize}
}
