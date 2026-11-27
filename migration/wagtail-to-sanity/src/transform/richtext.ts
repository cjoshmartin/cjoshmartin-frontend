/**
 * Wagtail database-format rich text -> Portable Text.
 *
 * The conversion itself is @portabletext/block-tools (htmlToBlocks + JSDOM) with the Studio's
 * compiled `blockContent` type, plus custom rules for what only Wagtail has:
 *
 *   <embed embedtype="image" id format alt>  -> imageBlock (original image asset, alt, layout)
 *   <embed embedtype="media" url>            -> youtube
 *   <a linktype="page" id>                   -> internalLink annotation (reference)
 *   <a linktype="document" id>               -> fileLink annotation (file asset)
 *   <a href>                                 -> link annotation (href, openInNewTab: false)
 *   <hr>                                     -> divider
 *   <br>                                     -> "\n" inside the span text (block-tools default)
 *
 * Before converting, the HTML is checked against a strict allowlist of elements, attributes and
 * nesting. Anything else throws a RichTextError, which fails the transform.
 *
 * Keys are deterministic: a block made from an element with Wagtail's `data-block-key` gets
 * `<keyPrefix><data-block-key>`, other blocks (embeds, hr) get `<keyPrefix>n<index>`, and spans
 * and mark definitions are derived from their block's key. Draftail keys are only unique within
 * one rich-text value, so StreamField bodies pass the StreamField block id as the prefix. The
 * caller passes a KeyRegistry so keys stay unique across a whole array.
 */
import {htmlToBlocks} from '@portabletext/block-tools'
import {JSDOM} from 'jsdom'

import type {StudioSchema} from './schema'

export class RichTextError extends Error {}

export interface PTSpan {
  _type: 'span'
  _key: string
  text: string
  marks: string[]
}

export interface PTMarkDef {
  _type: string
  _key: string
  [field: string]: unknown
}

export interface PTBlock {
  _type: 'block'
  _key: string
  style: string
  markDefs: PTMarkDef[]
  children: PTSpan[]
  listItem?: string
  level?: number
}

export interface PTObject {
  _type: string
  _key: string
  [field: string]: unknown
}

export type PTItem = PTBlock | PTObject

export function isTextBlock(item: PTItem): item is PTBlock {
  return item._type === 'block'
}

export interface Issue {
  record: string
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
}

/** Hands out `_key` values that are unique within one array. */
export class KeyRegistry {
  private readonly used = new Set<string>()

  constructor(
    private readonly record: string,
    private readonly issues: Issue[],
  ) {}

  claim(preferred: string): string {
    if (!this.used.has(preferred)) {
      this.used.add(preferred)
      return preferred
    }
    for (let n = 2; ; n++) {
      const candidate = `${preferred}-${n}`
      if (!this.used.has(candidate)) {
        this.used.add(candidate)
        this.issues.push({
          record: this.record,
          level: 'info',
          code: 'duplicate-key',
          message: `key "${preferred}" was already used in this array; this item gets "${candidate}"`,
        })
        return candidate
      }
    }
  }
}

export interface ResolvedImage {
  assetId: string
}

export interface ResolvedPage {
  documentId: string
  /** False when the target only exists as a draft: the reference is then weak. */
  published: boolean
  type: string
}

export interface RichTextContext {
  record: string
  schema: StudioSchema
  keys: KeyRegistry
  /** Prepended to every block key ("" for a plain rich-text field). */
  keyPrefix: string
  issues: Issue[]
  image(id: number): ResolvedImage
  document(id: number): string
  page(id: number): ResolvedPage
  /** The href a `<a href>` link gets in Sanity (the Wagtail value unless src/content-fixes.ts corrects it). */
  linkHref(href: string): string
}

const TEXT_BLOCK_STYLES: Record<string, string> = {
  p: 'normal',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  blockquote: 'blockquote',
}

/** Inline elements and the decorator block-tools turns each into (br becomes "\n"). */
const INLINE_DECORATORS: Record<string, string | null> = {
  b: 'strong',
  strong: 'strong',
  i: 'em',
  em: 'em',
  code: 'code',
  u: 'underline',
  s: 'strike-through',
  strike: 'strike-through',
  del: 'strike-through',
  br: null,
  a: null,
}

const LIST_TYPES: Record<string, string> = {ul: 'bullet', ol: 'number'}

const IMAGE_FORMATS: Record<string, string> = {fullwidth: 'fullwidth', left: 'left', right: 'right'}

interface Unit {
  kind: 'text' | 'object'
  key: string | null
  style?: string
  listItem?: string
  level?: number
  objectType?: string
}

function fail(ctx: RichTextContext, message: string): never {
  throw new RichTextError(`${ctx.record}: ${message}`)
}

function describe(el: Element): string {
  return el.outerHTML.length > 160 ? `${el.outerHTML.slice(0, 160)}...` : el.outerHTML
}

function checkAttributes(ctx: RichTextContext, el: Element, allowed: string[], required: string[] = []): void {
  for (const attr of Array.from(el.attributes)) {
    if (!allowed.includes(attr.name)) fail(ctx, `attribute "${attr.name}" is not allowed on <${el.tagName.toLowerCase()}>: ${describe(el)}`)
  }
  for (const name of required) {
    if (!el.hasAttribute(name)) fail(ctx, `<${el.tagName.toLowerCase()}> needs a "${name}" attribute: ${describe(el)}`)
  }
}

function checkInline(ctx: RichTextContext, nodes: NodeListOf<ChildNode>, insideLink: boolean): void {
  for (const node of Array.from(nodes)) {
    if (node.nodeType === 3) continue // text
    if (node.nodeType !== 1) fail(ctx, `unexpected node type ${node.nodeType} inside inline content`)
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (!(tag in INLINE_DECORATORS)) fail(ctx, `<${tag}> is not an allowed inline element: ${describe(el)}`)
    if (tag === 'a') {
      if (insideLink) fail(ctx, `nested links: ${describe(el)}`)
      const linktype = el.getAttribute('linktype')
      if (linktype === null) checkAttributes(ctx, el, ['href'], ['href'])
      else if (linktype === 'page' || linktype === 'document') checkAttributes(ctx, el, ['linktype', 'id'], ['id'])
      else fail(ctx, `link type "${linktype}" is not supported: ${describe(el)}`)
      checkInline(ctx, el.childNodes, true)
    } else {
      checkAttributes(ctx, el, [])
      if (tag === 'br' && el.childNodes.length) fail(ctx, `<br> with content: ${describe(el)}`)
      checkInline(ctx, el.childNodes, insideLink)
    }
  }
}

function collectList(ctx: RichTextContext, list: Element, level: number, units: Unit[]): void {
  const listItem = LIST_TYPES[list.tagName.toLowerCase()]!
  checkAttributes(ctx, list, [])
  for (const node of Array.from(list.childNodes)) {
    if (node.nodeType === 3 && !/\S/.test(node.textContent ?? '')) continue
    if (node.nodeType !== 1 || (node as Element).tagName.toLowerCase() !== 'li') {
      fail(ctx, `only <li> may be a child of <${list.tagName.toLowerCase()}>, found ${node.nodeType === 1 ? describe(node as Element) : JSON.stringify(node.textContent)}`)
    }
    const li = node as Element
    checkAttributes(ctx, li, ['data-block-key'])
    // Inline content first, then optionally nested lists (block-tools turns them into deeper levels).
    const children = Array.from(li.childNodes)
    const firstNested = children.findIndex((c) => c.nodeType === 1 && (c as Element).tagName.toLowerCase() in LIST_TYPES)
    const inline = firstNested === -1 ? children : children.slice(0, firstNested)
    const nested = firstNested === -1 ? [] : children.slice(firstNested)
    const fragment = li.ownerDocument.createElement('span')
    for (const child of inline) fragment.appendChild(child.cloneNode(true))
    checkInline(ctx, fragment.childNodes, false)
    units.push({kind: 'text', key: li.getAttribute('data-block-key'), style: 'normal', listItem, level})
    for (const child of nested) {
      if (child.nodeType === 3 && !/\S/.test(child.textContent ?? '')) continue
      if (child.nodeType !== 1 || !((child as Element).tagName.toLowerCase() in LIST_TYPES)) {
        fail(ctx, `content after a nested list inside <li>: ${describe(li)}`)
      }
      collectList(ctx, child as Element, level + 1, units)
    }
  }
}

/** Checks the allowlist and returns the Portable Text items the HTML must produce, in order. */
function collectUnits(ctx: RichTextContext, body: HTMLElement): Unit[] {
  const units: Unit[] = []
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === 3) {
      if (/\S/.test(node.textContent ?? '')) fail(ctx, `text outside a block: ${JSON.stringify(node.textContent)}`)
      continue
    }
    if (node.nodeType !== 1) fail(ctx, `unexpected node type ${node.nodeType} at the top level`)
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (tag in TEXT_BLOCK_STYLES) {
      checkAttributes(ctx, el, ['data-block-key'])
      checkInline(ctx, el.childNodes, false)
      units.push({kind: 'text', key: el.getAttribute('data-block-key'), style: TEXT_BLOCK_STYLES[tag]})
    } else if (tag in LIST_TYPES) {
      collectList(ctx, el, 1, units)
    } else if (tag === 'embed') {
      const embedtype = el.getAttribute('embedtype')
      if (embedtype === 'image') {
        checkAttributes(ctx, el, ['embedtype', 'id', 'format', 'alt'], ['id', 'format'])
        units.push({kind: 'object', key: null, objectType: 'imageBlock'})
      } else if (embedtype === 'media') {
        checkAttributes(ctx, el, ['embedtype', 'url'], ['url'])
        units.push({kind: 'object', key: null, objectType: 'youtube'})
      } else {
        fail(ctx, `embed type "${embedtype}" is not supported: ${describe(el)}`)
      }
    } else if (tag === 'hr') {
      checkAttributes(ctx, el, [])
      if (el.childNodes.length) fail(ctx, `<hr> with content`)
      units.push({kind: 'object', key: null, objectType: 'divider'})
    } else {
      fail(ctx, `<${tag}> is not an allowed block element: ${describe(el)}`)
    }
  }
  return units
}

function positiveInt(ctx: RichTextContext, value: string | null, what: string): number {
  if (value === null || !/^\d+$/.test(value) || Number(value) <= 0) fail(ctx, `${what} "${value}" is not a positive integer`)
  return Number(value)
}

export function richTextToBlocks(html: string, ctx: RichTextContext): PTItem[] {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  const body = dom.window.document.body
  const units = collectUnits(ctx, body)
  if (units.length === 0) return []

  const {schema} = ctx
  let generated = 0
  const raw = htmlToBlocks(html, schema.blockContent as never, {
    parseHtml: (source: string) => new JSDOM(`<!doctype html><html><body>${source}</body></html>`).window.document,
    keyGenerator: () => `tmp${generated++}`,
    rules: [
      {
        deserialize(node: Node, next: (nodes: NodeListOf<ChildNode> | ChildNode[]) => unknown, block: (b: Record<string, unknown>) => unknown) {
          if (node.nodeType !== 1) return undefined
          const el = node as Element
          const tag = el.tagName.toLowerCase()
          if (tag === 'embed') {
            const embedtype = el.getAttribute('embedtype')
            if (embedtype === 'image') {
              const image = ctx.image(positiveInt(ctx, el.getAttribute('id'), 'image embed id'))
              const format = el.getAttribute('format') ?? ''
              const layout = IMAGE_FORMATS[format]
              if (!layout) fail(ctx, `image embed format "${format}" has no imageBlock layout`)
              const alt = (el.getAttribute('alt') ?? '').trim()
              if (!alt) ctx.issues.push({record: ctx.record, level: 'warning', code: 'image-without-alt', message: `image ${el.getAttribute('id')} has no alt text`})
              return block({
                _type: 'imageBlock',
                asset: {_type: 'reference', _ref: image.assetId},
                ...(alt ? {alt} : {}),
                layout,
              })
            }
            const url = el.getAttribute('url') ?? ''
            if (!schema.validation.getYouTubeVideoId(url)) fail(ctx, `media embed URL is not a YouTube video: ${url}`)
            return block({_type: 'youtube', url})
          }
          if (tag === 'hr') return block({_type: 'divider', style: 'line'})
          if (tag === 'a') {
            const linktype = el.getAttribute('linktype')
            let markDef: Record<string, unknown>
            if (linktype === 'page') {
              const target = ctx.page(positiveInt(ctx, el.getAttribute('id'), 'page link id'))
              markDef = {
                _type: 'internalLink',
                reference: target.published
                  ? {_type: 'reference', _ref: target.documentId}
                  : {_type: 'reference', _ref: target.documentId, _weak: true, _strengthenOnPublish: {type: target.type}},
              }
              if (!target.published) {
                ctx.issues.push({record: ctx.record, level: 'warning', code: 'link-to-draft', message: `internal link to page ${el.getAttribute('id')}, which is only a draft (weak reference)`})
              }
            } else if (linktype === 'document') {
              const assetId = ctx.document(positiveInt(ctx, el.getAttribute('id'), 'document link id'))
              markDef = {_type: 'fileLink', file: {_type: 'file', asset: {_type: 'reference', _ref: assetId}}}
            } else {
              const href = el.getAttribute('href') ?? ''
              if (!href.trim()) fail(ctx, `link without href: ${describe(el)}`)
              markDef = {_type: 'link', href: ctx.linkHref(href), openInNewTab: false}
            }
            // block-tools takes the mark key from markDef._key; without one the spans get null marks.
            return {_type: '__annotation', markDef: {...markDef, _key: `tmp${generated++}`}, children: next(el.childNodes)}
          }
          return undefined
        },
      },
    ] as never,
  }) as unknown as Record<string, unknown>[]

  if (raw.length !== units.length) {
    fail(
      ctx,
      `block-tools produced ${raw.length} items, the HTML has ${units.length} blocks ` +
        `(expected ${units.map((u) => u.objectType ?? u.style).join(',')}, got ${raw.map((r) => (r._type === 'block' ? r.style : r._type)).join(',')})`,
    )
  }

  const allowedDecorators = new Set(schema.block.decorators)
  const allowedAnnotations = new Set(schema.block.annotations)
  const allowedObjects = new Set(schema.blockObjects)
  return raw.map((item, index): PTItem => {
    const unit = units[index]!
    const key = ctx.keys.claim(`${ctx.keyPrefix}${unit.key ?? `n${index}`}`)
    if (unit.kind === 'object') {
      if (item._type !== unit.objectType || !allowedObjects.has(item._type as string)) {
        fail(ctx, `item ${index} should be ${unit.objectType}, block-tools produced ${String(item._type)}`)
      }
      const {_key: _ignored, ...rest} = item
      return {...rest, _type: item._type as string, _key: key}
    }
    if (item._type !== 'block') fail(ctx, `item ${index} should be a text block, block-tools produced ${String(item._type)}`)
    if (item.style !== unit.style) fail(ctx, `item ${index} should have style ${unit.style}, got ${String(item.style)}`)
    if ((item.listItem ?? undefined) !== unit.listItem || (item.level ?? undefined) !== unit.level) {
      fail(ctx, `item ${index} should be list ${unit.listItem ?? 'none'} level ${unit.level ?? '-'}, got ${String(item.listItem)} level ${String(item.level)}`)
    }
    const markKeys = new Map<string, string>()
    const markDefs = ((item.markDefs as PTMarkDef[] | undefined) ?? []).map((def, j) => {
      if (!allowedAnnotations.has(def._type)) fail(ctx, `annotation ${def._type} is not in the schema`)
      if (typeof def._key !== 'string' || markKeys.has(def._key)) fail(ctx, `annotation ${def._type} in block ${index} has no unique key`)
      const newKey = `${key}m${j}`
      markKeys.set(def._key, newKey)
      return {...def, _key: newKey}
    })
    const children = ((item.children as Record<string, unknown>[] | undefined) ?? []).map((child, j): PTSpan => {
      if (child._type !== 'span' || typeof child.text !== 'string') {
        fail(ctx, `block ${index} has a ${String(child._type)} child; only spans are allowed`)
      }
      const marks = ((child.marks as string[] | undefined) ?? []).map((mark) => {
        if (allowedDecorators.has(mark)) return mark
        const mapped = markKeys.get(mark)
        if (!mapped) fail(ctx, `span mark "${mark}" is neither a decorator nor an annotation`)
        return mapped
      })
      return {_type: 'span', _key: `${key}s${j}`, text: child.text, marks}
    })
    if (children.length === 0) children.push({_type: 'span', _key: `${key}s0`, text: '', marks: []})
    const used = new Set(children.flatMap((c) => c.marks))
    for (const def of markDefs) {
      if (!used.has(def._key)) fail(ctx, `annotation ${def._type} in block ${index} is not used by any span`)
    }
    return {
      _type: 'block',
      _key: key,
      style: unit.style!,
      markDefs,
      children,
      ...(unit.listItem ? {listItem: unit.listItem, level: unit.level} : {}),
    }
  })
}

/** Plain text of database-format rich text the way a reader sees it (block per line, br = newline). */
export function richTextPlainText(html: string): string {
  const doc = new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document
  for (const br of Array.from(doc.querySelectorAll('br'))) br.replaceWith('\n')
  const lines: string[] = []
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (tag in LIST_TYPES) walk(child)
      else if (tag === 'li') {
        const clone = child.cloneNode(true) as Element
        for (const nested of Array.from(clone.querySelectorAll('ul, ol'))) nested.remove()
        lines.push(clone.textContent ?? '')
        for (const nested of Array.from(child.children)) if (nested.tagName.toLowerCase() in LIST_TYPES) walk(nested)
      } else lines.push(child.textContent ?? '')
    }
  }
  walk(doc.body)
  return lines.join('\n')
}

/** Plain text of Portable Text: text blocks joined by newlines (custom blocks contribute nothing). */
export function portableTextPlainText(items: PTItem[]): string {
  return items
    .filter(isTextBlock)
    .map((block) => block.children.map((span) => span.text).join(''))
    .join('\n')
}

/** Compares texts ignoring whitespace only. */
export function sameIgnoringWhitespace(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
}
