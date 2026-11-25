import {defineField} from 'sanity'

import {slugField} from './fields'
import {uniqueInType} from './unique'

/**
 * Fields of the project tag types (`medium`, `technology`). The frontend filters projects by tag
 * `title` (/projects?medium=Web), so titles must be unique per type ignoring case; the migration
 * merges Wagtail tags that differ only by case or spacing.
 */
export function tagFields(kind: string) {
  return [
    defineField({
      name: 'title',
      type: 'string',
      validation: (rule) =>
        rule.required().custom(
          uniqueInType('title', {
            caseInsensitive: true,
            message: `Another ${kind} already has this title (ignoring case)`,
          }),
        ),
    }),
    slugField(),
  ]
}

export const TAG_ORDERINGS = [
  {title: 'Title', name: 'titleAsc', by: [{field: 'title', direction: 'asc' as const}]},
]
