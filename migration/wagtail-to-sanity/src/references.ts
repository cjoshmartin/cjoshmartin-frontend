/**
 * Finds every image, document, media item and page that migrated content refers to.
 *
 * "Migrated content" is every page revision that becomes a Sanity document (the published
 * revision of live pages and the latest revision of pages with unpublished changes or that were
 * never published) and every snippet.
 */
import {JSDOM} from 'jsdom'

import {isMigratedPageType, type PageRevision, type StreamBlock, type WagtailExport} from './wagtail'

export type ReferenceKind = 'image' | 'document' | 'media' | 'page'

export interface Reference {
  kind: ReferenceKind
  id: number
  /** Where the reference is, e.g. "page 7 (published) body[3] rich text". */
  location: string
}

/** The revisions of a page that become Sanity documents. */
export function migratedRevisions(
  page: WagtailExport['pages'][number],
): {state: 'published' | 'draft'; revision: PageRevision}[] {
  const out: {state: 'published' | 'draft'; revision: PageRevision}[] = []
  if (page.live) {
    if (!page.published) throw new Error(`page ${page.id} is live but has no published revision`)
    out.push({state: 'published', revision: page.published})
  }
  if (!page.live || page.has_unpublished_changes) {
    if (!page.latest) {
      throw new Error(
        `page ${page.id} is ${page.live ? 'live with unpublished changes' : 'not live'} but has no latest revision`,
      )
    }
    out.push({state: 'draft', revision: page.latest})
  }
  return out
}

/** References inside one database-format rich text value. */
export function richTextReferences(html: string, location: string): Reference[] {
  const refs: Reference[] = []
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document
  for (const el of Array.from(doc.querySelectorAll('embed[embedtype="image"]'))) {
    refs.push({kind: 'image', id: Number(el.getAttribute('id')), location})
  }
  for (const el of Array.from(doc.querySelectorAll('a[linktype]'))) {
    const linktype = el.getAttribute('linktype')
    if (linktype === 'document' || linktype === 'page') {
      refs.push({kind: linktype, id: Number(el.getAttribute('id')), location})
    }
  }
  return refs
}

function streamReferences(blocks: StreamBlock[], location: string): Reference[] {
  const refs: Reference[] = []
  blocks.forEach((block, index) => {
    const where = `${location}[${index}] ${block.type}`
    switch (block.type) {
      case 'full_richtext':
        refs.push(...richTextReferences(String(block.value), where))
        break
      case 'stl_picker':
        refs.push({kind: 'document', id: (block.value as {file: number}).file, location: where})
        break
      case 'media':
        refs.push({kind: 'media', id: block.value as number, location: where})
        break
      case 'image':
        refs.push({kind: 'image', id: block.value as number, location: where})
        break
      default:
        break
    }
  })
  return refs
}

export function collectReferences(data: WagtailExport): Reference[] {
  const refs: Reference[] = []
  for (const page of data.pages) {
    if (!isMigratedPageType(page.type)) continue
    for (const {state, revision} of migratedRevisions(page)) {
      const f = revision.fields
      const where = `page ${page.id} (${state})`
      if (typeof f.body === 'string') refs.push(...richTextReferences(f.body, `${where} body`))
      else if (Array.isArray(f.body)) refs.push(...streamReferences(f.body, `${where} body`))
      if (Array.isArray(f.content_visuals)) {
        refs.push(...streamReferences(f.content_visuals, `${where} content_visuals`))
      }
      if (f.content_image_id != null) {
        refs.push({kind: 'image', id: f.content_image_id, location: `${where} content_image`})
      }
      if (f.preview_image_id != null) {
        refs.push({kind: 'image', id: f.preview_image_id, location: `${where} preview_image`})
      }
    }
  }
  for (const author of data.snippets['home.Author']) {
    if (author.image_id != null) {
      refs.push({kind: 'image', id: author.image_id, location: `author ${author.id} image`})
    }
    if (author.bio) refs.push(...richTextReferences(author.bio, `author ${author.id} bio`))
  }
  for (const t of data.snippets['home.Testimonial']) {
    if (t.image_id != null) {
      refs.push({kind: 'image', id: t.image_id, location: `testimonial ${t.id} image`})
    }
    if (t.body) refs.push(...richTextReferences(t.body, `testimonial ${t.id} body`))
  }
  for (const s of data.snippets['home.Service']) {
    if (s.image_id != null) {
      refs.push({kind: 'image', id: s.image_id, location: `service ${s.id} image`})
    }
    if (s.description) {
      refs.push(...richTextReferences(s.description, `service ${s.id} description`))
    }
    if (s.link_text) refs.push(...richTextReferences(s.link_text, `service ${s.id} link_text`))
  }
  for (const r of data.redirects) {
    if (r.redirect_page_id != null) {
      refs.push({kind: 'page', id: r.redirect_page_id, location: `redirect ${r.id}`})
    }
  }
  return refs
}
