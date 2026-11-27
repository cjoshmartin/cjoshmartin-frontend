import { stegaClean } from '@sanity/client/stega'

/*
 * Helpers that read Portable Text bodies. They are shared by the renderer (PortableTextBody), the
 * blog outline and the read-time label, so anchors and estimates always agree.
 */

/** The smallest shape of a Portable Text item these helpers need. */
interface PortableTextItem {
  _type: string
  _key: string
  style?: string
  children?: ReadonlyArray<{ _type: string; text?: string }>
  code?: string
}

const HEADING_STYLES = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
type HeadingStyle = (typeof HEADING_STYLES)[number]

function isHeadingStyle(style: string | undefined): style is HeadingStyle {
  return (HEADING_STYLES as readonly string[]).includes(style ?? '')
}

/** Plain text of one text block, with stega encoding removed. */
export function blockText(item: PortableTextItem): string {
  return stegaClean((item.children ?? []).map((child) => child.text ?? '').join(''))
}

/**
 * The anchor algorithm the Wagtail-era site used for heading ids (lowercase, drop everything but
 * letters, digits, whitespace and hyphens, turn whitespace runs into hyphens). Keeping it unchanged
 * keeps every existing `#anchor` link working.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .trim()
}

export interface Heading {
  /** `_key` of the heading block. */
  key: string
  /** Unique `id` attribute for the heading within this body. */
  id: string
  title: string
  /** 1 for h1 ... 6 for h6. */
  level: number
}

/**
 * Every heading in the body with a unique id. The first heading with a given slug keeps it as is
 * (matching the old site), later ones get `-2`, `-3`, ... A heading whose text has no letters or
 * digits falls back to `header-<n>`, where n counts headings across the whole body.
 */
export function getHeadings(body: ReadonlyArray<PortableTextItem> | null | undefined): Heading[] {
  const used = new Set<string>()
  const headings: Heading[] = []

  for (const item of body ?? []) {
    if (item._type !== 'block' || !isHeadingStyle(item.style)) {
      continue
    }
    const title = blockText(item)
    const base = slugifyHeading(title) || `header-${headings.length + 1}`
    let id = base
    for (let suffix = 2; used.has(id); suffix += 1) {
      id = `${base}-${suffix}`
    }
    used.add(id)
    headings.push({ key: item._key, id, title, level: Number(item.style.slice(1)) })
  }

  return headings
}

export const WORDS_PER_MINUTE = 200

/** What the read-time estimate counts: the text of every text block plus every code block. */
export interface ReadingSource {
  text: string | null | undefined
  codeTexts: ReadonlyArray<string | null | undefined> | null | undefined
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length
}

/** Minutes to read at 200 words per minute, rounded up. Missing text counts as zero words. */
export function readingMinutes({ text, codeTexts }: ReadingSource): number {
  const words =
    countWords(stegaClean(text ?? '')) +
    (codeTexts ?? []).reduce((total, code) => total + countWords(stegaClean(code ?? '')), 0)
  return Math.ceil(words / WORDS_PER_MINUTE)
}

/** The reading source of a full body, equivalent to GROQ `pt::text(body)` plus its code blocks. */
export function readingSourceFromBody(body: ReadonlyArray<PortableTextItem> | null | undefined): ReadingSource {
  const items = body ?? []
  return {
    text: items
      .filter((item) => item._type === 'block')
      .map(blockText)
      .join('\n\n'),
    codeTexts: items.filter((item) => item._type === 'code').map((item) => item.code),
  }
}
