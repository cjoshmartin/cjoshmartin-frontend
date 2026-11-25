import { createImageUrlBuilder, type SanityImageSource } from '@sanity/image-url'

import { dataset, projectId } from '@/sanity/env'
import { croppedDimensions, fitWidth, type ImageDimensions } from '@/sanity/lib/imageDimensions'

export type { ImageDimensions }

const builder = createImageUrlBuilder({ projectId, dataset })

/** Image URL builder for any image field shape TypeGen produces (crop and hotspot are applied). */
export function urlFor(source: SanityImageSource) {
  return builder.image(source)
}

/** An image field as stored: an asset reference plus optional crop, hotspot and alt text. */
export interface SanityImageValue {
  asset?: { _ref: string } | null
  crop?: { top?: number; bottom?: number; left?: number; right?: number } | null
  hotspot?: { x?: number; y?: number; width?: number; height?: number } | null
  alt?: string | null
}

/** An image field that is known to have an asset. */
export type SanityImageWithAsset = SanityImageValue & { asset: { _ref: string } }

export function hasAsset<T extends SanityImageValue>(
  image: T | null | undefined,
): image is T & { asset: { _ref: string } } {
  return Boolean(image?.asset?._ref)
}

/**
 * Width and height of the image `urlFor(image)` delivers, which applies the editor's crop. Image
 * asset ids are `image-<sha1>-<width>x<height>-<format>`, a stable format documented by Sanity, so
 * the original dimensions can be read without dereferencing the asset document; the crop is then
 * applied the way `@sanity/image-url` applies it.
 */
export function getImageDimensions(image: SanityImageWithAsset): ImageDimensions {
  return croppedDimensions(image.asset._ref, image.crop)
}

/**
 * URL of the image scaled down to at most `maxWidth` pixels wide (never scaled up), in the best
 * format the browser accepts. Animated GIFs stay animated through the image pipeline.
 */
export function imageUrl(image: SanityImageWithAsset, maxWidth: number): string {
  return urlFor(image).width(maxWidth).fit('max').auto('format').url()
}

/** Width and height of `imageUrl(image, maxWidth)`, for `<img width height>` attributes. */
export function scaledDimensions(image: SanityImageWithAsset, maxWidth: number): ImageDimensions {
  return fitWidth(getImageDimensions(image), maxWidth)
}

/** The original file on the Sanity CDN, for components that hand the URL to next/image. */
export function originalImageUrl(image: SanityImageWithAsset): string {
  return urlFor(image).url()
}

export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

/**
 * Open Graph image: a 1200x630 crop around the hotspot, pinned to JPEG because social crawlers
 * do not reliably accept the AVIF/WebP that `auto=format` would return.
 */
export function ogImageUrl(image: SanityImageWithAsset): string {
  return urlFor(image)
    .width(OG_IMAGE_WIDTH)
    .height(OG_IMAGE_HEIGHT)
    .fit('crop')
    .format('jpg')
    .url()
}
