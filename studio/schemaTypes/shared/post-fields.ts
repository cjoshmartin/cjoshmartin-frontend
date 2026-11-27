import {defineArrayMember, defineField, type PreviewValue} from 'sanity'

import {audienceField, GROUPS} from './fields'

/**
 * Fields shared by `blogPost` and `project` (Wagtail's ProjectPage extends BlogPage, so a project
 * has every blog post field). Each factory returns a fresh definition.
 */

export function titleField() {
  return defineField({
    name: 'title',
    type: 'string',
    group: GROUPS.content.name,
    validation: (rule) => rule.required(),
  })
}

export function dateField() {
  return defineField({
    name: 'date',
    type: 'date',
    group: GROUPS.content.name,
    description: 'Post date. Lists are sorted by it, newest first.',
    options: {dateFormat: 'YYYY-MM-DD'},
    initialValue: () => new Date().toISOString().slice(0, 10),
    validation: (rule) => rule.required(),
  })
}

export function introField() {
  return defineField({
    name: 'intro',
    type: 'string',
    group: GROUPS.content.name,
    description:
      'One or two sentences shown on listing cards. Also the meta description when SEO description is empty.',
    validation: (rule) => rule.required().max(250),
  })
}

export function authorField() {
  return defineField({
    name: 'author',
    type: 'reference',
    to: [{type: 'person'}],
    group: GROUPS.content.name,
  })
}

export function bodyField() {
  return defineField({
    name: 'body',
    type: 'blockContent',
    group: GROUPS.content.name,
  })
}

export function heroMediaField() {
  return defineField({
    name: 'heroMedia',
    title: 'Hero media',
    type: 'array',
    group: GROUPS.media.name,
    description:
      'Shown at the top of the page. The first image is the last fallback for the listing thumbnail.',
    of: [defineArrayMember({type: 'imageWithAlt'}), defineArrayMember({type: 'youtube'})],
  })
}

export function contentImageField() {
  return defineField({
    name: 'contentImage',
    title: 'Content image',
    type: 'imageWithAlt',
    group: GROUPS.media.name,
    description: 'Listing thumbnail and social sharing image.',
  })
}

export function postAudienceField() {
  return audienceField(GROUPS.details.name)
}

export function isUnlistedField() {
  return defineField({
    name: 'isUnlisted',
    title: 'Unlisted',
    type: 'boolean',
    group: GROUPS.details.name,
    description:
      'Hides it from lists, recommendations, /screen and the sitemap. The page stays reachable by its URL and shows an "unlisted" banner.',
    initialValue: false,
  })
}

export const POST_ORDERINGS = [
  {
    title: 'Date, newest first',
    name: 'dateDesc',
    by: [{field: 'date', direction: 'desc' as const}],
  },
  {
    title: 'Date, oldest first',
    name: 'dateAsc',
    by: [{field: 'date', direction: 'asc' as const}],
  },
  {
    title: 'Title',
    name: 'titleAsc',
    by: [{field: 'title', direction: 'asc' as const}],
  },
]

/**
 * Selected image values are passed straight through as preview media; the Studio renders them as
 * thumbnails. They are typed as `PreviewValue['media']` because that is the slot they fill.
 */
type PreviewMedia = PreviewValue['media']

interface PostPreviewSelection {
  title?: string
  date?: string
  isUnlisted?: boolean
  contentImage?: PreviewMedia
  firstHeroMedia?: PreviewMedia
}

/** True for a selected image value that has an uploaded asset. */
function hasImageAsset(value: PreviewMedia): boolean {
  return typeof value === 'object' && value !== null && 'asset' in value && Boolean(value.asset)
}

/** True when the first hero media item is an image (it can also be a YouTube embed). */
function isHeroImage(value: PreviewMedia): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    value._type === 'imageWithAlt'
  )
}

/** Listing preview: title, date (plus "Unlisted"), and the first image that the site would use. */
export function preparePostPreview(
  selection: PostPreviewSelection,
  prefix?: string,
  fallbackImage?: PreviewMedia,
): PreviewValue {
  const {title, date, isUnlisted, contentImage, firstHeroMedia} = selection
  const subtitle = [prefix, date, isUnlisted ? 'Unlisted' : undefined].filter(Boolean).join(' · ')
  const heroImage = isHeroImage(firstHeroMedia) ? firstHeroMedia : undefined
  return {
    title: title || 'Untitled',
    subtitle,
    media: [contentImage, fallbackImage, heroImage].find(hasImageAsset),
  }
}
