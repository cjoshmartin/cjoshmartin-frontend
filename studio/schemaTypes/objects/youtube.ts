import {PlayIcon} from '@sanity/icons/Play'
import {defineField, defineType} from 'sanity'

import {getYouTubeVideoId, validateYouTubeUrl} from '../shared/validation'

/** YouTube embed, from Wagtail `<embed embedtype="media">` and `youtube_video` hero blocks. */
export const youtube = defineType({
  name: 'youtube',
  title: 'YouTube video',
  type: 'object',
  icon: PlayIcon,
  fields: [
    defineField({
      name: 'url',
      title: 'URL',
      type: 'url',
      description: 'Any YouTube video link: watch, youtu.be, live or shorts.',
      validation: (rule) =>
        rule
          .required()
          .uri({scheme: ['http', 'https']})
          .custom(validateYouTubeUrl),
    }),
  ],
  preview: {
    select: {url: 'url'},
    prepare({url}) {
      const id = typeof url === 'string' ? getYouTubeVideoId(url) : null
      return {
        title: url || 'YouTube video',
        subtitle: id ? `YouTube · ${id}` : 'YouTube',
        media: PlayIcon,
      }
    },
  },
})
