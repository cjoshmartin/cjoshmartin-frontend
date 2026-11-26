/**
 * The Studio side of image privacy (schemaTypes/shared/image-privacy.ts): the options every image
 * field gets, the formats it accepts, and what the status line and the validation say.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {ACCEPTED_IMAGE_MIME_TYPES, IMAGE_STRIP_VERSION} from '../functions/privacy/constants'
import {
  imageFormatProblem,
  imagePrivacyLabel,
  imagePrivacyState,
  imagePrivacyWarning,
  PRIVATE_IMAGE_OPTIONS,
} from '../schemaTypes/shared/image-privacy'

describe('PRIVATE_IMAGE_OPTIONS', () => {
  it('never extracts EXIF, camera or location data and accepts only strippable formats', () => {
    assert.deepEqual(PRIVATE_IMAGE_OPTIONS.metadata, ['blurhash', 'thumbhash', 'lqip', 'palette'])
    assert.equal(PRIVATE_IMAGE_OPTIONS.hotspot, true)
    assert.equal(PRIVATE_IMAGE_OPTIONS.accept, 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/tiff')
  })
})

describe('imageFormatProblem', () => {
  it('accepts the strippable formats and explains the others', () => {
    for (const type of ACCEPTED_IMAGE_MIME_TYPES) assert.equal(imageFormatProblem(type), null)
    assert.match(imageFormatProblem('image/svg+xml') ?? '', /image\/svg\+xml.*cannot be used.*Upload it as JPEG, PNG, WebP, GIF, AVIF or TIFF/)
    assert.match(imageFormatProblem('image/heic') ?? '', /cannot be used/)
    assert.match(imageFormatProblem(undefined) ?? '', /unknown/)
  })
})

describe('imagePrivacyState, label and warning', () => {
  const v = IMAGE_STRIP_VERSION
  it('says nothing about old unchecked or clean images', () => {
    assert.deepEqual(imagePrivacyState(undefined), {kind: 'unchecked'})
    assert.equal(imagePrivacyLabel({kind: 'unchecked'}, false), null)
    assert.equal(imagePrivacyLabel(imagePrivacyState({status: 'clean', version: v}), true), null)
    assert.equal(imagePrivacyWarning(imagePrivacyState({status: 'clean', version: v})), null)
  })
  it('shows progress and the result', () => {
    assert.match(imagePrivacyLabel({kind: 'unchecked'}, true)?.text ?? '', /Checking/)
    assert.match(imagePrivacyLabel(imagePrivacyState({status: 'processing'}), true)?.text ?? '', /Removing location/)
    assert.equal(imagePrivacyLabel(imagePrivacyState({status: 'stripped', version: v}), false)?.tone, 'positive')
    assert.equal(imagePrivacyLabel(imagePrivacyState({status: 'replaced', version: v}), false)?.tone, 'caution')
  })
  it('warns about failures and retries', () => {
    const failed = imagePrivacyState({status: 'failed', version: v, message: 'BigTIFF is not supported.'})
    assert.deepEqual(failed, {kind: 'failed', message: 'BigTIFF is not supported.'})
    assert.match(imagePrivacyWarning(failed) ?? '', /could not be removed from this image: BigTIFF is not supported\. Replace it/)
    assert.equal(imagePrivacyLabel(failed, false)?.tone, 'critical')
    const pending = imagePrivacyState({status: 'pending', version: v, message: 'HTTP 503'})
    assert.match(imagePrivacyWarning(pending) ?? '', /waiting to be retried: HTTP 503/)
    // A failure under another stripper version is checked again, so it is not shown as final.
    assert.deepEqual(imagePrivacyState({status: 'failed', version: 'image-strip-v0'}), {kind: 'unchecked'})
  })
})
