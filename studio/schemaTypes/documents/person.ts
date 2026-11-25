import {UserIcon} from '@sanity/icons/User'
import {defineField, defineType} from 'sanity'

import {altField} from '../shared/alt-field'
import {GROUPS, legacyField} from '../shared/fields'

/** Author of posts and the person shown on the home page (Wagtail `home.Author`). */
export const person = defineType({
  name: 'person',
  title: 'Person',
  type: 'document',
  icon: UserIcon,
  groups: [GROUPS.content, GROUPS.migration],
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
      options: {hotspot: true},
      fields: [altField()],
    }),
    defineField({name: 'location', type: 'string', group: GROUPS.content.name}),
    defineField({name: 'jobTitle', type: 'string', group: GROUPS.content.name}),
    defineField({name: 'bio', type: 'blockContent', group: GROUPS.content.name}),
    defineField({
      name: 'email',
      type: 'string',
      group: GROUPS.content.name,
      validation: (rule) => rule.email(),
    }),
    defineField({
      name: 'github',
      title: 'GitHub',
      type: 'url',
      group: GROUPS.content.name,
      validation: (rule) => rule.uri({scheme: ['http', 'https']}),
    }),
    legacyField(),
  ],
  preview: {
    select: {firstName: 'firstName', lastName: 'lastName', jobTitle: 'jobTitle', media: 'image'},
    prepare({firstName, lastName, jobTitle, media}) {
      return {
        title: [firstName, lastName].filter(Boolean).join(' ') || 'Unnamed person',
        subtitle: jobTitle,
        media,
      }
    },
  },
})
