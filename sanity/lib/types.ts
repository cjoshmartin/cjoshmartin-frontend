import type { StegaBranded } from '@sanity/client/stega'

import type {
  BLOG_POST_QUERY_RESULT,
  HOME_PAGE_QUERY_RESULT,
  PROJECTS_LIST_QUERY_RESULT,
} from '@/sanity.types'

/*
 * Shapes shared by several components, derived from the TypeGen query results. `sanityFetch`
 * brands strings that may carry stega (Visual Editing) characters, so these are branded too:
 * clean a value with `stegaClean` before comparing it or putting it in an attribute.
 */

type BlogPost = StegaBranded<NonNullable<BLOG_POST_QUERY_RESULT>>

/**
 * A Portable Text field projected with `portableTextItemProjection` (sanity/lib/queries.ts): post,
 * project and flex page bodies, bios and service descriptions.
 */
export type PortableTextBodyValue = NonNullable<BlogPost['body']>

/** A testimonial as every query projects it. */
export type TestimonialData = NonNullable<
  StegaBranded<NonNullable<HOME_PAGE_QUERY_RESULT>>['testimonials']
>[number]

/** The hero media array of a blog post or project. */
export type HeroMediaValue = NonNullable<BlogPost['heroMedia']>

/** An `imageWithAlt` value (hero images, content image, preview image). */
export type ImageWithAltValue = NonNullable<BlogPost['contentImage']>

/** A project card as PROJECTS_LIST_QUERY returns it. */
export type ProjectListItem = StegaBranded<PROJECTS_LIST_QUERY_RESULT>[number]
