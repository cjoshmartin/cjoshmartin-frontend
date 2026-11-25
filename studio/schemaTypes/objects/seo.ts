import {SearchIcon} from '@sanity/icons/Search'
import {defineField, defineType} from 'sanity'

/** Replaces Wagtail's `seo_title` and `search_description`. Both are optional overrides. */
export const seo = defineType({
  name: 'seo',
  title: 'SEO',
  type: 'object',
  icon: SearchIcon,
  options: {collapsible: true, collapsed: false},
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      description: 'Overrides the page title in search results and link previews.',
      validation: (rule) =>
        rule.max(70).warning('Search engines usually cut titles longer than about 70 characters'),
    }),
    defineField({
      name: 'description',
      type: 'text',
      rows: 3,
      description:
        'Meta description for search results and link previews. Falls back to the intro when empty.',
      validation: (rule) =>
        rule
          .max(160)
          .warning('Search engines usually cut descriptions longer than about 160 characters'),
    }),
  ],
})
