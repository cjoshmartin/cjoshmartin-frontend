import {CommentIcon} from '@sanity/icons/Comment'
import {TerminalIcon} from '@sanity/icons/Terminal'
import {defineField, defineType} from 'sanity'

import {altField} from '../shared/alt-field'
import {GROUPS, legacyField} from '../shared/fields'

const ASCII_ART_GROUP = {name: 'asciiArt', title: 'ASCII art', icon: TerminalIcon}

/** Testimonial shown on the home page, on projects and on /screen (Wagtail `home.Testimonial`). */
export const testimonial = defineType({
  name: 'testimonial',
  title: 'Testimonial',
  type: 'document',
  icon: CommentIcon,
  groups: [GROUPS.content, ASCII_ART_GROUP, GROUPS.migration],
  fields: [
    defineField({
      name: 'firstName',
      type: 'string',
      group: GROUPS.content.name,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'lastName',
      type: 'string',
      group: GROUPS.content.name,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'image',
      type: 'image',
      group: GROUPS.content.name,
      description: 'Photo. The ASCII art is generated from it automatically.',
      options: {hotspot: true},
      fields: [altField()],
      validation: (rule) =>
        rule
          .custom((value) =>
            value?.asset ? true : 'Add a photo: the home page shows ASCII art generated from it',
          )
          .warning(),
    }),
    defineField({name: 'jobTitle', type: 'string', group: GROUPS.content.name}),
    defineField({
      name: 'relationship',
      type: 'string',
      group: GROUPS.content.name,
      description: 'How you know each other, for example "Managed Josh at Acme".',
    }),
    defineField({
      name: 'link',
      type: 'url',
      group: GROUPS.content.name,
      description: 'Profile link, for example LinkedIn.',
      validation: (rule) => rule.uri({scheme: ['http', 'https']}),
    }),
    defineField({name: 'body', type: 'blockContent', group: GROUPS.content.name}),
    defineField({
      name: 'asciiArt',
      title: 'ASCII art',
      type: 'text',
      group: ASCII_ART_GROUP.name,
      rows: 12,
      readOnly: true,
      description:
        'Generated from the photo by the testimonial-ascii-art Sanity Function: HTML of colored <span> characters and <br> line breaks. Do not edit; change the photo instead.',
    }),
    defineField({
      name: 'asciiArtSource',
      title: 'ASCII art source',
      type: 'string',
      group: ASCII_ART_GROUP.name,
      readOnly: true,
      description:
        'Image asset _id the ASCII art was generated from. When it differs from the current photo, the art is regenerated.',
    }),
    legacyField(),
  ],
  preview: {
    select: {
      firstName: 'firstName',
      lastName: 'lastName',
      jobTitle: 'jobTitle',
      relationship: 'relationship',
      media: 'image',
    },
    prepare({firstName, lastName, jobTitle, relationship, media}) {
      return {
        title: [firstName, lastName].filter(Boolean).join(' ') || 'Unnamed testimonial',
        subtitle: jobTitle || relationship,
        media,
      }
    },
  },
})
