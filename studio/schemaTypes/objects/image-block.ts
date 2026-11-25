import {ImageIcon} from '@sanity/icons/Image'
import {defineField, defineType} from 'sanity'

import {DEFAULT_IMAGE_LAYOUT, IMAGE_LAYOUT_OPTIONS} from '../constants'
import {altField} from '../shared/alt-field'

/** Inline image inside rich text. `layout` carries Wagtail's embed format (fullwidth/left/right). */
export const imageBlock = defineType({
  name: 'imageBlock',
  title: 'Image',
  type: 'image',
  icon: ImageIcon,
  options: {hotspot: true},
  fields: [
    altField(),
    defineField({name: 'caption', type: 'string'}),
    defineField({
      name: 'layout',
      type: 'string',
      options: {list: [...IMAGE_LAYOUT_OPTIONS], layout: 'radio', direction: 'horizontal'},
      initialValue: DEFAULT_IMAGE_LAYOUT,
      validation: (rule) => rule.required(),
    }),
  ],
  validation: (rule) =>
    rule.custom((value) => (value?.asset ? true : 'Choose an image or remove this block')),
  preview: {
    select: {media: 'asset', alt: 'alt', caption: 'caption', layout: 'layout'},
    prepare({media, alt, caption, layout}) {
      const layoutTitle = IMAGE_LAYOUT_OPTIONS.find((option) => option.value === layout)?.title
      return {
        title: caption || alt || 'Image',
        subtitle: layoutTitle ? `Layout: ${layoutTitle}` : undefined,
        media,
      }
    },
  },
})
