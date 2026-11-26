/**
 * What every image format module (jpeg.ts, png.ts, webp.ts, gif.ts, isobmff-image.ts, tiff.ts)
 * returns: the metadata it found, the parts it keeps, and how to build the file without the rest.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heif' | 'tiff'

/** One piece of metadata that stripping removes (or replaces, like an EXIF block). */
export interface RemovedItem {
  /** Human-readable, e.g. "EXIF: GPS, Make, Model" or "XMP". Never contains the values. */
  what: string
  /**
   * Whether this is personal metadata. Technical-only items (an EXIF block with only the
   * orientation and resolution, Apple's iDOT decoding hint) are removed when the file is stripped
   * for other reasons, but on their own do not make a file worth replacing.
   */
  personal: boolean
}

export interface ImageAnalysis {
  format: ImageFormat
  removed: RemovedItem[]
  /** EXIF orientation 2..8 that the stripped file keeps, or undefined (none, or 1). */
  orientation: number | undefined
  /** The ICC profile as stored in the file (format-specific framing), kept byte for byte. */
  icc: Uint8Array | undefined
  /**
   * The coded image (pixel data, palettes, decoder tables, frame structure) in file order. The
   * stripped file must have exactly the same parts, so it decodes to the same pixels.
   */
  imageData: Uint8Array[]
  /** Builds the file without the removed items (deterministic). */
  strip(): Uint8Array
}
