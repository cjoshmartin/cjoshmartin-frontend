/**
 * Step 8: validate (plan §11.1-11.5). Reads the dataset back and checks it against the Wagtail
 * export, the bucket mirror and the converted MP4s, independently of the transform where possible:
 *
 *   counts           per type, published and drafts, against numbers derived from export.json
 *   assets           every bucket content file (videos included, as their originals) is an asset
 *                    with that sha1 and its Wagtail source; asset counts match
 *   hashes           every Wagtail image/document record's asset sha1 equals its file_hash
 *                    (or the explained bucket sha1 for the known overwritten objects)
 *   references       every _ref resolves (strong refs to published documents or assets)
 *   keys             every object in every array has a unique _key
 *   portableText     styles, lists and marks resolve; no raw HTML or entity text unless the
 *                    same literal text is in the Wagtail source
 *   textParity       normalized plain text of every Wagtail rich text vs the Portable Text, plus
 *                    block, embed, link and code structure (any non-whitespace difference fails)
 *   fieldParity      titles, slugs, dates, intros, flags, codes, authors, tags, ordered
 *                    references, images and SEO of every page and snippet
 *   videos           every video block follows video contract v2: `file` is the video/mp4 asset
 *                    with source video-to-mp4 made from `original` (the Wagtail upload), conversion
 *                    is ready with the current settings version, nothing needs conversion, each
 *                    MP4 is the checked output of the convert step and is served by the CDN; and
 *                    no Mux document, block or token is left
 *   asciiArt         testimonial art equals the live site's and was made from the current photo
 *   convergence      the dataset holds exactly the transformed documents, unchanged
 *   studioValidation `sanity documents validate --workspace <dataset> --level error`
 *
 * Writes reports/validation-<dataset>.json and reports/validation-<dataset>.md and fails
 * (non-zero exit) if any check fails.
 */
import {existsSync} from 'node:fs'
import path from 'node:path'

import {JSDOM} from 'jsdom'

import {
  CONVERTED_ASSET_SOURCE_NAME,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
} from '../../../../studio/functions/video-to-mp4/settings'
import {videoNeedsConversion} from '../../../../studio/schemaTypes/shared/video-conversion'
import {ASSET_SOURCE_NAME, gcsPublicUrl, mediaAssetSourceId, type Dataset, type DataPaths, type Secrets} from '../config'
import {linkHrefFix} from '../content-fixes'
import {KNOWN_DISCREPANCIES} from '../discrepancies'
import {migratedRevisions} from '../references'
import {sanityClient} from '../sanity'
import {pageDocumentId} from '../transform/documents'
import {
  isTextBlock,
  portableTextPlainText,
  richTextPlainText,
  sameIgnoringWhitespace,
  type PTBlock,
  type PTItem,
  type PTObject,
} from '../transform/richtext'
import {loadStudioSchema} from '../transform/schema'
import {log, readJson, stableStringify, writeJson, writeText} from '../util'
import {
  isMigratedPageType,
  loadExport,
  wagtailTagOrder,
  type PageRevision,
  type StreamBlock,
  type WagtailExport,
  type WagtailPage,
} from '../wagtail'
import {liveAsciiArt} from './ascii'
import type {AssetMap} from './assets'
import {readMp4Map} from './convert'
import type {Inventory} from './extract'
import {sanityCli} from './import'
import {ndjsonPath, readNdjson} from './transform'
import {originalMimeType, readVideoAssetMap, videoAssetMapPath} from './videos'

type Doc = {_id: string; _type: string; [field: string]: unknown}

interface CheckResult {
  name: string
  status: 'pass' | 'fail'
  summary: string
  failures: string[]
  explained: string[]
  details?: unknown
}

class Check {
  readonly failures: string[] = []
  readonly explained: string[] = []
  details: unknown
  summary = ''

  constructor(readonly name: string) {}

  fail(message: string): void {
    this.failures.push(message)
  }

  expect(condition: boolean, message: string): void {
    if (!condition) this.fail(message)
  }

  result(): CheckResult {
    return {
      name: this.name,
      status: this.failures.length ? 'fail' : 'pass',
      summary: this.summary,
      failures: this.failures,
      explained: this.explained,
      ...(this.details === undefined ? {} : {details: this.details}),
    }
  }
}

const SYSTEM_FIELDS = new Set(['_rev', '_createdAt', '_updatedAt', '_system'])

function stripSystem(doc: Doc): Doc {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !SYSTEM_FIELDS.has(k))) as Doc
}

function walk(value: unknown, at: string, visit: (value: unknown, at: string) => void): void {
  visit(value, at)
  if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${at}[${i}]`, visit))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`, visit)
  }
}

const HTML_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i
const HTML_ENTITY = /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i

/** A page as the old site's public API returned it (live-api-snapshot/page-<id>.json). */
interface LiveApiPage {
  id: number
  medium?: string[]
  technologies?: string[]
}

function liveApiPage(paths: DataPaths, pageId: number): LiveApiPage | undefined {
  const file = path.join(paths.liveSnapshot, `page-${pageId}.json`)
  if (!existsSync(file)) return undefined
  const page = readJson<LiveApiPage>(file)
  if (page.id !== pageId) throw new Error(`${file} holds page ${page.id}, not ${pageId}`)
  return page
}

/** Expected counts from export.json alone. */
function expectedCounts(data: WagtailExport): Record<string, {published: number; drafts: number}> {
  const counts: Record<string, {published: number; drafts: number}> = {}
  const add = (type: string, published: number, drafts: number) => {
    const entry = (counts[type] ??= {published: 0, drafts: 0})
    entry.published += published
    entry.drafts += drafts
  }
  const sanityType: Record<string, string> = {
    'home.HomePage': 'homePage',
    'flex.FlexPage': 'flexPage',
    'blog.BlogPage': 'blogPost',
    'blog.ProjectPage': 'project',
  }
  for (const page of data.pages) {
    const type = sanityType[page.type]
    if (!type) continue
    add(type, page.live ? 1 : 0, !page.live || page.has_unpublished_changes ? 1 : 0)
  }
  add('person', data.snippets['home.Author'].length, 0)
  add('testimonial', data.snippets['home.Testimonial'].length, 0)
  add('service', data.snippets['home.Service'].length, 0)
  // A redirect to a page that is not live is a draft until that page is published.
  const draftRedirects = data.redirects.filter((r) => r.redirect_page_id != null && data.pages.find((p) => p.id === r.redirect_page_id)?.live === false).length
  add('redirect', data.redirects.length - draftRedirects, draftRedirects)
  for (const [kind, type] of [['medium', 'medium'], ['technologies', 'technology']] as const) {
    const names = new Set<string>()
    for (const page of data.pages) {
      if (!isMigratedPageType(page.type)) continue
      for (const {revision} of migratedRevisions(page)) {
        for (const name of revision.tags[kind] ?? []) names.add(name.trim().replace(/\s+/g, ' ').toLowerCase())
      }
    }
    add(type, names.size, 0)
  }
  return counts
}

/** Counts of the parts of database-format rich text that must survive as Portable Text. */
function htmlStructure(html: string) {
  const body = new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document.body as HTMLElement
  const top = Array.from(body.children)
  const textBlocks = top.filter((el) => /^(p|h[1-6]|blockquote)$/i.test(el.tagName)).length + body.querySelectorAll('li').length
  return {
    textBlocks,
    images: body.querySelectorAll('embed[embedtype="image"]').length,
    youtube: body.querySelectorAll('embed[embedtype="media"]').length,
    dividers: body.querySelectorAll('hr').length,
    styles: top
      .flatMap((el) => (/^(ul|ol)$/i.test(el.tagName) ? Array.from(el.querySelectorAll('li')).map(() => 'li') : [el.tagName.toLowerCase()]))
      .filter((tag) => tag !== 'embed' && tag !== 'hr')
      .map((tag) => (tag === 'p' || tag === 'li' ? 'normal' : tag)),
    hrefs: Array.from(body.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? `${a.getAttribute('linktype')}:${a.getAttribute('id')}`),
    imageIds: Array.from(body.querySelectorAll('embed[embedtype="image"]')).map((e) => Number(e.getAttribute('id'))),
    youtubeUrls: Array.from(body.querySelectorAll('embed[embedtype="media"]')).map((e) => e.getAttribute('url') ?? ''),
  }
}

function ptStructure(items: PTItem[]) {
  const blocks = items.filter(isTextBlock) as PTBlock[]
  return {
    textBlocks: blocks.length,
    images: items.filter((i) => i._type === 'imageBlock').length,
    youtube: items.filter((i) => i._type === 'youtube').length,
    dividers: items.filter((i) => i._type === 'divider').length,
    styles: blocks.map((b) => b.style),
    hrefs: blocks.flatMap((b) => {
      // markDefs in the order their first span uses them, which is document order
      const order: string[] = []
      for (const span of b.children) for (const mark of span.marks) if (!order.includes(mark) && b.markDefs.some((d) => d._key === mark)) order.push(mark)
      return order.map((key) => {
        const def = b.markDefs.find((d) => d._key === key)!
        if (def._type === 'link') return String(def.href)
        if (def._type === 'internalLink') return `page:${String((def.reference as {_ref: string})._ref)}`
        return `document:${String(((def.file as {asset: {_ref: string}}).asset)._ref)}`
      })
    }),
    imageRefs: (items.filter((i) => i._type === 'imageBlock') as PTObject[]).map((i) => String((i.asset as {_ref: string})._ref)),
    youtubeUrls: (items.filter((i) => i._type === 'youtube') as PTObject[]).map((i) => String(i.url)),
  }
}

export async function validateDataset(paths: DataPaths, dataset: Dataset, secrets: Secrets): Promise<CheckResult[]> {
  const data = loadExport(paths.exportJson)
  const inventory = readJson<Inventory>(path.join(paths.state, 'inventory.json'))
  const assetMap = readJson<AssetMap>(path.join(paths.state, `assets-${dataset}.json`))
  const mp4Map = readMp4Map(paths)
  const videoMap = readVideoAssetMap(paths, dataset)
  if (!videoMap) throw new Error(`validate: ${videoAssetMapPath(paths, dataset)} does not exist; run the convert and videos steps`)
  const transformed = readNdjson(ndjsonPath(paths, dataset))
  const schema = await loadStudioSchema()
  const client = sanityClient(dataset, secrets)

  log(`validate: reading ${dataset}`)
  const all = await client.fetch<Doc[]>(`*[!(_id in path("_.**")) && !(_id in path("versions.**"))]`)
  const byId = new Map(all.map((d) => [d._id, d]))
  const assets = all.filter((d) => d._type === 'sanity.imageAsset' || d._type === 'sanity.fileAsset')
  // Documents under `secrets.` hold tokens; they are never read into a report (the videos check
  // only looks at their ids and types).
  const content = all.filter((d) => !d._type.startsWith('sanity.') && !d._id.startsWith('secrets.'))
  const checks: Check[] = []

  // --- counts ---------------------------------------------------------------------------
  {
    const check = new Check('counts')
    const expected = expectedCounts(data)
    const actual: Record<string, {published: number; drafts: number}> = {}
    for (const doc of content) {
      const entry = (actual[doc._type] ??= {published: 0, drafts: 0})
      if (doc._id.startsWith('drafts.')) entry.drafts++
      else entry.published++
    }
    for (const type of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const e = expected[type] ?? {published: 0, drafts: 0}
      const a = actual[type] ?? {published: 0, drafts: 0}
      check.expect(
        e.published === a.published && e.drafts === a.drafts,
        `${type}: expected ${e.published} published + ${e.drafts} drafts, found ${a.published} + ${a.drafts}`,
      )
    }
    check.details = {expected, actual}
    const total = (c: Record<string, {published: number; drafts: number}>) => Object.values(c).reduce((s, x) => s + x.published + x.drafts, 0)
    check.summary = `${total(actual)} documents in ${dataset}, ${total(expected)} expected from the export`
    checks.push(check)
  }

  // --- assets + hashes ------------------------------------------------------------------
  {
    const check = new Check('assets')
    const assetBySha = new Map(assets.map((a) => [`${a._type === 'sanity.imageAsset' ? 'image' : 'file'}:${String(a.sha1hash)}`, a]))
    const expectedKeys = new Set<string>()
    const mediaIdByPath = new Map(Object.entries(inventory.mediaFiles).map(([id, p]) => [p, Number(id)]))
    for (const file of inventory.files) {
      const type = file.folder === 'documents' || file.folder === 'media' ? 'file' : 'image'
      expectedKeys.add(`${type}:${file.sha1}`)
      const asset = assetBySha.get(`${type}:${file.sha1}`)
      const source = asset?.source as {name?: string; id?: string; url?: string} | undefined
      if (!asset) {
        check.fail(`${file.path}: no ${type} asset with sha1 ${file.sha1}`)
      } else if (file.folder === 'media') {
        // A video's original: the asset the video blocks keep in `original`.
        const mediaId = mediaIdByPath.get(file.path)
        const mapped = mediaId === undefined ? undefined : videoMap.videos[String(mediaId)]?.original.assetId
        if (mediaId === undefined) check.fail(`${file.path}: no Wagtail media record uses this file`)
        else if (mapped !== asset._id) check.fail(`${file.path}: video map says ${mapped}, dataset has ${asset._id}`)
        else if (source?.name !== ASSET_SOURCE_NAME || source.id !== mediaAssetSourceId(mediaId) || source.url !== gcsPublicUrl(file.path)) {
          check.fail(`${asset._id}: source is ${JSON.stringify(source)}, expected {name: "${ASSET_SOURCE_NAME}", id: "${mediaAssetSourceId(mediaId)}", url: <bucket URL>}`)
        }
      } else if (assetMap.files[file.path] !== asset._id) {
        check.fail(`${file.path}: asset map says ${assetMap.files[file.path]}, dataset has ${asset._id}`)
      } else if (source?.name !== ASSET_SOURCE_NAME) {
        check.fail(`${asset._id}: source.name is not "${ASSET_SOURCE_NAME}"`)
      }
    }
    const migrated = assets.filter((a) => (a.source as {name?: string} | undefined)?.name === ASSET_SOURCE_NAME)
    check.expect(migrated.length === expectedKeys.size, `${migrated.length} assets have source wagtail, the bucket has ${expectedKeys.size} distinct content files`)
    const images = migrated.filter((a) => a._type === 'sanity.imageAsset').length
    const files = migrated.filter((a) => a._type === 'sanity.fileAsset').length
    const videoFiles = inventory.files.filter((f) => f.folder === 'media').length
    check.summary = `${inventory.files.length} bucket files (${videoFiles} videos) -> ${expectedKeys.size} distinct assets; dataset has ${images} image + ${files} file assets from wagtail`
    checks.push(check)

    const hashes = new Check('hashes')
    const explainedMismatch = new Map(
      KNOWN_DISCREPANCIES.filter((k) => k.kind === 'image-hash-mismatch').map((k) => [k.recordId, k]),
    )
    let compared = 0
    let equal = 0
    for (const image of data.images) {
      const assetId = assetMap.images[String(image.id)]
      if (!assetId) {
        const missing = KNOWN_DISCREPANCIES.find((k) => k.kind === 'image-file-missing' && k.recordId === image.id)
        if (missing) hashes.explained.push(`image ${image.id}: ${missing.explanation}`)
        else hashes.fail(`image ${image.id}: no asset`)
        continue
      }
      const asset = byId.get(assetId)
      if (!asset) {
        hashes.fail(`image ${image.id}: asset ${assetId} is not in the dataset`)
        continue
      }
      compared++
      const known = explainedMismatch.get(image.id)
      if (asset.sha1hash === image.file_hash) {
        equal++
        continue
      }
      if (known && known.kind === 'image-hash-mismatch' && asset.sha1hash === known.bucketSha1) {
        hashes.explained.push(`image ${image.id}: sha1 ${String(asset.sha1hash)} instead of recorded ${image.file_hash}. ${known.explanation}`)
      } else {
        hashes.fail(`image ${image.id}: asset sha1 ${String(asset.sha1hash)} != Wagtail file_hash ${image.file_hash}`)
      }
    }
    for (const doc of data.documents) {
      const asset = byId.get(assetMap.documents[String(doc.id)] ?? '')
      compared++
      if (!asset) hashes.fail(`document ${doc.id}: no asset`)
      else if (asset.sha1hash === doc.file_hash) equal++
      else hashes.fail(`document ${doc.id}: asset sha1 ${String(asset.sha1hash)} != Wagtail file_hash ${doc.file_hash}`)
    }
    hashes.summary = `${data.images.length} image + ${data.documents.length} document records: ${equal} equal to file_hash, ${hashes.explained.length} explained (${KNOWN_DISCREPANCIES.filter((k) => k.kind === 'image-hash-mismatch').length} overwritten objects, ${KNOWN_DISCREPANCIES.filter((k) => k.kind === 'image-file-missing').length} missing file), ${hashes.failures.length} failing`
    checks.push(hashes)
  }

  // --- references + keys ----------------------------------------------------------------
  {
    const refs = new Check('references')
    const keys = new Check('keys')
    let refCount = 0
    let arrayCount = 0
    for (const doc of content) {
      walk(doc, doc._id, (value, at) => {
        if (Array.isArray(value)) {
          const objects = value.filter((v) => v && typeof v === 'object')
          if (!objects.length) return
          arrayCount++
          const seen = new Set<string>()
          for (const item of objects as Record<string, unknown>[]) {
            const key = item._key
            if (typeof key !== 'string' || !key) keys.fail(`${at}: item without _key`)
            else if (seen.has(key)) keys.fail(`${at}: duplicate _key ${key}`)
            else seen.add(key)
          }
          return
        }
        if (!value || typeof value !== 'object' || !('_ref' in value)) return
        refCount++
        const ref = value as {_ref: string; _weak?: boolean; _strengthenOnPublish?: unknown}
        const target = byId.get(ref._ref)
        if (target) return
        if (ref._weak && byId.has(`drafts.${ref._ref}`) && ref._strengthenOnPublish) return
        refs.fail(`${at}: ${ref._ref} does not exist`)
      })
    }
    refs.summary = `${refCount} references, ${refs.failures.length} unresolved`
    keys.summary = `${arrayCount} arrays of objects checked`
    checks.push(refs, keys)
  }

  // --- source of every Portable Text field ------------------------------------------------
  interface Source {
    docId: string
    field: string
    html?: string
    stream?: StreamBlock[]
    /** Wagtail page id of a StreamField body (content fixes are keyed by page and block). */
    pageId?: number
  }
  const sources: Source[] = []
  const pageRevisions: {doc: string; page: WagtailPage; revision: PageRevision}[] = []
  for (const page of data.pages) {
    if (!isMigratedPageType(page.type)) continue
    for (const {state, revision} of migratedRevisions(page)) {
      const docId = `${state === 'draft' ? 'drafts.' : ''}${pageDocumentId(page)}`
      pageRevisions.push({doc: docId, page, revision})
      const body = revision.fields.body
      if (typeof body === 'string') sources.push({docId, field: 'bio', html: body})
      else sources.push({docId, field: 'body', stream: body ?? [], pageId: page.id})
    }
  }
  for (const a of data.snippets['home.Author']) sources.push({docId: `person-${a.id}`, field: 'bio', html: a.bio ?? ''})
  for (const t of data.snippets['home.Testimonial']) sources.push({docId: `testimonial-${t.id}`, field: 'body', html: t.body ?? ''})
  for (const s of data.snippets['home.Service']) sources.push({docId: `service-${s.id}`, field: 'description', html: s.description ?? ''})

  // --- portable text integrity -----------------------------------------------------------
  {
    const check = new Check('portableText')
    const styles = new Set(schema.block.styles)
    const lists = new Set(schema.block.lists)
    const decorators = new Set(schema.block.decorators)
    const objects = new Set(schema.blockObjects)
    let blocks = 0
    let spans = 0
    for (const source of sources) {
      const doc = byId.get(source.docId)
      if (!doc) continue // counted by the counts check
      const value = doc[source.field] as PTItem[] | undefined
      if (value === undefined) continue
      if (!Array.isArray(value)) {
        check.fail(`${source.docId}.${source.field} is not an array`)
        continue
      }
      const sourceText = source.html !== undefined
        ? richTextPlainText(source.html)
        : (source.stream ?? []).map((b) => (b.type === 'full_richtext' ? richTextPlainText(String(b.value)) : '')).join('\n')
      for (const item of value) {
        const where = `${source.docId}.${source.field}[_key=="${item._key}"]`
        if (!isTextBlock(item)) {
          check.expect(objects.has(item._type), `${where}: ${item._type} is not a blockContent member`)
          continue
        }
        blocks++
        check.expect(styles.has(item.style), `${where}: style ${item.style}`)
        if (item.listItem !== undefined) {
          check.expect(lists.has(item.listItem) && Number.isInteger(item.level) && (item.level ?? 0) >= 1, `${where}: list ${item.listItem} level ${String(item.level)}`)
        }
        const defKeys = new Set(item.markDefs.map((d) => d._key))
        const usedDefs = new Set<string>()
        for (const span of item.children) {
          spans++
          check.expect(span._type === 'span' && typeof span.text === 'string', `${where}: child ${span._key} is not a text span`)
          for (const mark of span.marks) {
            if (defKeys.has(mark)) usedDefs.add(mark)
            else check.expect(decorators.has(mark), `${where}: mark ${mark} resolves to nothing`)
          }
          for (const pattern of [HTML_TAG, HTML_ENTITY]) {
            const match = pattern.exec(span.text)
            if (!match) continue
            if (sourceText.includes(match[0])) {
              check.explained.push(`${where}: text contains "${match[0]}", which is literal text in the Wagtail source (pre-existing content, not a conversion artifact)`)
            } else {
              check.fail(`${where}: raw markup "${match[0]}" in span text`)
            }
          }
        }
        for (const def of item.markDefs) check.expect(usedDefs.has(def._key), `${where}: markDef ${def._key} is not used`)
      }
    }
    check.summary = `${blocks} text blocks, ${spans} spans checked`
    checks.push(check)
  }

  // --- text parity ----------------------------------------------------------------------
  {
    const check = new Check('textParity')
    let compared = 0
    const compareRichText = (html: string, pt: PTItem[], where: string, streamBlock?: {pageId: number; blockId: string}) => {
      compared++
      const expectedText = richTextPlainText(html)
      const actualText = portableTextPlainText(pt)
      check.expect(sameIgnoringWhitespace(expectedText, actualText), `${where}: plain text differs (Wagtail ${expectedText.replace(/\s+/g, '').length} non-space chars, Portable Text ${actualText.replace(/\s+/g, '').length})`)
      const e = htmlStructure(html)
      const a = ptStructure(pt)
      for (const field of ['textBlocks', 'images', 'youtube', 'dividers'] as const) {
        check.expect(e[field] === a[field], `${where}: ${field} ${e[field]} in Wagtail, ${a[field]} in Sanity`)
      }
      check.expect(stableStringify(e.styles) === stableStringify(a.styles), `${where}: block styles differ`)
      const expectedHrefs = e.hrefs.map((h) => {
        const page = /^page:(\d+)$/.exec(h)
        if (page) {
          const target = data.pages.find((p) => p.id === Number(page[1]))
          return target ? `page:${pageDocumentId(target)}` : h
        }
        const document = /^document:(\d+)$/.exec(h)
        if (document) return `document:${assetMap.documents[document[1]!] ?? h}`
        const fix = streamBlock && linkHrefFix(streamBlock.pageId, streamBlock.blockId, h)
        if (fix) {
          check.explained.push(`${where}: link ${JSON.stringify(fix.from)} is ${JSON.stringify(fix.to)} in Sanity (content fix: ${fix.reason})`)
          return fix.to
        }
        return h
      })
      check.expect(stableStringify(expectedHrefs) === stableStringify(a.hrefs), `${where}: links differ (${expectedHrefs.length} vs ${a.hrefs.length})`)
      check.expect(stableStringify(e.imageIds.map((id) => assetMap.images[String(id)])) === stableStringify(a.imageRefs), `${where}: inline images differ`)
      check.expect(stableStringify(e.youtubeUrls) === stableStringify(a.youtubeUrls), `${where}: YouTube URLs differ`)
    }
    for (const source of sources) {
      const doc = byId.get(source.docId)
      if (!doc) {
        check.fail(`${source.docId}: missing`)
        continue
      }
      const pt = (doc[source.field] as PTItem[] | undefined) ?? []
      if (source.html !== undefined) {
        compareRichText(source.html, pt, `${source.docId}.${source.field}`)
        continue
      }
      // StreamField: walk the blocks in order and take the Portable Text items each produced.
      let cursor = 0
      for (const [index, block] of (source.stream ?? []).entries()) {
        const where = `${source.docId}.${source.field} stream[${index}] ${block.type}`
        if (block.type === 'full_richtext') {
          const prefix = `${block.id.slice(0, 8)}-`
          const items: PTItem[] = []
          while (cursor < pt.length && pt[cursor]!._key.startsWith(prefix)) items.push(pt[cursor++]!)
          compareRichText(String(block.value), items, where, source.pageId === undefined ? undefined : {pageId: source.pageId, blockId: block.id})
          continue
        }
        const item = pt[cursor++] as PTObject | undefined
        if (!item || item._key !== block.id) {
          check.fail(`${where}: expected the item with _key ${block.id} next, found ${item?._key ?? 'nothing'}`)
          break
        }
        compared++
        if (block.type === 'code') {
          const value = block.value as {language: string; text: string}
          check.expect(item._type === 'code' && item.code === value.text && item.language === value.language, `${where}: code differs`)
        } else if (block.type === 'stl_picker') {
          const value = block.value as {file: number; scale: number}
          const file = item.file as {asset?: {_ref?: string}} | undefined
          check.expect(item._type === 'stlModel' && file?.asset?._ref === assetMap.documents[String(value.file)] && item.scale === value.scale, `${where}: STL model differs`)
        } else if (block.type === 'media') {
          const assets = videoMap.videos[String(block.value)]
          const file = item.file as {asset?: {_ref?: string}} | undefined
          const original = item.original as {asset?: {_ref?: string}} | undefined
          check.expect(
            item._type === 'video' && assets !== undefined && file?.asset?._ref === assets.mp4.assetId && original?.asset?._ref === assets.original.assetId,
            `${where}: video differs (media ${String(block.value)})`,
          )
        } else {
          check.fail(`${where}: unknown block type`)
        }
      }
      check.expect(cursor === pt.length, `${source.docId}.${source.field}: ${pt.length - cursor} Portable Text items have no Wagtail source`)
    }
    // Service link text (rich text in Wagtail, a plain string in Sanity).
    for (const s of data.snippets['home.Service']) {
      const doc = byId.get(`service-${s.id}`)
      if (!doc) continue
      compared++
      const expected = s.link_text ? richTextPlainText(s.link_text) : ''
      check.expect(sameIgnoringWhitespace(expected, String(doc.linkText ?? '')), `service-${s.id}.linkText differs from link_text`)
    }
    check.summary = `${compared} rich-text values and StreamField blocks compared`
    checks.push(check)
  }

  // --- field parity ---------------------------------------------------------------------
  {
    const check = new Check('fieldParity')
    const eq = (where: string, actual: unknown, expected: unknown) =>
      check.expect(stableStringify(actual ?? null) === stableStringify(expected ?? null), `${where}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    const blank = (v: string | null | undefined) => (v === null || v === undefined || v.trim() === '' ? undefined : v)
    const imageRef = (id: number | null | undefined) => (id == null ? undefined : assetMap.images[String(id)])
    const refIds = (value: unknown) => ((value as {_ref: string}[] | undefined) ?? []).map((r) => r._ref)
    const tagTitle = (id: string) => String(byId.get(id)?.title ?? `missing ${id}`).toLowerCase()
    const norm = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()
    let fields = 0
    for (const {doc: docId, page, revision} of pageRevisions) {
      const doc = byId.get(docId)
      if (!doc) continue
      const f = revision.fields
      const where = docId
      const legacy = doc.legacy as Record<string, unknown> | undefined
      eq(`${where}.title`, doc.title, f.title)
      eq(`${where}.legacy.wagtailId`, legacy?.wagtailId, page.id)
      eq(`${where}.legacy.wagtailType`, legacy?.wagtailType, page.type)
      eq(`${where}.legacy.wagtailUrlPath`, legacy?.wagtailUrlPath, page.url_path)
      eq(`${where}.legacy.firstPublishedAt`, legacy?.firstPublishedAt, page.first_published_at ? new Date(page.first_published_at).toISOString() : undefined)
      eq(`${where}.legacy.lastPublishedAt`, legacy?.lastPublishedAt, page.last_published_at ? new Date(page.last_published_at).toISOString() : undefined)
      const seo = doc.seo as {title?: string; description?: string} | undefined
      eq(`${where}.seo.title`, seo?.title, blank(f.seo_title))
      eq(`${where}.seo.description`, seo?.description, blank(f.search_description))
      fields += 8
      if (page.type === 'home.HomePage') {
        const authors = [...(revision.children.blog_authors ?? [])].sort((a, b) => a.sort_order - b.sort_order)
        eq(`${where}.author`, (doc.author as {_ref?: string} | undefined)?._ref, authors[0] ? `person-${String(authors[0].author_id)}` : undefined)
        eq(`${where}.testimonials`, refIds(doc.testimonials), [...(revision.children.testimonials ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((o) => `testimonial-${String(o.testimonial_id)}`))
        eq(`${where}.services`, refIds(doc.services), [...(revision.children.home_service ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((o) => `service-${String(o.service_id)}`))
        fields += 3
        continue
      }
      eq(`${where}.slug`, (doc.slug as {current?: string} | undefined)?.current, f.slug)
      fields++
      if (page.type === 'flex.FlexPage') continue
      eq(`${where}.date`, doc.date, f.date)
      eq(`${where}.intro`, doc.intro, f.intro)
      eq(`${where}.isUnlisted`, doc.isUnlisted, f.is_unlisted)
      eq(`${where}.audience`, doc.audience, f.project_audience)
      const authors = [...(revision.children.blog_authors ?? [])].sort((a, b) => a.sort_order - b.sort_order)
      eq(`${where}.author`, (doc.author as {_ref?: string} | undefined)?._ref, authors[0] ? `person-${String(authors[0].author_id)}` : undefined)
      eq(`${where}.contentImage`, (doc.contentImage as {asset?: {_ref?: string}} | undefined)?.asset?._ref, imageRef(f.content_image_id))
      const hero = ((doc.heroMedia as Record<string, unknown>[] | undefined) ?? []).map((h) => (h._type === 'youtube' ? `youtube:${String(h.url)}` : `image:${String((h.asset as {_ref: string})._ref)}`))
      const heroExpected = (f.content_visuals ?? []).map((b) => (b.type === 'youtube_video' ? `youtube:${String(b.value)}` : `image:${imageRef(b.value as number)}`))
      eq(`${where}.heroMedia`, hero, heroExpected)
      fields += 8
      if (page.type === 'blog.BlogPage') continue
      eq(`${where}.projectType`, doc.projectType, f.project_type)
      eq(`${where}.client`, doc.client, blank(f.client ?? undefined))
      eq(`${where}.website`, doc.website, blank(f.website ?? undefined))
      eq(`${where}.previewImage`, (doc.previewImage as {asset?: {_ref?: string}} | undefined)?.asset?._ref, imageRef(f.preview_image_id))
      eq(`${where}.testimonials`, refIds(doc.testimonials), [...(revision.children.testimonials ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((o) => `testimonial-${String(o.testimonial_id)}`))
      eq(`${where}.mediums`, refIds(doc.mediums).map(tagTitle), [...new Set(wagtailTagOrder(revision.tags.medium ?? []).map(norm))])
      eq(`${where}.technologies`, refIds(doc.technologies).map(tagTitle), [...new Set(wagtailTagOrder(revision.tags.technologies ?? []).map(norm))])
      fields += 7
      // Independent of the ordering rule: a live project shows its tags exactly as the old site's
      // API returned them (live-api-snapshot/page-<id>.json).
      if (!docId.startsWith('drafts.')) {
        const live = liveApiPage(paths, page.id)
        if (!live) {
          check.fail(`${where}: no live API snapshot of page ${page.id}`)
        } else {
          const exactTitle = (id: string) => String(byId.get(id)?.title ?? `missing ${id}`)
          eq(`${where}.mediums (live API order)`, refIds(doc.mediums).map(exactTitle), live.medium ?? [])
          eq(`${where}.technologies (live API order)`, refIds(doc.technologies).map(exactTitle), live.technologies ?? [])
          fields += 2
        }
      }
    }
    for (const a of data.snippets['home.Author']) {
      const doc = byId.get(`person-${a.id}`)
      if (!doc) continue
      const where = doc._id
      eq(`${where}.firstName`, doc.firstName, a.first_name)
      eq(`${where}.lastName`, doc.lastName, a.last_name)
      eq(`${where}.location`, doc.location, blank(a.location))
      eq(`${where}.jobTitle`, doc.jobTitle, blank(a.job_title))
      eq(`${where}.email`, doc.email, blank(a.email))
      eq(`${where}.github`, doc.github, blank(a.github))
      eq(`${where}.image`, (doc.image as {asset?: {_ref?: string}} | undefined)?.asset?._ref, imageRef(a.image_id))
      eq(`${where}.legacy.wagtailId`, (doc.legacy as {wagtailId?: number}).wagtailId, a.id)
      fields += 8
    }
    for (const t of data.snippets['home.Testimonial']) {
      const doc = byId.get(`testimonial-${t.id}`)
      if (!doc) continue
      const where = doc._id
      eq(`${where}.firstName`, doc.firstName, t.first_name)
      eq(`${where}.lastName`, doc.lastName, t.last_name)
      eq(`${where}.jobTitle`, doc.jobTitle, blank(t.job_title))
      eq(`${where}.relationship`, doc.relationship, blank(t.relationship))
      eq(`${where}.link`, doc.link, blank(t.link))
      eq(`${where}.image`, (doc.image as {asset?: {_ref?: string}} | undefined)?.asset?._ref, imageRef(t.image_id))
      eq(`${where}.legacy.wagtailId`, (doc.legacy as {wagtailId?: number}).wagtailId, t.id)
      fields += 7
    }
    for (const s of data.snippets['home.Service']) {
      const doc = byId.get(`service-${s.id}`)
      if (!doc) continue
      const where = doc._id
      eq(`${where}.title`, doc.title, s.title)
      eq(`${where}.audience`, doc.audience, s.audience)
      eq(`${where}.link`, doc.link, blank(s.link))
      eq(`${where}.image`, (doc.image as {asset?: {_ref?: string}} | undefined)?.asset?._ref, imageRef(s.image_id))
      eq(`${where}.legacy.wagtailId`, (doc.legacy as {wagtailId?: number}).wagtailId, s.id)
      fields += 5
    }
    for (const r of data.redirects) {
      const target = data.pages.find((p) => p.id === r.redirect_page_id)
      // Only a redirect to a live page (or to a link) may be served by the site.
      const expectedId = `${target && !target.live ? 'drafts.' : ''}redirect-${r.id}`
      const unexpectedId = expectedId.startsWith('drafts.') ? `redirect-${r.id}` : `drafts.redirect-${r.id}`
      check.expect(!byId.has(unexpectedId), `${unexpectedId}: should not exist (expected only ${expectedId})`)
      const doc = byId.get(expectedId)
      if (!doc) {
        check.fail(`${expectedId}: missing`)
        continue
      }
      eq(`${doc._id}.source`, doc.source, r.old_path)
      eq(`${doc._id}.permanent`, doc.permanent, r.is_permanent)
      if (target) {
        const rev = target.live ? target.published : target.latest
        const prefix = target.type === 'blog.BlogPage' ? '/blog/' : target.type === 'blog.ProjectPage' ? '/projects/' : target.type === 'flex.FlexPage' ? '/flex/' : '/'
        eq(`${doc._id}.destination`, doc.destination, target.type === 'home.HomePage' ? '/' : `${prefix}${rev?.fields.slug}`)
      } else {
        eq(`${doc._id}.destination`, doc.destination, r.redirect_link)
      }
      fields += 3
    }
    check.summary = `${fields} fields compared`
    checks.push(check)
  }

  // --- videos ---------------------------------------------------------------------------
  {
    const check = new Check('videos')

    // No Mux left: no mux.* document (mux.videoAsset, mux.apiKey), no secrets.mux token document
    // and no object of a mux.* type anywhere (the old block shape {asset: {_type: "mux.video"}}).
    const muxDocuments = all.filter((d) => d._type.startsWith('mux.') || d._id === 'secrets.mux').map((d) => d._id)
    check.expect(muxDocuments.length === 0, `Mux documents remain: ${muxDocuments.join(', ')}`)
    for (const doc of content) {
      walk(doc, doc._id, (value, at) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const type = (value as {_type?: unknown})._type
          if (typeof type === 'string' && type.startsWith('mux.')) check.fail(`${at}: object of the Mux type ${type}`)
        }
      })
    }

    // The media blocks of the migrated revisions, in order, and the video blocks in the dataset.
    const expectedBlocks = new Map<string, number>()
    for (const source of sources) {
      for (const block of source.stream ?? []) {
        if (block.type === 'media') expectedBlocks.set(`${source.docId}.${source.field}[_key=="${block.id}"]`, block.value as number)
      }
    }
    const actualBlocks: {where: string; block: PTObject}[] = []
    for (const doc of content) {
      for (const field of schema.portableTextFields[doc._type] ?? []) {
        for (const item of (doc[field] as PTItem[] | undefined) ?? []) {
          if (item._type === 'video') actualBlocks.push({where: `${doc._id}.${field}[_key=="${item._key}"]`, block: item as PTObject})
        }
      }
    }
    check.expect(
      actualBlocks.length === expectedBlocks.size,
      `${actualBlocks.length} video blocks in ${dataset}, the Wagtail revisions have ${expectedBlocks.size} media blocks`,
    )

    const fileAsset = (id: string | undefined) => {
      const asset = id ? byId.get(id) : undefined
      return asset?._type === 'sanity.fileAsset' ? asset : undefined
    }
    let ready = 0
    for (const {where, block} of actualBlocks) {
      const before = check.failures.length
      const mediaId = expectedBlocks.get(where)
      if (mediaId === undefined) {
        check.fail(`${where}: video block without a Wagtail media block`)
        continue
      }
      const expected = videoMap.videos[String(mediaId)]
      const converted = mp4Map.videos[String(mediaId)]
      if (!expected || !converted) {
        check.fail(`${where}: media ${mediaId} is not in the video map or the MP4 map`)
        continue
      }
      const extraKeys = Object.keys(block).filter((k) => !['_type', '_key', 'file', 'original', 'conversion'].includes(k))
      check.expect(extraKeys.length === 0, `${where}: unexpected fields ${extraKeys.join(', ')}`)
      const fileRef = (block.file as {asset?: {_ref?: string}} | undefined)?.asset?._ref
      const originalRef = (block.original as {asset?: {_ref?: string}} | undefined)?.asset?._ref
      const conversion = (block.conversion ?? {}) as Record<string, unknown>
      const mp4 = fileAsset(fileRef)
      const original = fileAsset(originalRef)
      if (!mp4) check.fail(`${where}: file -> ${fileRef ?? '(none)'} is not a file asset in ${dataset}`)
      if (!original) check.fail(`${where}: original -> ${originalRef ?? '(none)'} is not a file asset in ${dataset}`)
      if (mp4 && original) {
        const mp4Source = mp4.source as {name?: string; id?: string} | undefined
        const originalSource = original.source as {name?: string; id?: string} | undefined
        check.expect(mp4.mimeType === OUTPUT_MIME_TYPE, `${where}: ${mp4._id} has mimeType ${String(mp4.mimeType)}, expected ${OUTPUT_MIME_TYPE}`)
        check.expect(mp4.extension === 'mp4', `${where}: ${mp4._id} has extension ${String(mp4.extension)}`)
        check.expect(
          mp4Source?.name === CONVERTED_ASSET_SOURCE_NAME && mp4Source.id === original._id,
          `${where}: ${mp4._id} has source ${JSON.stringify(mp4Source)}, expected {name: "${CONVERTED_ASSET_SOURCE_NAME}", id: "${original._id}"}`,
        )
        check.expect(originalSource?.name === ASSET_SOURCE_NAME && originalSource.id === mediaAssetSourceId(mediaId), `${where}: original ${original._id} is not the Wagtail upload of media ${mediaId}`)
        check.expect(original.sha1hash === converted.source.sha1, `${where}: original ${original._id} has sha1 ${String(original.sha1hash)}, the bucket file ${converted.source.sha1}`)
        check.expect(
          original.mimeType === originalMimeType(converted.source.filename),
          `${where}: original ${original._id} has mimeType ${String(original.mimeType)}, expected ${originalMimeType(converted.source.filename)}`,
        )
        check.expect(mp4._id === expected.mp4.assetId && original._id === expected.original.assetId, `${where}: assets differ from ${videoAssetMapPath(paths, dataset)}`)
        // The MP4 is the convert step's checked output, or an existing conversion the videos step
        // downloaded and checked the same way.
        const expectedSha1 = expected.mp4.origin === 'convert' ? converted.output.sha1 : expected.mp4.sha1
        check.expect(mp4.sha1hash === expectedSha1, `${where}: ${mp4._id} has sha1 ${String(mp4.sha1hash)}, the checked MP4 ${expectedSha1}`)
        const conversionsOfOriginal = assets.filter((a) => {
          const src = a.source as {name?: string; id?: string} | undefined
          return src?.name === CONVERTED_ASSET_SOURCE_NAME && src.id === original._id
        })
        check.expect(conversionsOfOriginal.length === 1, `${where}: ${conversionsOfOriginal.length} video-to-mp4 assets for ${original._id}, expected 1`)
      }
      check.expect(conversion.status === 'ready', `${where}: conversion.status is ${JSON.stringify(conversion.status)}, expected "ready"`)
      check.expect(conversion.sourceAssetId === originalRef, `${where}: conversion.sourceAssetId ${String(conversion.sourceAssetId)} is not the original ${String(originalRef)}`)
      check.expect(conversion.outputAssetId === fileRef, `${where}: conversion.outputAssetId ${String(conversion.outputAssetId)} is not the file ${String(fileRef)}`)
      check.expect(conversion.settingsVersion === SETTINGS_VERSION, `${where}: conversion.settingsVersion ${String(conversion.settingsVersion)}, current ${SETTINGS_VERSION}`)
      check.expect(
        typeof conversion.updatedAt === 'string' && !Number.isNaN(Date.parse(conversion.updatedAt)),
        `${where}: conversion.updatedAt ${JSON.stringify(conversion.updatedAt)} is not a datetime`,
      )
      check.expect(!videoNeedsConversion(block as Parameters<typeof videoNeedsConversion>[0]), `${where}: needs conversion by the contract rule (the video-to-mp4 Function would convert it)`)
      if (check.failures.length === before) ready++
    }
    // MP4s that passed the convert step only through src/conversion-deviations.ts.
    for (const converted of Object.values(mp4Map.videos).sort((a, b) => a.mediaId - b.mediaId)) {
      if (converted.deviation) {
        check.explained.push(`media ${converted.mediaId} (${converted.source.filename}): ${converted.deviation.problems.join('; ')}. ${converted.deviation.explanation}`)
      }
    }

    // Exactly one MP4 per Wagtail video: no stray conversions of the migrated originals. (MP4s the
    // video-to-mp4 Function makes from Studio uploads are not the migration's.)
    const originalIds = new Set(Object.values(videoMap.videos).map((v) => v.original.assetId))
    const mp4Assets = assets.filter((a) => {
      const src = a.source as {name?: string; id?: string} | undefined
      return src?.name === CONVERTED_ASSET_SOURCE_NAME && originalIds.has(String(src.id))
    })
    check.expect(
      mp4Assets.length === data.media.length && originalIds.size === data.media.length,
      `${mp4Assets.length} assets with source ${CONVERTED_ASSET_SOURCE_NAME} made from the ${originalIds.size} migrated originals, expected ${data.media.length}`,
    )

    // Every MP4 is served by the CDN with the right type and size.
    let served = 0
    for (const asset of mp4Assets) {
      const url = String(asset.url)
      const response = await fetch(url, {method: 'HEAD', signal: AbortSignal.timeout(60_000)})
      const type = response.headers.get('content-type')
      const length = Number(response.headers.get('content-length'))
      if (response.status === 200 && type === OUTPUT_MIME_TYPE && length === asset.size) served++
      else check.fail(`${asset._id}: HEAD ${url} answered ${response.status}, ${type}, ${length} bytes (asset size ${String(asset.size)})`)
    }
    check.summary = `${ready}/${expectedBlocks.size} video blocks are ready MP4s (settings ${SETTINGS_VERSION}); ${served}/${mp4Assets.length} MP4s served by the CDN; ${muxDocuments.length} Mux documents`
    checks.push(check)
  }

  // --- ascii art ------------------------------------------------------------------------
  {
    const check = new Check('asciiArt')
    const live = liveAsciiArt(paths)
    let identical = 0
    for (const t of data.snippets['home.Testimonial']) {
      const doc = byId.get(`testimonial-${t.id}`)
      if (!doc) continue
      const imageRefValue = (doc.image as {asset?: {_ref?: string}} | undefined)?.asset?._ref
      check.expect(doc.asciiArtSource === imageRefValue, `${doc._id}: asciiArtSource ${String(doc.asciiArtSource)} != image ${String(imageRefValue)}`)
      const html = live.get(t.id)
      if (html === undefined) continue
      if (doc.asciiArt === html) identical++
      else check.fail(`${doc._id}: asciiArt differs from the live site`)
    }
    check.summary = `${identical}/${live.size} live testimonials byte-identical; asciiArtSource matches the image on all`
    checks.push(check)
  }

  // --- convergence ----------------------------------------------------------------------
  {
    const check = new Check('convergence')
    const wanted = new Map(transformed.map((d) => [d._id, d]))
    for (const [id, doc] of wanted) {
      const actual = byId.get(id)
      if (!actual) check.fail(`${id}: missing from the dataset`)
      else check.expect(stableStringify(stripSystem(actual)) === stableStringify(doc), `${id}: differs from the transformed document`)
    }
    const migratedTypes = new Set(transformed.map((d) => d._type))
    for (const doc of content) {
      if (migratedTypes.has(doc._type) && !wanted.has(doc._id)) check.fail(`${doc._id}: in the dataset but not produced by the transform`)
    }
    check.summary = `${transformed.length} transformed documents compared with the dataset`
    checks.push(check)
  }

  // --- studio validation ----------------------------------------------------------------
  {
    const check = new Check('studioValidation')
    const out = await sanityCli(['documents', 'validate', '--workspace', dataset, '--level', 'error', '--yes', '--format', 'json'], `validate-dataset-${dataset}.log`, paths)
    const markers = JSON.parse(out.trim() || '[]') as {documentId: string; markers: {level: string; message: string; path: unknown[]}[]}[]
    for (const doc of markers) {
      for (const m of doc.markers) if (m.level === 'error') check.fail(`${doc.documentId} ${JSON.stringify(m.path)}: ${m.message}`)
    }
    check.summary = `sanity documents validate --workspace ${dataset} --level error: ${check.failures.length} errors`
    checks.push(check)
  }

  const results = checks.map((c) => c.result())
  const failed = results.filter((r) => r.status === 'fail')
  const report = {dataset, validatedAt: new Date().toISOString(), status: failed.length ? 'fail' : 'pass', checks: results}
  writeJson(path.join(paths.reports, `validation-${dataset}.json`), report)
  const md = [
    `# Validation of ${dataset}`,
    '',
    `Result: **${report.status.toUpperCase()}** (${results.length - failed.length}/${results.length} checks pass), ${report.validatedAt}`,
    '',
    '| Check | Result | Summary |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.status} | ${r.summary.replace(/\|/g, '\\|')} |`),
    '',
    ...results.flatMap((r) =>
      r.failures.length || r.explained.length
        ? [`## ${r.name}`, '', ...r.failures.map((f) => `- FAIL: ${f}`), ...r.explained.map((e) => `- explained: ${e}`), '']
        : [],
    ),
  ].join('\n')
  writeText(path.join(paths.reports, `validation-${dataset}.md`), md + '\n')
  for (const r of results) log(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}: ${r.summary}${r.failures.length ? ` (${r.failures.length} failures)` : ''}`)
  if (failed.length) {
    throw new Error(
      `validation of ${dataset} failed: ${failed.map((r) => `${r.name} (${r.failures.length})`).join(', ')}. ` +
        `See ${path.join(paths.reports, `validation-${dataset}.md`)}`,
    )
  }
  log(`validate: all ${results.length} checks pass`)
  return results
}
