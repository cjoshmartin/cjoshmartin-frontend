import {CubeIcon} from '@sanity/icons/Cube'
import {defineField, defineType} from 'sanity'

import {fileAssetExtension} from '../shared/validation'

/** 3D model rendered by the frontend's three.js STL viewer. */
export const stlModel = defineType({
  name: 'stlModel',
  title: '3D model (STL)',
  type: 'object',
  icon: CubeIcon,
  fields: [
    defineField({
      name: 'file',
      title: 'STL file',
      type: 'file',
      options: {accept: '.stl'},
      // The custom rule also runs when the field is empty, so it doubles as the required check.
      validation: (rule) =>
        rule.custom((value) => {
          const ref = value?.asset?._ref
          if (!ref) return 'Upload an .stl file'
          return fileAssetExtension(ref) === 'stl' ? true : 'Only .stl files are allowed'
        }),
    }),
    defineField({
      name: 'scale',
      type: 'number',
      description:
        'How far away the model is shown. Whole number from 1 to 1000; migrated models use 20 to 30.',
      validation: (rule) => rule.required().integer().min(1).max(1000),
    }),
  ],
  preview: {
    select: {filename: 'file.asset.originalFilename', scale: 'scale'},
    prepare({filename, scale}) {
      return {
        title: filename || '3D model',
        subtitle: typeof scale === 'number' ? `STL · scale ${scale}` : 'STL',
        media: CubeIcon,
      }
    },
  },
})
