import {VideoIcon} from '@sanity/icons/Video'
import {defineField, defineType} from 'sanity'

/**
 * Video hosted on Mux. `asset` is the `mux.video` object from sanity-plugin-mux-input, which holds
 * a weak reference to a `mux.videoAsset` document (see docs/sanity-migration/schema-contract.md).
 */
export const video = defineType({
  name: 'video',
  type: 'object',
  icon: VideoIcon,
  fields: [
    defineField({
      name: 'asset',
      title: 'Video',
      type: 'mux.video',
      options: {acceptedMimeTypes: ['video/*']},
      // The custom rule also runs when the field is empty, so it doubles as the required check.
      validation: (rule) =>
        rule.custom((value: {asset?: {_ref?: string}} | undefined) =>
          value?.asset?._ref ? true : 'Upload or select a video',
        ),
    }),
  ],
  preview: {
    select: {
      filename: 'asset.asset.filename',
      status: 'asset.asset.status',
      playbackId: 'asset.asset.playbackId',
    },
    prepare({filename, status, playbackId}) {
      return {
        title: filename || playbackId || 'Video',
        subtitle: status ? `Mux · ${status}` : 'Mux',
        media: VideoIcon,
      }
    },
  },
})
