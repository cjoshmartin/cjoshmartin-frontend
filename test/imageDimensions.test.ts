import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createImageUrlBuilder } from '@sanity/image-url'

import { assetDimensions, croppedDimensions, fitWidth, sizedTo } from '../sanity/lib/imageDimensions.ts'

const ASSET = 'image-5893cbb9-1000x667-jpg'
const builder = createImageUrlBuilder({ projectId: 'abc123', dataset: 'production' })

/** The `rect` size @sanity/image-url puts in the URL (the whole image when it adds none). */
function rectSize(url: string, whole: { width: number; height: number }) {
  const rect = new URL(url).searchParams.get('rect')
  if (!rect) return whole
  const [, , width, height] = rect.split(',').map(Number)
  return { width: width!, height: height! }
}

describe('croppedDimensions', () => {
  it('reads the original size from the asset id when there is no crop', () => {
    assert.deepEqual(assetDimensions(ASSET), { width: 1000, height: 667 })
    assert.deepEqual(croppedDimensions(ASSET, undefined), { width: 1000, height: 667 })
    assert.deepEqual(croppedDimensions(ASSET, { top: 0, bottom: 0, left: 0, right: 0 }), { width: 1000, height: 667 })
    assert.throws(() => assetDimensions('file-abc-pdf'), /Unexpected Sanity image asset id/)
  })

  it('matches the rect @sanity/image-url sends to the CDN for every crop', () => {
    const crops = [
      { top: 0.1, bottom: 0.2, left: 0.05, right: 0.3 },
      { top: 0.333, bottom: 0.111, left: 0.4449, right: 0.0051 },
      { top: 0, bottom: 0.5, left: 0, right: 0 },
      { top: 0.25, left: 0.25 },
    ]
    for (const crop of crops) {
      const image = { _type: 'image', asset: { _ref: ASSET, _type: 'reference' }, crop }
      const url = builder.image(image).url()
      assert.deepEqual(croppedDimensions(ASSET, crop), rectSize(url, assetDimensions(ASSET)), JSON.stringify(crop))
    }
  })

  it('keeps the aspect ratio of the cropped image, not the original', () => {
    // A square crop out of a landscape photo: the old code reported 1000x667.
    const square = croppedDimensions(ASSET, { left: 0.1665, right: 0.1665, top: 0, bottom: 0 })
    assert.deepEqual(square, { width: 667, height: 667 })
    assert.deepEqual(fitWidth(square, 350), { width: 350, height: 350 })
  })
})

describe('fitWidth', () => {
  it('scales down to the maximum width and never up', () => {
    assert.deepEqual(fitWidth({ width: 1000, height: 667 }, 500), { width: 500, height: 334 })
    assert.deepEqual(fitWidth({ width: 400, height: 300 }, 500), { width: 400, height: 300 })
  })

  it('never asks for a height of zero', () => {
    assert.deepEqual(fitWidth({ width: 4000, height: 1 }, 800), { width: 800, height: 1 })
  })
})

describe('sizedTo', () => {
  /** The rect @sanity/image-url puts in the URL (the whole image when it adds none). */
  function rect(url: string, whole: { width: number; height: number }) {
    const value = new URL(url).searchParams.get('rect')
    if (!value) return { left: 0, top: 0, ...whole }
    const [left, top, width, height] = value.split(',').map(Number)
    return { left: left!, top: top!, width: width!, height: height! }
  }

  const assets = [
    ASSET,
    // Sizes from the review: a photo, a wide screenshot and a tall phone screenshot.
    'image-02b16b06-2194x1646-jpg',
    'image-8eee92c9-2062x1032-png',
    'image-c0d3fe71-1284x2778-png',
  ]
  const crops = [
    undefined,
    { top: 0.5, bottom: 0.001, left: 0.07, right: 0.61 },
    { top: 0.1, bottom: 0.2, left: 0.05, right: 0.3 },
    { top: 0.333, bottom: 0.111, left: 0.4449, right: 0.0051 },
    { top: 0, bottom: 0.9, left: 0, right: 0 },
  ]
  const hotspots = [undefined, { x: 0.2, y: 0.8, width: 0.1, height: 0.1 }]

  it('asks for exactly the fitWidth size and stays inside the crop without distorting it', () => {
    let checked = 0
    for (const assetRef of assets) {
      const whole = assetDimensions(assetRef)
      for (const crop of crops) {
        for (const hotspot of hotspots) {
          const image = { _type: 'image', asset: { _ref: assetRef, _type: 'reference' }, crop, hotspot }
          const cropped = croppedDimensions(assetRef, crop)
          const cropRect = { ...rect(builder.image({ ...image, hotspot: undefined }).url(), whole), ...cropped }
          for (const maxWidth of [97, 120, 350, 600, 800, 960, 1000, 1600]) {
            const size = fitWidth(cropped, maxWidth)
            const url = sizedTo(builder.image(image), size).auto('format').url()
            const params = new URL(url).searchParams
            const label = `${assetRef} ${JSON.stringify(crop)} ${JSON.stringify(hotspot)} ${maxWidth}`
            assert.equal(params.get('w'), String(size.width), label)
            assert.equal(params.get('h'), String(size.height), label)
            assert.equal(params.get('fit'), 'crop', label)

            const r = rect(url, whole)
            // Inside the editor's crop.
            assert.ok(r.left >= cropRect.left && r.top >= cropRect.top, label)
            assert.ok(r.left + r.width <= cropRect.left + cropRect.width, label)
            assert.ok(r.top + r.height <= cropRect.top + cropRect.height, label)
            // Same aspect ratio as the requested size, to within one source pixel: no distortion.
            const fitsWidth = Math.abs(r.width - (r.height * size.width) / size.height) <= 1
            const fitsHeight = Math.abs(r.height - (r.width * size.height) / size.width) <= 1
            assert.ok(fitsWidth || fitsHeight, label)
            // It only loses the rounding of the height to whole pixels (plus one source pixel).
            const lost = 0.5 / (size.height - 0.5)
            assert.ok((cropped.width - r.width) / cropped.width <= lost + 1 / cropped.width, label)
            assert.ok((cropped.height - r.height) / cropped.height <= lost + 1 / cropped.height, label)
            if (cropped.width <= maxWidth) {
              // Never scaled up: the crop itself, at its own size.
              assert.deepEqual(size, cropped, label)
              assert.deepEqual({ width: r.width, height: r.height }, cropped, label)
            }
            checked++
          }
        }
      }
    }
    assert.equal(checked, assets.length * crops.length * hotspots.length * 8)
  })
})
