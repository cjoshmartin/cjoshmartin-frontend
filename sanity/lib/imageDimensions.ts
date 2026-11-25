/*
 * Image dimensions without a request: Sanity image asset ids are `image-<sha1>-<width>x<height>-<format>`
 * (a stable format documented by Sanity). Kept free of app imports so unit tests can load it.
 */

export interface ImageDimensions {
  width: number
  height: number
}

/** The fractions an editor cropped off each side in the Studio (all image fields have hotspot: true). */
export interface ImageCrop {
  top?: number | null
  bottom?: number | null
  left?: number | null
  right?: number | null
}

/** Width and height of the original upload, read from the asset id. */
export function assetDimensions(assetRef: string): ImageDimensions {
  const match = /^image-[a-zA-Z0-9]+-(\d+)x(\d+)-[a-z0-9]+$/.exec(assetRef)
  if (!match) {
    throw new Error(`Unexpected Sanity image asset id: ${assetRef}`)
  }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * Width and height of the image the URL builder delivers: the original minus the editor's crop.
 * `@sanity/image-url` turns the crop into `rect=left,top,width,height` with exactly this rounding
 * (it rounds the left and top offsets first, then the remaining width and height), so the result is
 * the pixel size of the cropped image before any resize.
 */
export function croppedDimensions(assetRef: string, crop?: ImageCrop | null): ImageDimensions {
  const { width, height } = assetDimensions(assetRef)
  const left = Math.round((crop?.left ?? 0) * width)
  const top = Math.round((crop?.top ?? 0) * height)
  return {
    width: Math.round(width - (crop?.right ?? 0) * width - left),
    height: Math.round(height - (crop?.bottom ?? 0) * height - top),
  }
}

/** The size of `dimensions` scaled down to at most `maxWidth` wide (never up), like `fit=max`. */
export function fitWidth(dimensions: ImageDimensions, maxWidth: number): ImageDimensions {
  const { width, height } = dimensions
  if (width <= maxWidth) {
    return { width, height }
  }
  return { width: maxWidth, height: Math.round((height * maxWidth) / width) }
}
