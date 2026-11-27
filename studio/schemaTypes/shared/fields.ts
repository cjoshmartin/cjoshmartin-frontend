import {ArchiveIcon} from '@sanity/icons/Archive'
import {ComposeIcon} from '@sanity/icons/Compose'
import {ControlsIcon} from '@sanity/icons/Controls'
import {ImageIcon} from '@sanity/icons/Image'
import {SearchIcon} from '@sanity/icons/Search'
import {defineField, type FieldGroupDefinition} from 'sanity'

import {AUDIENCE_OPTIONS, DEFAULT_AUDIENCE} from '../constants'
import {validateSlugFormat} from './validation'

/** Field groups used across document types. `content` opens by default. */
export const GROUPS = {
  content: {name: 'content', title: 'Content', icon: ComposeIcon, default: true},
  media: {name: 'media', title: 'Media', icon: ImageIcon},
  details: {name: 'details', title: 'Details', icon: ControlsIcon},
  seo: {name: 'seo', title: 'SEO', icon: SearchIcon},
  migration: {name: 'migration', title: 'Migration', icon: ArchiveIcon},
} satisfies Record<string, FieldGroupDefinition>

/**
 * `slug` generated from `title`. Uniqueness is Sanity's default slug check, which is scoped to the
 * document's own `_type` (a blog post and a project may share a slug, two blog posts may not).
 */
export function slugField(group?: string) {
  return defineField({
    name: 'slug',
    type: 'slug',
    group,
    options: {source: 'title', maxLength: 96},
    validation: (rule) => rule.required().custom(validateSlugFormat),
  })
}

/** Search engine overrides. Falls back to the document's own title and intro on the frontend. */
export function seoField() {
  return defineField({
    name: 'seo',
    title: 'SEO',
    type: 'seo',
    group: GROUPS.seo.name,
  })
}

/**
 * Wagtail provenance, written once by the migration and never edited. `legacy.wagtailId` is the
 * Disqus thread identifier for migrated pages, so it must stay unchanged.
 */
export function legacyField() {
  return defineField({
    name: 'legacy',
    type: 'legacy',
    group: GROUPS.migration.name,
    readOnly: true,
    hidden: ({value}) => value === undefined,
  })
}

export function audienceField(group?: string) {
  return defineField({
    name: 'audience',
    type: 'string',
    group,
    description: 'Which side of the site this belongs to.',
    options: {list: [...AUDIENCE_OPTIONS], layout: 'radio', direction: 'horizontal'},
    initialValue: DEFAULT_AUDIENCE,
    validation: (rule) => rule.required(),
  })
}
