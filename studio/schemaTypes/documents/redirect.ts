import {TransferIcon} from '@sanity/icons/Transfer'
import {defineField, defineType} from 'sanity'

import {uniqueInType} from '../shared/unique'
import {validatePathOrAbsoluteUrl, validateSitePath} from '../shared/validation'

/** Redirect served by the Next.js app (Wagtail `wagtail.contrib.redirects`). */
export const redirect = defineType({
  name: 'redirect',
  title: 'Redirect',
  type: 'document',
  icon: TransferIcon,
  fields: [
    defineField({
      name: 'source',
      type: 'string',
      description: 'Old path on this site, starting with "/", for example /blog/old-slug.',
      validation: (rule) =>
        rule
          .required()
          .custom(validateSitePath)
          .custom(uniqueInType('source', {message: 'Another redirect already uses this source'})),
    }),
    defineField({
      name: 'destination',
      type: 'string',
      description: 'Path on this site ("/blog/new-slug") or an absolute URL ("https://…").',
      validation: (rule) =>
        rule
          .required()
          .custom(validatePathOrAbsoluteUrl)
          .custom((value, context) => {
            const source = (context.parent as {source?: string} | undefined)?.source
            return value && source && value.trim() === source.trim()
              ? 'Destination must differ from the source'
              : true
          }),
    }),
    defineField({
      name: 'permanent',
      type: 'boolean',
      description: 'On: permanent (308), search engines update their index. Off: temporary (307).',
      initialValue: true,
      validation: (rule) => rule.required(),
    }),
  ],
  preview: {
    select: {source: 'source', destination: 'destination', permanent: 'permanent'},
    prepare({source, destination, permanent}) {
      return {
        title: `${source || '?'} → ${destination || '?'}`,
        subtitle: permanent === false ? 'Temporary (307)' : 'Permanent (308)',
      }
    },
  },
})
