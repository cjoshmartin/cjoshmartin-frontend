import {HomeIcon} from '@sanity/icons/Home'
import {defineArrayMember, defineField, defineType} from 'sanity'

import {GROUPS, legacyField, seoField} from '../shared/fields'

/**
 * The home page. A singleton with the fixed `_id` "homePage": sanity.config.ts registers it in
 * `document.singletons` and removes its create, duplicate, delete and unpublish actions.
 */
export const homePage = defineType({
  name: 'homePage',
  title: 'Home',
  type: 'document',
  icon: HomeIcon,
  groups: [GROUPS.content, GROUPS.seo, GROUPS.migration],
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      group: GROUPS.content.name,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'bio',
      type: 'blockContent',
      group: GROUPS.content.name,
      description: 'Intro text next to the profile photo.',
    }),
    defineField({
      name: 'author',
      type: 'reference',
      to: [{type: 'person'}],
      group: GROUPS.content.name,
      description: 'Whose photo, name, job title, location and links the home page shows.',
    }),
    defineField({
      name: 'testimonials',
      type: 'array',
      group: GROUPS.content.name,
      description: 'Rotated on the home page. Order is kept.',
      of: [defineArrayMember({type: 'reference', to: [{type: 'testimonial'}]})],
      validation: (rule) => rule.unique(),
    }),
    defineField({
      name: 'services',
      type: 'array',
      group: GROUPS.content.name,
      description: 'Service cards, in this order. Each card shows only for its own audience.',
      of: [defineArrayMember({type: 'reference', to: [{type: 'service'}]})],
      validation: (rule) => rule.unique(),
    }),
    seoField(),
    legacyField(),
  ],
  preview: {
    select: {title: 'title'},
    prepare({title}) {
      return {title: title || 'Home', subtitle: '/'}
    },
  },
})
