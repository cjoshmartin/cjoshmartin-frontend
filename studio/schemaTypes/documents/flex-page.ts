import {DocumentIcon} from '@sanity/icons/Document'
import {defineField, defineType} from 'sanity'

import {GROUPS, legacyField, seoField, slugField} from '../shared/fields'

/** Free-form page at /flex/<slug> (Wagtail `flex.FlexPage`). Not listed in the sitemap. */
export const flexPage = defineType({
  name: 'flexPage',
  title: 'Flex page',
  type: 'document',
  icon: DocumentIcon,
  groups: [GROUPS.content, GROUPS.seo, GROUPS.migration],
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      group: GROUPS.content.name,
      validation: (rule) => rule.required(),
    }),
    slugField(GROUPS.content.name),
    defineField({name: 'body', type: 'blockContent', group: GROUPS.content.name}),
    seoField(),
    legacyField(),
  ],
  preview: {
    select: {title: 'title', slug: 'slug.current'},
    prepare({title, slug}) {
      return {title: title || 'Untitled', subtitle: slug ? `/flex/${slug}` : 'No slug yet'}
    },
  },
})
