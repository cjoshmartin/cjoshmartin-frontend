/**
 * Builds every Sanity document from the Wagtail export (schema contract:
 * docs/sanity-migration/schema-contract.md).
 *
 * - Pages: a live page becomes a published document from its published revision; a page with
 *   unpublished changes, or that is not live, gets a `drafts.<id>` document from its latest
 *   revision. The tree root is structural and skipped; every other page migrates, including the
 *   empty Portfolio and Blog flex pages.
 * - Snippets (author, testimonials, services) become published documents.
 * - Tags become medium/technology documents, merging names that differ only by case or
 *   whitespace (every merge is reported).
 * - Redirects become redirect documents (a draft when the target page is not published);
 *   Mux videos become mux.videoAsset documents.
 *
 * Empty values are left unset (never null). `_key`s come from Wagtail block ids.
 */
import {JSDOM} from 'jsdom'

import {
  KeyRegistry,
  richTextToBlocks,
  RichTextError,
  type Issue,
  type PTItem,
  type ResolvedPage,
  type RichTextContext,
} from './richtext'
import type {StudioSchema} from './schema'
import type {AssetMap} from '../steps/assets'
import type {AsciiMap} from '../steps/ascii'
import type {MuxMap, MuxMapEntry} from '../steps/mux'
import {LINK_HREF_FIXES, linkHrefFix, type LinkHrefFix} from '../content-fixes'
import {migratedRevisions} from '../references'
import {
  isMigratedPageType,
  PAGE_TYPE_MAP,
  TREE_ROOT_TYPE,
  type Orderable,
  type PageFields,
  type PageRevision,
  type StreamBlock,
  type WagtailExport,
  type WagtailImage,
  type WagtailPage,
  wagtailTagOrder,
} from '../wagtail'

export interface SanityDocument {
  _id: string
  _type: string
  [field: string]: unknown
}

export interface TagMerge {
  type: 'medium' | 'technology'
  title: string
  slug: string
  mergedNames: string[]
}

export interface LinkTextFlattening {
  serviceId: number
  html: string
  text: string
  lost: string[]
}

/** One row of the mapping report: which Wagtail record became which Sanity documents. */
export interface MappingRow {
  wagtail: string
  sanity: string[]
}

export interface TransformResult {
  documents: SanityDocument[]
  issues: Issue[]
  tagMerges: TagMerge[]
  linkTextFlattening: LinkTextFlattening[]
  mapping: MappingRow[]
}

export interface TransformInput {
  data: WagtailExport
  tagSlugs: Map<string, string>
  assets: AssetMap
  mux: MuxMap
  ascii: AsciiMap
  schema: StudioSchema
}

class TransformError extends Error {}

/** `_id` of the home page singleton (checked against the Studio's HOME_PAGE_ID). */
export const HOME_PAGE_DOCUMENT_ID = 'homePage'

function ref(id: string): {_type: 'reference'; _ref: string} {
  return {_type: 'reference', _ref: id}
}

function keyedRef(id: string): {_type: 'reference'; _ref: string; _key: string} {
  return {_type: 'reference', _ref: id, _key: id}
}

/** Wagtail timestamps (microseconds, +00:00) as ISO strings in UTC. */
function isoDatetime(value: string | null | undefined, what: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TransformError(`${what}: invalid datetime ${value}`)
  return date.toISOString()
}

/** A string field: unset when null or blank, otherwise verbatim. */
function text(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value.trim() === '' ? undefined : value
}

function sortedOrderables(rows: Orderable[] | undefined): Orderable[] {
  return [...(rows ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
}

export function pageDocumentId(page: Pick<WagtailPage, 'id' | 'type'>): string {
  if (page.type === 'home.HomePage') return HOME_PAGE_DOCUMENT_ID
  if (!isMigratedPageType(page.type)) throw new TransformError(`page ${page.id} has unsupported type ${page.type}`)
  return `${PAGE_TYPE_MAP[page.type]}-${page.id}`
}

/** The site path of a page on the Next.js frontend (Wagtail /home/blog/x/ -> /blog/x). */
export function pageSitePath(page: WagtailPage, slug: string): string {
  switch (page.type) {
    case 'home.HomePage':
      return '/'
    case 'blog.BlogPage':
      return `/blog/${slug}`
    case 'blog.ProjectPage':
      return `/projects/${slug}`
    case 'flex.FlexPage':
      return `/flex/${slug}`
    default:
      throw new TransformError(`page ${page.id} (${page.type}) has no route on the site`)
  }
}

export function buildDocuments(input: TransformInput): TransformResult {
  const {data, assets, mux, ascii, schema} = input
  const {constants, validation} = schema
  const issues: Issue[] = []
  const documents: SanityDocument[] = []
  const mapping: MappingRow[] = []
  const errors: string[] = []

  const imageRecords = new Map(data.images.map((i) => [i.id, i]))
  const pagesById = new Map(data.pages.map((p) => [p.id, p]))
  const audienceValues: string[] = constants.AUDIENCE_OPTIONS.map((o) => o.value)
  const projectTypeValues: string[] = constants.PROJECT_TYPE_OPTIONS.map((o) => o.value)
  const codeLanguages: string[] = constants.CODE_LANGUAGES.map((l) => l.value)

  if (constants.HOME_PAGE_ID !== HOME_PAGE_DOCUMENT_ID) {
    throw new TransformError(`The Studio's HOME_PAGE_ID is ${constants.HOME_PAGE_ID}, expected ${HOME_PAGE_DOCUMENT_ID}`)
  }

  // --- Resolvers ------------------------------------------------------------------------
  const imageAsset = (id: number, where: string): string => {
    const record = imageRecords.get(id)
    if (!record) throw new TransformError(`${where}: image ${id} is not in the export`)
    if (record.focal_point_x !== null || record.focal_point_y !== null) {
      throw new TransformError(`${where}: image ${id} has a Wagtail focal point, which this migration does not map`)
    }
    const assetId = assets.images[String(id)]
    if (!assetId) throw new TransformError(`${where}: image ${id} has no uploaded asset (its file is missing)`)
    return assetId
  }
  /** Wagtail's default alt text for an image (description, else title). */
  const defaultAlt = (id: number): string | undefined => {
    const record = imageRecords.get(id) as WagtailImage
    return text(record.description) ?? text(record.title)
  }
  const documentAsset = (id: number, where: string): string => {
    const assetId = assets.documents[String(id)]
    if (!assetId) throw new TransformError(`${where}: document ${id} has no uploaded asset`)
    return assetId
  }
  const pageTarget = (id: number, where: string): ResolvedPage => {
    const page = pagesById.get(id)
    if (!page) throw new TransformError(`${where}: page ${id} is not in the export`)
    if (!isMigratedPageType(page.type)) throw new TransformError(`${where}: page ${id} (${page.type}) does not migrate`)
    return {documentId: pageDocumentId(page), published: page.live, type: PAGE_TYPE_MAP[page.type]}
  }

  // Content fixes (src/content-fixes.ts) that matched; every listed fix must match once.
  const appliedFixes = new Set<LinkHrefFix>()
  /** `streamBlock` identifies a StreamField rich-text block, the only place content fixes apply. */
  const richText = (
    html: string | null | undefined,
    record: string,
    keys: KeyRegistry,
    keyPrefix: string,
    streamBlock?: {pageId: number; blockId: string},
  ): PTItem[] => {
    if (!html || html.trim() === '') return []
    const ctx: RichTextContext = {
      record,
      schema,
      keys,
      keyPrefix,
      issues,
      image: (id) => ({assetId: imageAsset(id, record)}),
      document: (id) => documentAsset(id, record),
      page: (id) => pageTarget(id, record),
      linkHref: (href) => {
        const fix = streamBlock && linkHrefFix(streamBlock.pageId, streamBlock.blockId, href)
        if (!fix) return href
        appliedFixes.add(fix)
        issues.push({record, level: 'info', code: 'content-fix', message: `link ${JSON.stringify(fix.from)} -> ${JSON.stringify(fix.to)}: ${fix.reason}`})
        return fix.to
      },
    }
    return richTextToBlocks(html, ctx)
  }

  /** A whole rich-text field (bio, body, description): one array with its own keys. */
  const richTextField = (html: string | null | undefined, record: string): PTItem[] | undefined => {
    const blocks = richText(html, record, new KeyRegistry(record, issues), '')
    return blocks.length ? blocks : undefined
  }

  const snippetImage = (id: number | null, where: string) =>
    id == null
      ? undefined
      : {_type: 'image', asset: ref(imageAsset(id, where)), ...(defaultAlt(id) ? {alt: defaultAlt(id)} : {})}

  const imageWithAlt = (id: number | null | undefined, where: string, key?: string) =>
    id == null
      ? undefined
      : {
          _type: 'imageWithAlt',
          ...(key ? {_key: key} : {}),
          asset: ref(imageAsset(id, where)),
          ...(defaultAlt(id) ? {alt: defaultAlt(id)} : {}),
        }

  const youtube = (url: unknown, where: string, key: string) => {
    if (typeof url !== 'string' || !validation.getYouTubeVideoId(url)) {
      throw new TransformError(`${where}: ${JSON.stringify(url)} is not a YouTube video URL`)
    }
    return {_type: 'youtube', _key: key, url}
  }

  const streamBody = (blocks: StreamBlock[], record: string, pageId: number): PTItem[] => {
    const keys = new KeyRegistry(record, issues)
    const out: PTItem[] = []
    blocks.forEach((block, index) => {
      const where = `${record} body[${index}] ${block.type}`
      if (typeof block.id !== 'string' || !block.id) throw new TransformError(`${where}: block has no id`)
      switch (block.type) {
        case 'full_richtext':
          out.push(...richText(String(block.value), where, keys, `${block.id.slice(0, 8)}-`, {pageId, blockId: block.id}))
          break
        case 'code': {
          const value = block.value as {language?: unknown; text?: unknown}
          if (typeof value.language !== 'string' || !codeLanguages.includes(value.language)) {
            throw new TransformError(`${where}: code language ${JSON.stringify(value.language)} is not one of ${codeLanguages.join(', ')}`)
          }
          if (typeof value.text !== 'string' || value.text.trim() === '') throw new TransformError(`${where}: code block is empty`)
          out.push({_type: 'code', _key: keys.claim(block.id), language: value.language, code: value.text})
          break
        }
        case 'stl_picker': {
          const value = block.value as {file?: unknown; scale?: unknown}
          if (typeof value.file !== 'number') throw new TransformError(`${where}: stl_picker without a document`)
          const assetId = documentAsset(value.file, where)
          if (validation.fileAssetExtension(assetId) !== 'stl') throw new TransformError(`${where}: document ${value.file} is ${assetId}, not an .stl file`)
          if (typeof value.scale !== 'number' || !Number.isInteger(value.scale) || value.scale < 1 || value.scale > 1000) {
            throw new TransformError(`${where}: STL scale ${JSON.stringify(value.scale)} is not an integer from 1 to 1000`)
          }
          out.push({_type: 'stlModel', _key: keys.claim(block.id), file: {_type: 'file', asset: ref(assetId)}, scale: value.scale})
          break
        }
        case 'media': {
          const mediaId = block.value
          if (typeof mediaId !== 'number' || !data.media.some((m) => m.id === mediaId)) {
            throw new TransformError(`${where}: media ${JSON.stringify(mediaId)} is not in the export`)
          }
          if (!mux.videos[String(mediaId)] && !mux.pending.some((p) => p.mediaId === mediaId)) {
            throw new TransformError(`${where}: media ${mediaId} has no Mux asset (run the mux step)`)
          }
          out.push({
            _type: 'video',
            _key: keys.claim(block.id),
            asset: {_type: 'mux.video', asset: {_type: 'reference', _weak: true, _ref: `mux-video-${mediaId}`}},
          })
          break
        }
        default:
          throw new TransformError(`${where}: StreamField block type "${block.type}" is not supported`)
      }
    })
    return out
  }

  const heroMedia = (blocks: StreamBlock[] | undefined, record: string) => {
    if (!blocks?.length) return undefined
    const keys = new KeyRegistry(record, issues)
    return blocks.map((block, index) => {
      const where = `${record} content_visuals[${index}] ${block.type}`
      const key = keys.claim(block.id)
      if (block.type === 'image') {
        if (typeof block.value !== 'number') throw new TransformError(`${where}: image block without an image id`)
        return imageWithAlt(block.value, where, key)!
      }
      if (block.type === 'youtube_video') return youtube(block.value, where, key)
      throw new TransformError(`${where}: content_visuals block type "${block.type}" is not supported`)
    })
  }

  const seo = (fields: PageFields) => {
    const title = text(fields.seo_title)
    const description = text(fields.search_description)
    return title || description ? {_type: 'seo', ...(title ? {title} : {}), ...(description ? {description} : {})} : undefined
  }

  const pageLegacy = (page: WagtailPage) => {
    const firstPublishedAt = isoDatetime(page.first_published_at, `page ${page.id} first_published_at`)
    const lastPublishedAt = isoDatetime(page.last_published_at, `page ${page.id} last_published_at`)
    return {
      _type: 'legacy',
      wagtailId: page.id,
      wagtailType: page.type,
      wagtailUrlPath: page.url_path,
      ...(firstPublishedAt ? {firstPublishedAt} : {}),
      ...(lastPublishedAt ? {lastPublishedAt} : {}),
    }
  }

  const snippetLegacy = (id: number, wagtailType: string) => ({_type: 'legacy', wagtailId: id, wagtailType})

  const slug = (value: string, where: string) => {
    if (!validation.SLUG_PATTERN.test(value)) throw new TransformError(`${where}: slug "${value}" does not match ${validation.SLUG_PATTERN}`)
    return {_type: 'slug', current: value}
  }

  const singleAuthor = (rows: Orderable[] | undefined, where: string) => {
    const authors = sortedOrderables(rows)
    if (authors.length > 1) throw new TransformError(`${where}: ${authors.length} authors, the schema has one author field`)
    const authorId = authors[0]?.author_id
    if (authorId === undefined) return undefined
    if (!data.snippets['home.Author'].some((a) => a.id === authorId)) throw new TransformError(`${where}: author ${String(authorId)} is not in the export`)
    return ref(`person-${String(authorId)}`)
  }

  const orderedRefs = (rows: Orderable[] | undefined, field: string, prefix: string, exists: (id: number) => boolean, where: string) => {
    const refs = sortedOrderables(rows).map((row) => {
      const id = row[field]
      if (typeof id !== 'number' || !exists(id)) throw new TransformError(`${where}: ${field} ${String(id)} is not in the export`)
      return keyedRef(`${prefix}-${id}`)
    })
    if (new Set(refs.map((r) => r._ref)).size !== refs.length) throw new TransformError(`${where}: the same ${prefix} is attached twice`)
    return refs.length ? refs : undefined
  }

  // --- Tags -----------------------------------------------------------------------------
  const tagMerges: TagMerge[] = []
  const tagIds = {medium: new Map<string, string>(), technologies: new Map<string, string>()}
  const tagKinds = [
    {exportKey: 'medium', type: 'medium'},
    {exportKey: 'technologies', type: 'technology'},
  ] as const
  for (const {exportKey, type} of tagKinds) {
    // name -> number of migrated revisions using it, in first-seen order
    const usage = new Map<string, number>()
    for (const page of data.pages) {
      if (!isMigratedPageType(page.type)) continue
      for (const {revision} of migratedRevisions(page)) {
        for (const name of revision.tags[exportKey] ?? []) usage.set(name, (usage.get(name) ?? 0) + 1)
      }
    }
    const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()
    const groups = new Map<string, string[]>()
    for (const name of usage.keys()) groups.set(normalize(name), [...(groups.get(normalize(name)) ?? []), name])
    for (const names of groups.values()) {
      // Title: the most used spelling; ties go to the spelling seen first.
      const title = [...names].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0))[0]!.trim().replace(/\s+/g, ' ')
      const taggitSlug = input.tagSlugs.get(names.find((n) => n.trim().replace(/\s+/g, ' ') === title) ?? names[0]!)
      const slugValue =
        taggitSlug && validation.SLUG_PATTERN.test(taggitSlug)
          ? taggitSlug
          : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      if (!validation.SLUG_PATTERN.test(slugValue)) throw new TransformError(`${type} "${title}": cannot make a valid slug`)
      const id = `${type}-${slugValue}`
      if (documents.some((d) => d._id === id)) throw new TransformError(`${type} slug ${slugValue} is used by two different tags`)
      documents.push({_id: id, _type: type, title, slug: {_type: 'slug', current: slugValue}})
      mapping.push({wagtail: `taggit ${exportKey}: ${names.map((n) => JSON.stringify(n)).join(', ')}`, sanity: [id]})
      for (const name of names) tagIds[exportKey].set(name, id)
      if (names.length > 1 || names[0] !== title) tagMerges.push({type, title, slug: slugValue, mergedNames: names})
    }
  }
  const tagRefs = (names: string[] | undefined, kind: 'medium' | 'technologies', where: string) => {
    // The order the old site showed, not the export's (see wagtailTagOrder).
    const refs = wagtailTagOrder(names ?? []).map((name) => {
      const id = tagIds[kind].get(name)
      if (!id) throw new TransformError(`${where}: tag ${name} has no document`)
      return keyedRef(id)
    })
    const unique = refs.filter((r, i) => refs.findIndex((o) => o._ref === r._ref) === i)
    if (unique.length !== refs.length) {
      issues.push({record: where, level: 'info', code: 'tag-merged-on-page', message: `${kind}: ${refs.length - unique.length} tags merged into one on this page`})
    }
    return unique.length ? unique : undefined
  }

  // --- Snippets -------------------------------------------------------------------------
  for (const author of data.snippets['home.Author']) {
    const record = `author ${author.id}`
    try {
      const github = text(author.github)
      const bio = richTextField(author.bio, `${record} bio`)
      documents.push({
        _id: `person-${author.id}`,
        _type: 'person',
        firstName: author.first_name,
        lastName: author.last_name,
        ...(author.image_id != null ? {image: snippetImage(author.image_id, record)} : {}),
        ...(text(author.location) ? {location: author.location} : {}),
        ...(text(author.job_title) ? {jobTitle: author.job_title} : {}),
        ...(bio ? {bio} : {}),
        ...(text(author.email) ? {email: author.email} : {}),
        ...(github ? {github} : {}),
        legacy: snippetLegacy(author.id, 'home.Author'),
      })
      mapping.push({wagtail: `home.Author ${author.id}`, sanity: [`person-${author.id}`]})
    } catch (error) {
      if (!(error instanceof TransformError || error instanceof RichTextError)) throw error
      errors.push(error.message)
    }
  }
  for (const t of data.snippets['home.Testimonial']) {
    const record = `testimonial ${t.id}`
    try {
      const image = snippetImage(t.image_id, record)
      let art: Record<string, string> = {}
      if (image) {
        const entry = ascii.art[image.asset._ref]
        if (!entry) throw new TransformError(`${record}: no ASCII art for ${image.asset._ref} (run the ascii step)`)
        art = {asciiArt: entry.html, asciiArtSource: image.asset._ref}
      }
      const body = richTextField(t.body, `${record} body`)
      documents.push({
        _id: `testimonial-${t.id}`,
        _type: 'testimonial',
        firstName: t.first_name,
        lastName: t.last_name,
        ...(image ? {image} : {}),
        ...(text(t.job_title) ? {jobTitle: t.job_title} : {}),
        ...(text(t.relationship) ? {relationship: t.relationship} : {}),
        ...(text(t.link) ? {link: t.link} : {}),
        ...(body ? {body} : {}),
        ...art,
        legacy: snippetLegacy(t.id, 'home.Testimonial'),
      })
      mapping.push({wagtail: `home.Testimonial ${t.id}`, sanity: [`testimonial-${t.id}`]})
    } catch (error) {
      if (!(error instanceof TransformError || error instanceof RichTextError)) throw error
      errors.push(error.message)
    }
  }
  const linkTextFlattening: LinkTextFlattening[] = []
  for (const s of data.snippets['home.Service']) {
    const record = `service ${s.id}`
    try {
      if (!audienceValues.includes(s.audience)) throw new TransformError(`${record}: audience ${s.audience} is not one of ${audienceValues.join(', ')}`)
      let linkText: string | undefined
      if (text(s.link_text)) {
        const flat = flattenLinkText(s.link_text as string, record)
        linkTextFlattening.push({serviceId: s.id, ...flat})
        for (const lost of flat.lost) issues.push({record, level: 'warning', code: 'link-text-formatting-lost', message: lost})
        linkText = text(flat.text)
      }
      const description = richTextField(s.description, `${record} description`)
      documents.push({
        _id: `service-${s.id}`,
        _type: 'service',
        title: s.title,
        ...(s.image_id != null ? {image: snippetImage(s.image_id, record)} : {}),
        ...(description ? {description} : {}),
        ...(text(s.link) ? {link: s.link} : {}),
        ...(linkText ? {linkText} : {}),
        audience: s.audience,
        legacy: snippetLegacy(s.id, 'home.Service'),
      })
      mapping.push({wagtail: `home.Service ${s.id}`, sanity: [`service-${s.id}`]})
    } catch (error) {
      if (!(error instanceof TransformError || error instanceof RichTextError)) throw error
      errors.push(error.message)
    }
  }

  // --- Pages ----------------------------------------------------------------------------
  const pageDocument = (page: WagtailPage, revision: PageRevision, state: 'published' | 'draft'): SanityDocument => {
    const f = revision.fields
    const record = `page ${page.id} (${state})`
    if (f.id !== page.id) throw new TransformError(`${record}: revision belongs to page ${f.id}`)
    const baseId = pageDocumentId(page)
    const _id = state === 'draft' ? `drafts.${baseId}` : baseId
    const title = text(f.title)
    if (!title) throw new TransformError(`${record}: no title`)

    if (page.type === 'home.HomePage') {
      if (typeof f.body !== 'string') throw new TransformError(`${record}: home page body is not rich text`)
      const bio = richTextField(f.body, `${record} body`)
      const author = singleAuthor(revision.children.blog_authors, record)
      const testimonials = orderedRefs(revision.children.testimonials, 'testimonial_id', 'testimonial', (id) => data.snippets['home.Testimonial'].some((t) => t.id === id), record)
      const services = orderedRefs(revision.children.home_service, 'service_id', 'service', (id) => data.snippets['home.Service'].some((s) => s.id === id), record)
      const seoValue = seo(f)
      return {
        _id,
        _type: 'homePage',
        title,
        ...(bio ? {bio} : {}),
        ...(author ? {author} : {}),
        ...(testimonials ? {testimonials} : {}),
        ...(services ? {services} : {}),
        ...(seoValue ? {seo: seoValue} : {}),
        legacy: pageLegacy(page),
      }
    }

    if (!Array.isArray(f.body)) throw new TransformError(`${record}: body is not a StreamField`)
    const body = streamBody(f.body, record, page.id)
    const seoValue = seo(f)
    if (page.type === 'flex.FlexPage') {
      return {
        _id,
        _type: 'flexPage',
        title,
        slug: slug(f.slug, record),
        ...(body.length ? {body} : {}),
        ...(seoValue ? {seo: seoValue} : {}),
        legacy: pageLegacy(page),
      }
    }

    // BlogPage and ProjectPage
    if (!f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new TransformError(`${record}: date ${JSON.stringify(f.date)} is not YYYY-MM-DD`)
    if (typeof f.intro !== 'string' || f.intro.trim() === '') throw new TransformError(`${record}: intro is empty (required)`)
    if (f.intro.length > 250) throw new TransformError(`${record}: intro is ${f.intro.length} characters (max 250)`)
    if (!f.project_audience || !audienceValues.includes(f.project_audience)) {
      throw new TransformError(`${record}: project_audience ${JSON.stringify(f.project_audience)} is not one of ${audienceValues.join(', ')}`)
    }
    if (typeof f.is_unlisted !== 'boolean') throw new TransformError(`${record}: is_unlisted is not a boolean`)
    const author = singleAuthor(revision.children.blog_authors, record)
    const hero = heroMedia(f.content_visuals, record)
    const contentImage = imageWithAlt(f.content_image_id, `${record} content_image`)
    const common = {
      _id,
      title,
      slug: slug(f.slug, record),
      date: f.date,
      intro: f.intro,
      isUnlisted: f.is_unlisted,
      audience: f.project_audience,
      ...(author ? {author} : {}),
      ...(hero ? {heroMedia: hero} : {}),
      ...(contentImage ? {contentImage} : {}),
      ...(body.length ? {body} : {}),
      ...(seoValue ? {seo: seoValue} : {}),
    }
    if (page.type === 'blog.BlogPage') {
      if (f.preview_image_id != null) throw new TransformError(`${record}: blog posts have no preview image field`)
      return {...common, _type: 'blogPost', legacy: pageLegacy(page)}
    }
    if (!f.project_type || !projectTypeValues.includes(f.project_type)) {
      throw new TransformError(`${record}: project_type ${JSON.stringify(f.project_type)} is not one of ${projectTypeValues.join(', ')}`)
    }
    const previewImage = imageWithAlt(f.preview_image_id, `${record} preview_image`)
    const mediums = tagRefs(revision.tags.medium, 'medium', record)
    const technologies = tagRefs(revision.tags.technologies, 'technologies', record)
    const testimonials = orderedRefs(revision.children.testimonials, 'testimonial_id', 'testimonial', (id) => data.snippets['home.Testimonial'].some((t) => t.id === id), record)
    const website = text(f.website ?? undefined)
    if (website && !/^https?:\/\//.test(website)) throw new TransformError(`${record}: website ${website} is not an http(s) URL`)
    return {
      ...common,
      _type: 'project',
      projectType: f.project_type,
      ...(previewImage ? {previewImage} : {}),
      ...(text(f.client ?? undefined) ? {client: f.client} : {}),
      ...(website ? {website} : {}),
      ...(mediums ? {mediums} : {}),
      ...(technologies ? {technologies} : {}),
      ...(testimonials ? {testimonials} : {}),
      legacy: pageLegacy(page),
    }
  }

  for (const page of data.pages) {
    if (page.type === TREE_ROOT_TYPE) {
      if (page.depth !== 1) throw new TransformError(`page ${page.id} is a ${TREE_ROOT_TYPE} below the root`)
      mapping.push({wagtail: `page ${page.id} (${page.type}, tree root)`, sanity: []})
      continue
    }
    if (!isMigratedPageType(page.type)) {
      errors.push(`page ${page.id}: page type ${page.type} is not supported`)
      continue
    }
    if (page.alias_of_id !== null) {
      errors.push(`page ${page.id}: alias pages are not supported`)
      continue
    }
    try {
      const ids: string[] = []
      for (const {state, revision} of migratedRevisions(page)) {
        const doc = pageDocument(page, revision, state)
        documents.push(doc)
        ids.push(doc._id)
      }
      mapping.push({wagtail: `page ${page.id} (${page.type}${page.live ? ', live' : ', not live'}${page.has_unpublished_changes ? ', unpublished changes' : ''})`, sanity: ids})
    } catch (error) {
      if (!(error instanceof TransformError || error instanceof RichTextError)) throw error
      errors.push(error.message)
    }
  }

  // --- Redirects ------------------------------------------------------------------------
  for (const redirect of data.redirects) {
    const record = `redirect ${redirect.id}`
    try {
      const source = redirect.old_path
      if (validation.validateSitePath(source) !== true) throw new TransformError(`${record}: source ${source} is not a site path`)
      let destination: string
      // A redirect to a page that is not on the site would only lead to a 404 (and reveal the
      // draft's slug), so it is migrated as a draft, to be published together with its page.
      let draftOnly = false
      if (redirect.redirect_page_id != null) {
        const page = pagesById.get(redirect.redirect_page_id)
        if (!page) throw new TransformError(`${record}: page ${redirect.redirect_page_id} is not in the export`)
        const revision = page.live ? page.published : page.latest
        if (!revision) throw new TransformError(`${record}: page ${page.id} has no revision`)
        const targetSlug = revision.fields.slug
        destination = pageSitePath(page, targetSlug)
        if (redirect.redirect_page_route_path) destination = `${destination.replace(/\/$/, '')}/${redirect.redirect_page_route_path.replace(/^\//, '')}`
        if (!page.live) {
          draftOnly = true
          issues.push({
            record,
            level: 'warning',
            code: 'redirect-to-draft',
            message: `redirects ${source} to ${destination}, a page that is not published; migrated as a draft redirect, publish it together with the page`,
          })
        }
      } else if (text(redirect.redirect_link)) {
        destination = redirect.redirect_link
      } else {
        throw new TransformError(`${record}: no target page and no link`)
      }
      if (validation.validatePathOrAbsoluteUrl(destination) !== true) throw new TransformError(`${record}: destination ${destination} is not a path or URL`)
      if (destination === source) throw new TransformError(`${record}: destination equals source`)
      const id = `${draftOnly ? 'drafts.' : ''}redirect-${redirect.id}`
      documents.push({_id: id, _type: 'redirect', source, destination, permanent: redirect.is_permanent})
      mapping.push({wagtail: `wagtailredirects.Redirect ${redirect.id}`, sanity: [id]})
    } catch (error) {
      if (!(error instanceof TransformError)) throw error
      errors.push(error.message)
    }
  }

  // --- Videos ---------------------------------------------------------------------------
  for (const media of [...data.media].sort((a, b) => a.id - b.id)) {
    const video = mux.videos[String(media.id)]
    if (!video) {
      const pending = mux.pending.find((p) => p.mediaId === media.id)
      if (!pending) {
        errors.push(`media ${media.id}: no Mux asset and not pending (run the mux step)`)
        continue
      }
      // Validation fails while any video is pending; the transform still writes everything else.
      issues.push({record: `media ${media.id}`, level: 'warning', code: 'video-pending', message: `no Mux asset yet: ${pending.reason}`})
      mapping.push({wagtail: `wagtailmedia.Media ${media.id}`, sanity: []})
      continue
    }
    documents.push(muxVideoDocument(media.id, video))
    mapping.push({wagtail: `wagtailmedia.Media ${media.id}`, sanity: [`mux-video-${media.id}`]})
  }

  // --- Whole-set checks ----------------------------------------------------------------
  const ids = new Set<string>()
  for (const doc of documents) {
    if (ids.has(doc._id)) errors.push(`document id ${doc._id} is produced twice`)
    ids.add(doc._id)
  }
  for (const type of ['blogPost', 'project', 'flexPage', 'medium', 'technology'] as const) {
    for (const draft of [false, true]) {
      const seen = new Map<string, string>()
      for (const doc of documents) {
        if (doc._type !== type || doc._id.startsWith('drafts.') !== draft) continue
        const current = (doc.slug as {current: string}).current
        const other = seen.get(current)
        // A draft and the published version of the same document may share a slug.
        if (other) errors.push(`${type} slug "${current}" is used by ${other} and ${doc._id}`)
        seen.set(current, doc._id)
      }
    }
  }
  const redirectSources = new Map<string, string>()
  for (const doc of documents.filter((d) => d._type === 'redirect')) {
    const other = redirectSources.get(doc.source as string)
    if (other) errors.push(`redirect source ${String(doc.source)} is used by ${other} and ${doc._id}`)
    redirectSources.set(doc.source as string, doc._id)
  }

  for (const fix of LINK_HREF_FIXES) {
    if (!appliedFixes.has(fix)) errors.push(`content fix for page ${fix.pageId}: link ${JSON.stringify(fix.from)} in block ${fix.blockId} is not in the export any more; remove the fix`)
  }

  for (const message of errors) issues.push({record: message.split(':')[0] ?? 'transform', level: 'error', code: 'transform-failed', message})
  return {documents, issues, tagMerges, linkTextFlattening, mapping}
}

/**
 * The mux.videoAsset document for a Wagtail media item that is on Mux, in the shape
 * sanity-plugin-mux-input stores. Used by the transform and by the `videos` step.
 */
export function muxVideoDocument(mediaId: number, video: MuxMapEntry): SanityDocument {
  return {
    _id: `mux-video-${mediaId}`,
    _type: 'mux.videoAsset',
    assetId: video.assetId,
    playbackId: video.playbackId,
    status: video.status,
    filename: video.filename,
    data: withArrayKeys(video.asset),
  }
}

/**
 * The Mux asset JSON with a deterministic `_key` on every object in every array (tracks,
 * playback_ids, ...): the item's own `id` when it has a unique one, else its index. Sanity's
 * importer would otherwise add random keys, and reruns would not converge.
 */
export function withArrayKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    const ids = value.map((item) => (item && typeof item === 'object' && typeof (item as {id?: unknown}).id === 'string' ? (item as {id: string}).id : null))
    const idsUnique = ids.every((id) => id !== null) && new Set(ids).size === ids.length
    return value.map((item, index) => {
      const keyed = withArrayKeys(item)
      if (!keyed || typeof keyed !== 'object') return keyed
      return {_key: idsUnique ? ids[index] : `i${index}`, ...(keyed as Record<string, unknown>)}
    }) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withArrayKeys(v)])) as T
  }
  return value
}

/**
 * Service link_text is rich text in Wagtail but only ever used as a link label. It becomes a
 * plain string; any formatting, extra paragraph or line break is reported as lost.
 */
export function flattenLinkText(html: string, record: string): {html: string; text: string; lost: string[]} {
  const body = new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document.body
  const lost: string[] = []
  const blocks = Array.from(body.children)
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === 3 && /\S/.test(node.textContent ?? '')) lost.push('text outside a paragraph')
  }
  if (blocks.length > 1) lost.push(`${blocks.length} paragraphs joined with a space`)
  for (const block of blocks) {
    const tag = block.tagName.toLowerCase()
    if (tag !== 'p') lost.push(`<${tag}> block became plain text`)
    for (const el of Array.from(block.querySelectorAll('*'))) {
      const inner = el.tagName.toLowerCase()
      if (inner === 'br') lost.push('line break became a space')
      else if (inner === 'a') lost.push(`link to ${el.getAttribute('href') ?? el.getAttribute('linktype')} removed`)
      else lost.push(`<${inner}> formatting removed`)
    }
  }
  for (const br of Array.from(body.querySelectorAll('br'))) br.replaceWith(' ')
  const plain = blocks.length
    ? blocks.map((b) => (b.textContent ?? '').trim()).filter(Boolean).join(' ')
    : (body.textContent ?? '').trim()
  if (!plain && html.trim()) throw new RichTextError(`${record}: link_text has markup but no text`)
  return {html, text: plain.replace(/\s+/g, ' '), lost}
}
