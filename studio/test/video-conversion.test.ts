/**
 * The video block's conversion state (schemaTypes/shared/video-conversion.ts): the contract's
 * "needs conversion" rule and the status line the Studio preview shows.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  videoConversionLabel,
  videoConversionState,
  videoNeedsConversion,
  type VideoValue,
} from '../schemaTypes/shared/video-conversion'

const ORIGINAL = 'file-1111111111111111111111111111111111111111-mov'
const MP4 = 'file-2222222222222222222222222222222222222222-mp4'
const REPLACEMENT = 'file-3333333333333333333333333333333333333333-webm'

const file = (ref: string) => ({_type: 'file', asset: {_type: 'reference', _ref: ref}})

describe('videoNeedsConversion', () => {
  it('is false without a file', () => {
    assert.equal(videoNeedsConversion(undefined), false)
    assert.equal(videoNeedsConversion({}), false)
    assert.equal(videoNeedsConversion({file: {}}), false)
  })

  it('is true for a new upload that has not been converted', () => {
    assert.equal(videoNeedsConversion({file: file(ORIGINAL)}), true)
    assert.equal(
      videoNeedsConversion({
        file: file(ORIGINAL),
        conversion: {status: 'processing', sourceAssetId: ORIGINAL},
      }),
      true,
    )
  })

  it('is false once file points at the converted MP4', () => {
    const converted: VideoValue = {
      file: file(MP4),
      original: file(ORIGINAL),
      conversion: {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4},
    }
    assert.equal(videoNeedsConversion(converted), false)
  })

  it('is true again when the editor replaces a converted video', () => {
    assert.equal(
      videoNeedsConversion({
        file: file(REPLACEMENT),
        original: file(ORIGINAL),
        conversion: {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4},
      }),
      true,
    )
  })
})

describe('videoConversionState and videoConversionLabel', () => {
  const label = (fileAssetId: string | undefined, conversion?: VideoValue['conversion']) =>
    videoConversionLabel(videoConversionState(fileAssetId, conversion))

  it('shows that there is no file', () => {
    assert.equal(label(undefined), 'No video file')
  })

  it('shows "Converting to MP4..." while the file waits for or is in conversion', () => {
    assert.equal(label(ORIGINAL), 'Converting to MP4...')
    assert.equal(
      label(ORIGINAL, {status: 'pending', sourceAssetId: ORIGINAL}),
      'Converting to MP4...',
    )
    assert.equal(
      label(ORIGINAL, {status: 'processing', sourceAssetId: ORIGINAL}),
      'Converting to MP4...',
    )
  })

  it('shows "Ready" when file is the converted MP4', () => {
    assert.equal(
      label(MP4, {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4}),
      'Ready',
    )
  })

  it('shows the failure message for the current file', () => {
    assert.equal(
      label(ORIGINAL, {
        status: 'failed',
        sourceAssetId: ORIGINAL,
        message: 'ffmpeg exited with code 1',
      }),
      'Conversion failed: ffmpeg exited with code 1',
    )
    assert.equal(
      label(ORIGINAL, {status: 'failed', sourceAssetId: ORIGINAL, message: '  '}),
      'Conversion failed: no error message was recorded',
    )
  })

  it('ignores a failure or a ready MP4 that belongs to a file the editor has since replaced', () => {
    assert.equal(
      label(REPLACEMENT, {status: 'failed', sourceAssetId: ORIGINAL, message: 'old error'}),
      'Converting to MP4...',
    )
    assert.equal(
      label(REPLACEMENT, {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4}),
      'Converting to MP4...',
    )
  })
})
