import {CodeIcon} from '@sanity/icons/Code'
import {defineType} from 'sanity'

import {TAG_ORDERINGS, tagFields} from '../shared/tag-fields'

/** Project technology tag, for example Next.JS or Arduino (Wagtail taggit `technologies`). */
export const technology = defineType({
  name: 'technology',
  title: 'Technology',
  type: 'document',
  icon: CodeIcon,
  fields: tagFields('technology'),
  orderings: TAG_ORDERINGS,
  preview: {select: {title: 'title', subtitle: 'slug.current'}},
})
