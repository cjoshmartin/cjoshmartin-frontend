import {VideoIcon} from '@sanity/icons/Video'
import {defineField, defineType, type ValidationContext} from 'sanity'

import {SETTINGS_VERSION} from '../../functions/video-to-mp4/settings'
import {API_VERSION} from '../../lib/constants'
import {VIDEO_CONVERSION_STATUSES} from '../constants'
import {
  videoConversionState,
  videoOriginalState,
  videoPreviewSubtitle,
  type FileValue,
  type VideoValue,
} from '../shared/video-conversion'

/**
 * `file` must reference a file asset whose MIME type is video/*. The type is read from the asset
 * document, because the asset id only carries the file extension.
 */
async function validateVideoFile(value: FileValue | undefined, context: ValidationContext) {
  const assetId = value?.asset?._ref
  if (!assetId) return 'Upload or select a video'
  const asset = await context
    .getClient({apiVersion: API_VERSION})
    .fetch<{mimeType?: string} | null>(
      '*[_id == $assetId][0]{mimeType}',
      {assetId},
      {tag: 'validation.video-mime-type'},
    )
  if (!asset) return 'The selected file no longer exists. Upload the video again.'
  if (!asset.mimeType?.startsWith('video/')) {
    return `Only video files can be used here (this file is ${asset.mimeType || 'of an unknown type'})`
  }
  return true
}

/**
 * Video stored in Sanity as a file asset (video contract v2, see
 * docs/sanity-migration/schema-contract.md). Every upload is converted to MP4 with the settings in
 * functions/video-to-mp4/settings.ts: the converter points `file` at the MP4, keeps the upload in
 * `original` and records its progress in `conversion`. The site only ever plays `file`.
 * While a document is open in the Studio, ../../components/VideoConversionWatcher.tsx (the
 * document form's root input) restarts the conversion of a stuck block.
 */
export const video = defineType({
  name: 'video',
  title: 'Video',
  type: 'object',
  icon: VideoIcon,
  fields: [
    defineField({
      name: 'file',
      title: 'Video file',
      type: 'file',
      description:
        'Upload any video. It is converted to MP4 automatically; this field then holds the MP4 the site plays, and your upload is kept under "Original upload".',
      options: {accept: 'video/*'},
      // The custom rule also runs when the field is empty, so it doubles as the required check.
      validation: (rule) => rule.custom(validateVideoFile),
    }),
    defineField({
      name: 'original',
      title: 'Original upload',
      type: 'file',
      description:
        'The uploaded file, kept for reference without its location and personal metadata (same video and audio). The site never serves it.',
      readOnly: true,
      hidden: ({value}) => !(value as FileValue | undefined)?.asset?._ref,
    }),
    defineField({
      name: 'conversion',
      title: 'MP4 conversion',
      type: 'object',
      description: 'Written by the MP4 converter.',
      readOnly: true,
      options: {collapsible: true, collapsed: true},
      fields: [
        defineField({
          name: 'status',
          type: 'string',
          options: {list: [...VIDEO_CONVERSION_STATUSES]},
        }),
        defineField({
          name: 'message',
          type: 'string',
          description: 'Why the conversion failed, or other details from the converter.',
        }),
        defineField({
          name: 'sourceAssetId',
          title: 'Source asset id',
          type: 'string',
          description: 'The uploaded file that was converted.',
        }),
        defineField({
          name: 'outputAssetId',
          title: 'Output asset id',
          type: 'string',
          description: 'The MP4 it produced.',
        }),
        defineField({
          name: 'settingsVersion',
          title: 'Settings version',
          type: 'string',
        }),
        defineField({
          name: 'originalStripped',
          title: 'Original without location data',
          type: 'boolean',
          description:
            'Whether "Original upload" is a copy without location and personal metadata (the unstripped upload is deleted).',
        }),
        defineField({
          name: 'stripVersion',
          title: 'Strip version',
          type: 'string',
        }),
        defineField({
          name: 'updatedAt',
          title: 'Updated at',
          type: 'datetime',
        }),
      ],
    }),
  ],
  // A failed conversion leaves the original upload in `file`. The site never plays a file that is
  // not the converted MP4, so publishing would show no video: an error, so the editor replaces the
  // file or removes the block. A conversion that is still running or waiting to retry is not an
  // error; the converter writes the result to the published document too. A failure under older
  // settings is retried with the current ones, so it waits too (videoConversionState).
  validation: (rule) =>
    rule.custom((value: VideoValue | undefined) => {
      const state = videoConversionState(
        value?.file?.asset?._ref,
        value?.conversion,
        SETTINGS_VERSION,
      )
      return state.kind === 'failed'
        ? `MP4 conversion failed: ${state.message}. Upload another file or remove the video.`
        : true
    }),
  preview: {
    select: {
      filename: 'file.asset.originalFilename',
      fileAssetId: 'file.asset._id',
      status: 'conversion.status',
      message: 'conversion.message',
      sourceAssetId: 'conversion.sourceAssetId',
      outputAssetId: 'conversion.outputAssetId',
      settingsVersion: 'conversion.settingsVersion',
      originalStripped: 'conversion.originalStripped',
      originalAssetId: 'original.asset._ref',
      originalPrivacyStatus: 'original.asset.privacy.status',
    },
    prepare({
      filename,
      fileAssetId,
      status,
      message,
      sourceAssetId,
      outputAssetId,
      settingsVersion,
      originalStripped,
      originalAssetId,
      originalPrivacyStatus,
    }) {
      const conversion = {status, message, sourceAssetId, outputAssetId, settingsVersion, originalStripped}
      const state = videoConversionState(fileAssetId, conversion, SETTINGS_VERSION)
      return {
        title: filename || 'Video',
        subtitle: videoPreviewSubtitle(state, videoOriginalState(conversion, originalAssetId, originalPrivacyStatus)),
        media: VideoIcon,
      }
    },
  },
})
