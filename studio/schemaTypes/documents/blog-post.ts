import {DocumentTextIcon} from '@sanity/icons/DocumentText'
import {defineType} from 'sanity'

import {GROUPS, legacyField, seoField, slugField} from '../shared/fields'
import {
  authorField,
  bodyField,
  contentImageField,
  dateField,
  heroMediaField,
  introField,
  isUnlistedField,
  POST_ORDERINGS,
  postAudienceField,
  preparePostPreview,
  titleField,
} from '../shared/post-fields'

/** Blog post at /blog/<slug> (Wagtail `blog.BlogPage`). */
export const blogPost = defineType({
  name: 'blogPost',
  title: 'Blog post',
  type: 'document',
  icon: DocumentTextIcon,
  groups: [GROUPS.content, GROUPS.media, GROUPS.details, GROUPS.seo, GROUPS.migration],
  fields: [
    titleField(),
    slugField(GROUPS.content.name),
    dateField(),
    introField(),
    authorField(),
    bodyField(),
    heroMediaField(),
    contentImageField(),
    postAudienceField(),
    isUnlistedField(),
    seoField(),
    legacyField(),
  ],
  orderings: POST_ORDERINGS,
  preview: {
    select: {
      title: 'title',
      date: 'date',
      isUnlisted: 'isUnlisted',
      contentImage: 'contentImage',
      firstHeroMedia: 'heroMedia.0',
    },
    prepare: (selection) => preparePostPreview(selection),
  },
})
