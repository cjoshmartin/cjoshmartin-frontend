import {RemoveIcon} from '@sanity/icons/Remove'
import {defineField, defineType} from 'sanity'

/** Horizontal rule, from Wagtail `<hr>`. `style` exists because an object needs a field. */
export const divider = defineType({
  name: 'divider',
  type: 'object',
  icon: RemoveIcon,
  fields: [
    defineField({
      name: 'style',
      type: 'string',
      hidden: true,
      initialValue: 'line',
    }),
  ],
  preview: {
    prepare() {
      return {title: 'Divider', media: RemoveIcon}
    },
  },
})
