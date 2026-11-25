import { defineQuery } from 'next-sanity'

/*
 * Every GROQ query the site runs. `npm run typegen` in studio/ reads this file and writes the
 * result types to sanity.types.ts (the type of FOO_QUERY is FOO_QUERY_RESULT).
 *
 * Detail lookups always filter on `_type` as well as the slug, so a blog post slug never resolves
 * to a project or flex page and an unknown slug returns null (the page then calls notFound()).
 *
 * Listings sort by the post date, newest first. Wagtail sorted equal dates in page-tree order,
 * which is ascending page id, so `legacy.wagtailId` breaks ties the same way.
 */

/**
 * Projection for each item of a blockContent (Portable Text) array, adding the data the custom
 * blocks and annotations need on the page: link targets, file URLs and Mux playback ids.
 */
const portableTextItemProjection = /* groq */ `{
  ...,
  _type == "block" => {
    markDefs[]{
      ...,
      _type == "internalLink" => {
        "target": reference->{_type, "slug": slug.current}
      },
      _type == "fileLink" => {
        "url": file.asset->url
      }
    }
  },
  _type == "stlModel" => {
    "fileUrl": file.asset->url,
    "fileName": file.asset->originalFilename
  },
  _type == "video" => {
    "playbackId": asset.asset->playbackId,
    "status": asset.asset->status
  }
}`

const testimonialProjection = /* groq */ `{
  _id,
  firstName,
  lastName,
  jobTitle,
  relationship,
  link,
  body,
  asciiArt,
  image
}`

/** Words for the read-time estimate: text of every rich-text block, plus every code block. */
const readingProjection = /* groq */ `
  "readingText": pt::text(body),
  "codeTexts": body[_type == "code"].code
`

/** Fields of a project card on the home page and /projects. */
const projectCardProjection = /* groq */ `
  _id,
  title,
  "slug": slug.current,
  intro,
  client,
  website,
  projectType,
  previewImage,
  "mediums": mediums[]->title,
  "technologies": technologies[]->title,
  "hasBody": coalesce(count(body), 0) > 0
`

export const HOME_PAGE_QUERY = defineQuery(`
  *[_id == "homePage"][0]{
    _id,
    _type,
    title,
    "bio": bio[]${portableTextItemProjection},
    author->{
      firstName,
      lastName,
      jobTitle,
      location,
      email,
      github,
      image
    },
    "testimonials": testimonials[]->${testimonialProjection},
    "services": services[@->audience == $audience]->{
      _id,
      title,
      "description": description[]${portableTextItemProjection},
      link,
      linkText,
      image
    }
  }
`)

export const HOME_PAGE_SEO_QUERY = defineQuery(`
  *[_id == "homePage"][0]{
    title,
    seo,
    "authorImage": author->image
  }
`)

export const PORTFOLIO_PREVIEW_QUERY = defineQuery(`
  *[
    _type == "project"
    && defined(slug.current)
    && projectType == $projectType
    && audience == $audience
    && isUnlisted != true
  ] | order(date desc, legacy.wagtailId asc)[0...3]{
    ${projectCardProjection}
  }
`)

export const PROJECTS_LIST_QUERY = defineQuery(`
  *[
    _type == "project"
    && defined(slug.current)
    && audience == $audience
    && isUnlisted != true
  ] | order(date desc, legacy.wagtailId asc){
    ${projectCardProjection},
    contentImage,
    "heroImages": heroMedia[_type == "imageWithAlt"],
    ${readingProjection}
  }
`)

export const PROJECT_QUERY = defineQuery(`
  *[_type == "project" && slug.current == $slug][0]{
    _id,
    _type,
    title,
    "slug": slug.current,
    isUnlisted,
    client,
    "legacyId": legacy.wagtailId,
    heroMedia,
    contentImage,
    "mediums": mediums[]->title,
    "technologies": technologies[]->title,
    "testimonials": testimonials[]->${testimonialProjection},
    "body": body[]${portableTextItemProjection}
  }
`)

export const PROJECT_SEO_QUERY = defineQuery(`
  *[_type == "project" && slug.current == $slug][0]{
    title,
    intro,
    date,
    seo,
    contentImage,
    previewImage,
    "technologies": technologies[]->title
  }
`)

export const BLOG_LIST_QUERY = defineQuery(`
  *[_type == "blogPost" && defined(slug.current) && isUnlisted != true]
    | order(date desc, legacy.wagtailId asc){
    _id,
    title,
    "slug": slug.current,
    date,
    intro,
    "heroImage": heroMedia[0...1][_type == "imageWithAlt"][0],
    ${readingProjection}
  }
`)

export const RECOMMENDED_POSTS_QUERY = defineQuery(`
  *[
    _type == "blogPost"
    && defined(slug.current)
    && slug.current != $slug
    && isUnlisted != true
  ] | order(date desc, legacy.wagtailId asc)[0...3]{
    _id,
    title,
    "slug": slug.current,
    intro,
    "heroImage": heroMedia[0...1][_type == "imageWithAlt"][0],
    ${readingProjection}
  }
`)

export const BLOG_POST_QUERY = defineQuery(`
  *[_type == "blogPost" && slug.current == $slug][0]{
    _id,
    _type,
    title,
    "slug": slug.current,
    date,
    isUnlisted,
    "legacyId": legacy.wagtailId,
    heroMedia,
    contentImage,
    author->{
      firstName,
      lastName,
      jobTitle,
      location,
      email,
      "bio": bio[]${portableTextItemProjection},
      image
    },
    "body": body[]${portableTextItemProjection}
  }
`)

export const BLOG_POST_SEO_QUERY = defineQuery(`
  *[_type == "blogPost" && slug.current == $slug][0]{
    title,
    intro,
    date,
    seo,
    "heroImage": heroMedia[0...1][_type == "imageWithAlt"][0],
    contentImage
  }
`)

export const FLEX_PAGE_QUERY = defineQuery(`
  *[_type == "flexPage" && slug.current == $slug][0]{
    _id,
    _type,
    title,
    "body": body[]${portableTextItemProjection}
  }
`)

export const FLEX_PAGE_SEO_QUERY = defineQuery(`
  *[_type == "flexPage" && slug.current == $slug][0]{
    title,
    seo
  }
`)

export const SCREEN_PROJECTS_QUERY = defineQuery(`
  *[_type == "project" && defined(slug.current) && isUnlisted != true]
    | order(date desc, legacy.wagtailId asc){
    _id,
    title,
    previewImage,
    "mediums": mediums[]->title,
    "technologies": technologies[]->title,
    "testimonial": testimonials[0]->${testimonialProjection}
  }
`)

export const SITEMAP_QUERY = defineQuery(`
  *[
    _type in ["homePage", "blogPost", "project"]
    && (_type == "homePage" || (defined(slug.current) && isUnlisted != true))
  ] | order(_type asc, date desc){
    _type,
    "slug": slug.current,
    _updatedAt
  }
`)
