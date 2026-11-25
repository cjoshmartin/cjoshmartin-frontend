import {CaseIcon} from '@sanity/icons/Case'
import {defineField, defineType} from 'sanity'

import {AUDIENCE_OPTIONS} from '../constants'
import {altField} from '../shared/alt-field'
import {audienceField, GROUPS, legacyField} from '../shared/fields'

/** Service card on the home page (Wagtail `home.Service`). */
export const service = defineType({
  name: 'service',
  title: 'Service',
  type: 'document',
  icon: CaseIcon,
  groups: [GROUPS.content, GROUPS.migration],
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      group: GROUPS.content.name,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'image',
      type: 'image',
      group: GROUPS.content.name,
      options: {hotspot: true},
      fields: [altField()],
    }),
    defineField({name: 'description', type: 'blockContent', group: GROUPS.content.name}),
    defineField({
      name: 'link',
      type: 'url',
      group: GROUPS.content.name,
      description: 'Optional. When set, the whole card links here.',
      validation: (rule) => rule.uri({allowRelative: true, scheme: ['http', 'https']}),
    }),
    defineField({
      name: 'linkText',
      title: 'Link text',
      type: 'string',
      group: GROUPS.content.name,
      description: 'Label for the link.',
      validation: (rule) =>
        rule
          .custom((value, context) => {
            const link = (context.parent as {link?: string} | undefined)?.link
            return link && !value?.trim() ? 'Add a label for the link' : true
          })
          .warning(),
    }),
    audienceField(GROUPS.content.name),
    legacyField(),
  ],
  preview: {
    select: {title: 'title', audience: 'audience', media: 'image'},
    prepare({title, audience, media}) {
      return {
        title: title || 'Untitled service',
        subtitle: AUDIENCE_OPTIONS.find((option) => option.value === audience)?.title,
        media,
      }
    },
  },
})
