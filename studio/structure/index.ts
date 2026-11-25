import {TagsIcon} from '@sanity/icons/Tags'
import type {StructureBuilder, StructureResolver} from 'sanity/structure'

import {HOME_PAGE_ID} from '../schemaTypes/constants'

/** Document list sorted by `date`, newest first, for blog posts and projects. */
function datedList(S: StructureBuilder, schemaType: string, title: string) {
  return S.documentTypeListItem(schemaType)
    .title(title)
    .child(
      S.documentTypeList(schemaType)
        .title(title)
        .defaultOrdering([{field: 'date', direction: 'desc'}]),
    )
}

/** Document list sorted by `title`. */
function titledList(S: StructureBuilder, schemaType: string, title: string) {
  return S.documentTypeListItem(schemaType)
    .title(title)
    .child(
      S.documentTypeList(schemaType)
        .title(title)
        .defaultOrdering([{field: 'title', direction: 'asc'}]),
    )
}

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Content')
    .items([
      S.listItem().singleton(HOME_PAGE_ID).title('Home'),
      S.divider(),
      datedList(S, 'blogPost', 'Blog posts'),
      datedList(S, 'project', 'Projects'),
      titledList(S, 'flexPage', 'Flex pages'),
      S.divider(),
      S.documentTypeListItem('person').title('People'),
      S.documentTypeListItem('testimonial').title('Testimonials'),
      titledList(S, 'service', 'Services'),
      S.divider(),
      S.listItem()
        .id('tags')
        .title('Tags')
        .icon(TagsIcon)
        .child(
          S.list()
            .id('tags')
            .title('Tags')
            .items([
              titledList(S, 'medium', 'Mediums'),
              titledList(S, 'technology', 'Technologies'),
            ]),
        ),
      S.divider(),
      S.documentTypeListItem('redirect').title('Redirects'),
    ])
