/**
 * Types and loaders for the "Export for Sanity" Wagtail export (format_version 1).
 *
 * export.json holds every page with its published and latest revision content, snippets,
 * images, documents, media, redirects, sites and embeds. Rich text is in Wagtail's database
 * format (`<embed embedtype="image" id=...>`, `<a linktype="page" id=...>`), so references
 * resolve by Wagtail id without guessing URLs. dumpdata.json is a full Django dumpdata; only
 * the taggit tag slugs are read from it.
 */
import {readFileSync} from 'node:fs'

export interface WagtailImage {
  id: number
  title: string
  description: string
  file: string
  file_hash: string
  file_size: number
  width: number
  height: number
  created_at: string
  collection_name: string
  focal_point_x: number | null
  focal_point_y: number | null
  focal_point_width: number | null
  focal_point_height: number | null
}

export interface WagtailDocument {
  id: number
  title: string
  file: string
  file_hash: string
  file_size: number
  created_at: string
}

export interface WagtailMedia {
  id: number
  title: string
  file: string
  thumbnail: string | null
  type: string
  duration: number
  width: number | null
  height: number | null
  created_at: string
}

export interface WagtailRedirect {
  id: number
  old_path: string
  is_permanent: boolean
  redirect_page_id: number | null
  redirect_page_route_path: string
  redirect_link: string
  site_id: number
  automatically_created: boolean
  created_at: string
}

export interface StreamBlock {
  id: string
  type: string
  value: unknown
}

/** Field values of one page revision (published or latest). Only the fields we read are typed. */
export interface PageFields {
  id: number
  title: string
  draft_title: string
  slug: string
  url_path: string
  seo_title: string
  search_description: string
  first_published_at: string | null
  last_published_at: string | null
  live: boolean
  has_unpublished_changes: boolean
  /** home.HomePage: rich text string. flex/blog/project pages: StreamField list. */
  body?: string | StreamBlock[]
  content_visuals?: StreamBlock[]
  content_image_id?: number | null
  preview_image_id?: number | null
  date?: string
  intro?: string | null
  is_unlisted?: boolean
  project_audience?: string
  project_type?: string
  client?: string | null
  website?: string | null
  [key: string]: unknown
}

export interface Orderable {
  id: number
  sort_order: number
  [key: string]: unknown
}

export interface PageRevision {
  fields: PageFields
  children: Record<string, Orderable[]>
  tags: Record<string, string[]>
}

export interface WagtailPage {
  id: number
  type: string
  title: string
  draft_title: string
  slug: string
  url_path: string
  depth: number
  parent_id: number | null
  live: boolean
  has_unpublished_changes: boolean
  first_published_at: string | null
  last_published_at: string | null
  live_revision_id: number | null
  latest_revision_id: number | null
  alias_of_id: number | null
  expired: boolean
  locked: boolean
  go_live_at: string | null
  expire_at: string | null
  seo_title: string
  search_description: string
  published: PageRevision | null
  latest: PageRevision | null
}

export interface AuthorSnippet {
  id: number
  first_name: string
  last_name: string
  image_id: number | null
  location: string | null
  job_title: string | null
  bio: string | null
  email: string | null
  github: string | null
}

export interface TestimonialSnippet {
  id: number
  first_name: string
  last_name: string
  image_id: number | null
  job_title: string | null
  relationship: string | null
  link: string | null
  body: string | null
}

export interface ServiceSnippet {
  id: number
  title: string
  image_id: number | null
  description: string | null
  link: string | null
  link_text: string | null
  audience: string
}

export interface WagtailExport {
  format_version: number
  generated_at: string
  source: {base_url: string; gs_bucket_name: string; gs_public_base_url: string}
  pages: WagtailPage[]
  images: WagtailImage[]
  documents: WagtailDocument[]
  media: WagtailMedia[]
  redirects: WagtailRedirect[]
  sites: {id: number; hostname: string; root_page_id: number; is_default_site: boolean}[]
  embeds: {id: number; url: string; provider_name: string}[]
  collections: {id: number; name: string}[]
  snippets: {
    'home.Author': AuthorSnippet[]
    'home.Testimonial': TestimonialSnippet[]
    'home.Service': ServiceSnippet[]
  }
}

export interface Manifest {
  format_version: number
  generated_at: string
  counts: Record<string, unknown>
  files: Record<string, {bytes: number; sha256: string}>
  source: Record<string, string>
}

export function loadExport(exportJsonPath: string): WagtailExport {
  const data = JSON.parse(readFileSync(exportJsonPath, 'utf8')) as WagtailExport
  if (data.format_version !== 1) {
    throw new Error(`Unsupported export format_version ${data.format_version} (expected 1)`)
  }
  return data
}

/** taggit tag name -> slug, from dumpdata.json. */
export function loadTagSlugs(dumpdataPath: string): Map<string, string> {
  const rows = JSON.parse(readFileSync(dumpdataPath, 'utf8')) as {
    model: string
    pk: number
    fields: Record<string, unknown>
  }[]
  const slugs = new Map<string, string>()
  for (const row of rows) {
    if (row.model !== 'taggit.tag') continue
    const name = row.fields.name
    const slug = row.fields.slug
    if (typeof name !== 'string' || typeof slug !== 'string') {
      throw new Error(`taggit.tag ${row.pk} has no name or slug`)
    }
    if (slugs.has(name)) throw new Error(`taggit.tag name "${name}" appears twice in dumpdata`)
    slugs.set(name, slug)
  }
  return slugs
}

/** The Wagtail page models this migration knows, and the Sanity type each one becomes. */
export const PAGE_TYPE_MAP = {
  'home.HomePage': 'homePage',
  'flex.FlexPage': 'flexPage',
  'blog.BlogPage': 'blogPost',
  'blog.ProjectPage': 'project',
} as const
export type MigratedPageType = keyof typeof PAGE_TYPE_MAP

/** The tree root (`wagtailcore.Page`, depth 1) is structural and has no content to migrate. */
export const TREE_ROOT_TYPE = 'wagtailcore.Page'

export function isMigratedPageType(type: string): type is MigratedPageType {
  return Object.hasOwn(PAGE_TYPE_MAP, type)
}
