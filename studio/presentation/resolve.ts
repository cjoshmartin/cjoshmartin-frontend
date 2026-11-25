import {
  defineDocuments,
  defineLocations,
  type DocumentLocation,
  type PresentationPluginOptions,
} from 'sanity/presentation'

import {HOME_PAGE_ID} from '../schemaTypes/constants'

/** The route each document type lives at on the Next.js site. */
const HOME: DocumentLocation = {title: 'Home', href: '/'}
const BLOG_INDEX: DocumentLocation = {title: 'Blog', href: '/blog'}
const PROJECTS_INDEX: DocumentLocation = {title: 'Projects', href: '/projects'}

/** Opens the matching document when the preview navigates to one of these routes. */
export const mainDocuments = defineDocuments([
  {
    route: '/',
    filter: `_type == "homePage" && _id == "${HOME_PAGE_ID}"`,
  },
  {
    route: '/blog/:slug',
    filter: `_type == "blogPost" && slug.current == $slug`,
  },
  {
    route: '/projects/:slug',
    filter: `_type == "project" && slug.current == $slug`,
  },
  {
    route: '/flex/:slug',
    filter: `_type == "flexPage" && slug.current == $slug`,
  },
])

/** Shows editors where a document appears on the site ("Used on" links). */
export const locations: NonNullable<PresentationPluginOptions['resolve']>['locations'] = {
  homePage: defineLocations({locations: [HOME]}),
  blogPost: defineLocations({
    select: {title: 'title', slug: 'slug.current'},
    resolve: (doc) => ({
      locations: [
        ...(doc?.slug ? [{title: doc.title || 'Untitled', href: `/blog/${doc.slug}`}] : []),
        BLOG_INDEX,
      ],
    }),
  }),
  project: defineLocations({
    select: {title: 'title', slug: 'slug.current'},
    resolve: (doc) => ({
      locations: [
        ...(doc?.slug ? [{title: doc.title || 'Untitled', href: `/projects/${doc.slug}`}] : []),
        PROJECTS_INDEX,
      ],
    }),
  }),
  flexPage: defineLocations({
    select: {title: 'title', slug: 'slug.current'},
    resolve: (doc) =>
      doc?.slug
        ? {locations: [{title: doc.title || 'Untitled', href: `/flex/${doc.slug}`}]}
        : {message: 'Add a slug to preview this page', tone: 'caution'},
  }),
}

export const resolve: PresentationPluginOptions['resolve'] = {mainDocuments, locations}
