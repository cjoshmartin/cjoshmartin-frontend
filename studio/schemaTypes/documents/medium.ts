import {TagIcon} from '@sanity/icons/Tag'
import {defineType} from 'sanity'

import {TAG_ORDERINGS, tagFields} from '../shared/tag-fields'

/** Project medium tag, for example Web, Mobile or 3D printing (Wagtail taggit `medium`). */
export const medium = defineType({
  name: 'medium',
  title: 'Medium',
  type: 'document',
  icon: TagIcon,
  fields: tagFields('medium'),
  orderings: TAG_ORDERINGS,
  preview: {select: {title: 'title', subtitle: 'slug.current'}},
})
