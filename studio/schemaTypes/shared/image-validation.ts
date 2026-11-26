import type {ImageRule, ValidationContext} from 'sanity'

import type {AssetPrivacy} from '../../functions/privacy/constants'
import {API_VERSION} from '../../lib/constants'
import {imageFormatProblem, imagePrivacyState, imagePrivacyWarning} from './image-privacy'

interface ImageValueLike {
  asset?: {_ref?: string}
}

async function assetInfo(value: ImageValueLike | undefined, context: ValidationContext) {
  const assetId = value?.asset?._ref
  if (!assetId) return null
  return context
    .getClient({apiVersion: API_VERSION})
    .fetch<{mimeType?: string; privacy?: AssetPrivacy} | null>(
      '*[_id == $assetId][0]{mimeType, privacy}',
      {assetId},
      {tag: 'validation.image-privacy'},
    )
}

/**
 * Validation of every image field and type: an error for a format whose metadata cannot be removed
 * losslessly (an SVG or HEIC picked from the media browser, for example), and a warning while the
 * image-privacy Function could not remove the location and camera data yet.
 */
export function privateImageValidation(rule: ImageRule): ImageRule[] {
  return [
    rule
      .custom(async (value, context) => {
        const info = await assetInfo(value as ImageValueLike | undefined, context)
        if (!info) return true
        return imageFormatProblem(info.mimeType) ?? true
      })
      .error(),
    rule
      .custom(async (value, context) => {
        const info = await assetInfo(value as ImageValueLike | undefined, context)
        if (!info) return true
        return imagePrivacyWarning(imagePrivacyState(info.privacy)) ?? true
      })
      .warning(),
  ]
}
