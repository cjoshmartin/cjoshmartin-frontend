import {DocumentsIcon} from '@sanity/icons/Documents'
import {DownloadIcon} from '@sanity/icons/Download'
import {LinkIcon} from '@sanity/icons/Link'
import {defineArrayMember, defineField, defineType} from 'sanity'

import {
  CODE_LANGUAGES,
  DEFAULT_CODE_LANGUAGE,
  INTERNAL_LINK_TYPES,
  type CodeLanguage,
} from '../constants'
import {FILE_LINK_ACCEPT, fileLinkProblem} from '../shared/validation'

const CODE_LANGUAGE_VALUES: readonly string[] = CODE_LANGUAGES.map((language) => language.value)

/**
 * Rich text used for every body, bio and description. Wagtail rich text and StreamField bodies
 * (full_richtext, code, stl_picker, media) both become one array of this type.
 */
export const blockContent = defineType({
  name: 'blockContent',
  title: 'Rich text',
  type: 'array',
  of: [
    defineArrayMember({
      type: 'block',
      styles: [
        {title: 'Normal', value: 'normal'},
        {title: 'Heading 1', value: 'h1'},
        {title: 'Heading 2', value: 'h2'},
        {title: 'Heading 3', value: 'h3'},
        {title: 'Heading 4', value: 'h4'},
        {title: 'Heading 5', value: 'h5'},
        {title: 'Heading 6', value: 'h6'},
        {title: 'Quote', value: 'blockquote'},
      ],
      lists: [
        {title: 'Bullet', value: 'bullet'},
        {title: 'Numbered', value: 'number'},
      ],
      marks: {
        decorators: [
          {title: 'Strong', value: 'strong'},
          {title: 'Emphasis', value: 'em'},
          {title: 'Code', value: 'code'},
          {title: 'Underline', value: 'underline'},
          {title: 'Strike', value: 'strike-through'},
        ],
        annotations: [
          defineArrayMember({
            name: 'link',
            title: 'Link',
            type: 'object',
            icon: LinkIcon,
            fields: [
              defineField({
                name: 'href',
                title: 'URL',
                type: 'url',
                description: 'Absolute URL, site path (/projects), #anchor, mailto: or tel: link.',
                validation: (rule) =>
                  rule.required().uri({
                    allowRelative: true,
                    scheme: ['http', 'https', 'mailto', 'tel'],
                  }),
              }),
              defineField({
                name: 'openInNewTab',
                title: 'Open in new tab',
                type: 'boolean',
                initialValue: false,
              }),
            ],
          }),
          defineArrayMember({
            name: 'internalLink',
            title: 'Internal link',
            type: 'object',
            icon: DocumentsIcon,
            fields: [
              defineField({
                name: 'reference',
                title: 'Page',
                type: 'reference',
                to: INTERNAL_LINK_TYPES.map((type) => ({type})),
                validation: (rule) => rule.required(),
              }),
            ],
          }),
          defineArrayMember({
            name: 'fileLink',
            title: 'File link',
            type: 'object',
            icon: DownloadIcon,
            fields: [
              defineField({
                name: 'file',
                type: 'file',
                description:
                  'A PDF document. Photos and videos go in an image or video block instead, where their location and camera data is removed automatically.',
                // Only documents: a photo or video attached here would be served exactly as uploaded,
                // with its location (no Function strips file links).
                options: {accept: FILE_LINK_ACCEPT},
                // The custom rule also runs when the field is empty, so it doubles as the required check.
                validation: (rule) => rule.custom((value) => fileLinkProblem(value?.asset?._ref) ?? true),
              }),
            ],
          }),
        ],
      },
    }),
    defineArrayMember({type: 'imageBlock'}),
    defineArrayMember({type: 'youtube'}),
    defineArrayMember({
      type: 'code',
      options: {
        language: DEFAULT_CODE_LANGUAGE,
        languageAlternatives: CODE_LANGUAGES.map((language) => ({...language})),
        withFilename: true,
      },
      validation: (rule) =>
        rule.custom((value: {code?: string; language?: string} | undefined) => {
          if (!value) return true
          if (!value.code?.trim()) return 'Add code or remove this block'
          if (!value.language) return 'Choose a language'
          return CODE_LANGUAGE_VALUES.includes(value.language as CodeLanguage)
            ? true
            : `Language must be one of: ${CODE_LANGUAGE_VALUES.join(', ')}`
        }),
    }),
    defineArrayMember({type: 'stlModel'}),
    defineArrayMember({type: 'video'}),
    defineArrayMember({type: 'divider'}),
  ],
})
