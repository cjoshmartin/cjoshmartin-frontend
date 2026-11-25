import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createImageUrlBuilder } from '@sanity/image-url'

import { assetDimensions, croppedDimensions, fitWidth } from '../sanity/lib/imageDimensions.ts'

const ASSET = 'image-5893cbb9d6a1b3a0e8f6f1c4e1f1b6a1c3d2e4f5-1000x667-jpg'
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
})
