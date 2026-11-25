import {ArchiveIcon} from '@sanity/icons/Archive'
import {defineField, defineType} from 'sanity'

/**
 * Where a document came from in Wagtail. Written by the migration and kept permanently for
 * Disqus (`wagtailId` is the thread identifier of migrated pages), QA and debugging.
 */
export const legacy = defineType({
  name: 'legacy',
  title: 'Wagtail origin',
  type: 'object',
  icon: ArchiveIcon,
  readOnly: true,
  fields: [
    defineField({
      name: 'wagtailId',
      title: 'Wagtail ID',
      type: 'number',
      description: 'Wagtail page or snippet id. Used as the Disqus thread identifier.',
    }),
    defineField({
      name: 'wagtailType',
      title: 'Wagtail model',
      type: 'string',
      description: 'For example blog.BlogPage or home.Testimonial.',
    }),
    defineField({
      name: 'wagtailUrlPath',
      title: 'Wagtail URL path',
      type: 'string',
      description: 'Path of the page in the Wagtail page tree. Empty for snippets.',
    }),
    defineField({
      name: 'firstPublishedAt',
      title: 'First published in Wagtail',
      type: 'datetime',
    }),
    defineField({
      name: 'lastPublishedAt',
      title: 'Last published in Wagtail',
      type: 'datetime',
    }),
  ],
})
