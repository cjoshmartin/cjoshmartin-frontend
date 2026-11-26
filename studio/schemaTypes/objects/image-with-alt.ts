import {ImageIcon} from '@sanity/icons/Image'
import {defineField, defineType} from 'sanity'

import {altField} from '../shared/alt-field'
import {ImagePrivacyInput} from '../../components/ImagePrivacyInput'
import {PRIVATE_IMAGE_OPTIONS} from '../shared/image-privacy'
import {privateImageValidation} from '../shared/image-validation'

/**
 * Image with alt text and caption, used for hero media, content images and preview images. Only
 * formats the image-privacy Function can strip are accepted, no EXIF or location is extracted, and
 * the input shows the Function's progress (../shared/image-privacy.ts).
 */
export const imageWithAlt = defineType({
  name: 'imageWithAlt',
  title: 'Image',
  type: 'image',
  icon: ImageIcon,
  options: PRIVATE_IMAGE_OPTIONS,
  components: {input: ImagePrivacyInput},
  fields: [altField(), defineField({name: 'caption', type: 'string'})],
  validation: (rule) => privateImageValidation(rule),
})
