import {ProjectsIcon} from '@sanity/icons/Projects'
import {defineArrayMember, defineField, defineType} from 'sanity'

import {DEFAULT_PROJECT_TYPE, PROJECT_TYPE_OPTIONS} from '../constants'
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

/**
 * Portfolio project at /projects/<slug> (Wagtail `blog.ProjectPage`, which extends BlogPage).
 * Has every blog post field plus the project fields.
 */
export const project = defineType({
  name: 'project',
  title: 'Project',
  type: 'document',
  icon: ProjectsIcon,
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
    defineField({
      name: 'previewImage',
      title: 'Preview image',
      type: 'imageWithAlt',
      group: GROUPS.media.name,
      description: 'Listing thumbnail when there is no content image.',
    }),
    defineField({
      name: 'projectType',
      title: 'Project type',
      type: 'string',
      group: GROUPS.details.name,
      options: {list: [...PROJECT_TYPE_OPTIONS], layout: 'radio', direction: 'horizontal'},
      initialValue: DEFAULT_PROJECT_TYPE,
      validation: (rule) => rule.required(),
    }),
    postAudienceField(),
    isUnlistedField(),
    defineField({name: 'client', type: 'string', group: GROUPS.details.name}),
    defineField({
      name: 'website',
      type: 'url',
      group: GROUPS.details.name,
      description: 'If the project has no body, its card links straight to this site.',
      validation: (rule) => rule.uri({scheme: ['http', 'https']}),
    }),
    defineField({
      name: 'mediums',
      type: 'array',
      group: GROUPS.details.name,
      of: [defineArrayMember({type: 'reference', to: [{type: 'medium'}]})],
      validation: (rule) => rule.unique(),
    }),
    defineField({
      name: 'technologies',
      type: 'array',
      group: GROUPS.details.name,
      of: [defineArrayMember({type: 'reference', to: [{type: 'technology'}]})],
      validation: (rule) => rule.unique(),
    }),
    defineField({
      name: 'testimonials',
      type: 'array',
      group: GROUPS.details.name,
      description: 'Shown on the project page and on /screen. Order is kept.',
      of: [defineArrayMember({type: 'reference', to: [{type: 'testimonial'}]})],
      validation: (rule) => rule.unique(),
    }),
    seoField(),
    legacyField(),
  ],
  orderings: POST_ORDERINGS,
  preview: {
    select: {
      title: 'title',
      date: 'date',
      isUnlisted: 'isUnlisted',
      projectType: 'projectType',
      contentImage: 'contentImage',
      previewImage: 'previewImage',
      firstHeroMedia: 'heroMedia.0',
    },
    prepare({projectType, previewImage, ...selection}) {
      return preparePostPreview(
        selection,
        PROJECT_TYPE_OPTIONS.find((option) => option.value === projectType)?.title,
        previewImage,
      )
    },
  },
})
