// Reference data from the published Sanity dataset, used to decide whether a difference between
// the old and new site is explained (unlisted pages, SEO descriptions, the MP4 video files, ...).
// The datasets have a public ACL, so published documents are read without a token.
import { createRequire } from 'node:module'

import { SANITY_API_VERSION, SANITY_PROJECT_ID } from './config.mjs'

const require = createRequire(import.meta.url)
const { createClient } = require('@sanity/client')

const PAGES_QUERY = `*[_type in ["homePage", "blogPost", "project", "flexPage"]]{
  _id,
  _type,
  title,
  "slug": slug.current,
  isUnlisted,
  audience,
  projectType,
  intro,
  "seoTitle": seo.title,
  "seoDescription": seo.description,
  "wagtailId": legacy.wagtailId,
  _updatedAt,
  "videoBlocks": count(body[_type == "video"]),
  "videos": body[_type == "video"]{
    _key,
    "fileRef": file.asset._ref,
    "url": file.asset->url,
    "mimeType": file.asset->mimeType,
    "extension": file.asset->extension,
    "sourceName": file.asset->source.name,
    "sourceId": file.asset->source.id,
    "originalRef": original.asset._ref,
    "originalFilename": original.asset->originalFilename,
    "originalSourceUrl": original.asset->source.url,
    "status": conversion.status,
    "sourceAssetId": conversion.sourceAssetId,
    "outputAssetId": conversion.outputAssetId,
    "settingsVersion": conversion.settingsVersion
  },
  "codeBlocks": count(body[_type == "code"]),
  "stlBlocks": count(body[_type == "stlModel"]),
  "youtubeBlocks": count(body[_type == "youtube"]) + count(heroMedia[_type == "youtube"])
}`

const REDIRECTS_QUERY = `*[_type == "redirect"]{source, destination, permanent}`

const TESTIMONIALS_QUERY = `*[_type == "testimonial"]{_id, firstName, lastName, asciiArt, asciiArtSource, "imageAssetId": image.asset._ref}`

export async function fetchReference(dataset) {
  const client = createClient({
    projectId: SANITY_PROJECT_ID,
    dataset,
    apiVersion: SANITY_API_VERSION,
    useCdn: false,
    perspective: 'published',
  })
  const [pages, redirects, testimonials] = await Promise.all([
    client.fetch(PAGES_QUERY),
    client.fetch(REDIRECTS_QUERY),
    client.fetch(TESTIMONIALS_QUERY),
  ])
  if (pages.length === 0) throw new Error(`No pages in Sanity dataset ${dataset}`)
  const byPath = new Map()
  for (const page of pages) {
    const routePath =
      page._type === 'homePage'
        ? '/'
        : page._type === 'blogPost'
          ? `/blog/${page.slug}`
          : page._type === 'project'
            ? `/projects/${page.slug}`
            : `/flex/${page.slug}`
    byPath.set(routePath, page)
  }
  return { dataset, pages, byPath, redirects, testimonials }
}
