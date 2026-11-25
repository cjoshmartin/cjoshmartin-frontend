import {ImageIcon} from '@sanity/icons/Image'
import {defineField, defineType} from 'sanity'

import {altField} from '../shared/alt-field'

/** Image with alt text and caption, used for hero media, content images and preview images. */
export const imageWithAlt = defineType({
  name: 'imageWithAlt',
  title: 'Image',
  type: 'image',
  icon: ImageIcon,
  options: {hotspot: true},
  fields: [altField(), defineField({name: 'caption', type: 'string'})],
})
