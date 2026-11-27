import {defineField} from 'sanity'

/**
 * `alt` field for image types. Missing alt text is a warning, not an error: content migrated from
 * Wagtail does not always have it, and the image still renders.
 */
export function altField() {
  return defineField({
    name: 'alt',
    title: 'Alternative text',
    type: 'string',
    description: 'Describes the image for screen readers and search engines.',
    validation: (rule) =>
      rule
        .custom((alt, context) => {
          const parent = context.parent as {asset?: unknown} | undefined
          if (!parent?.asset) return true
          return typeof alt === 'string' && alt.trim().length > 0
            ? true
            : 'Add alternative text for accessibility and SEO'
        })
        .warning(),
  })
}
