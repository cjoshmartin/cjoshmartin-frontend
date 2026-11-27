/**
 * Pure helpers of the dataset recreate tool (src/recreate.ts): snapshot summaries, the export's
 * asset file names and pointers, and field comparisons. No I/O, so they are unit-tested
 * (test/recreate.test.ts).
 */
import {stableStringify} from './util'

/** An image or file asset id: its sha1 is the content-addressed CDN path. */
export const ASSET_ID = /\b(?:image-[0-9a-f]{40}-\d+x\d+-[a-z0-9]+|file-[0-9a-f]{40}-[a-z0-9]+)\b/gi

export function isAssetId(id: string): boolean {
  return /^(?:image-[0-9a-f]{40}-\d+x\d+-[a-z0-9]+|file-[0-9a-f]{40}-[a-z0-9]+)$/i.test(id)
}

/** Asset document fields that identify the stored blob; restore-assets never patches them. */
export const ASSET_IDENTITY_FIELDS = ['_id', '_type', 'assetId', 'sha1hash', 'size', 'path', 'url', 'extension'] as const

/** Fields the Content Lake sets itself on every write. */
export const VOLATILE_FIELDS = ['_rev', '_updatedAt'] as const

/** The asset service's id of the stored blob: a new upload gets a new one (@sanity/import). */
export const ASSET_UPLOAD_FIELDS = ['uploadId'] as const

/**
 * Fields an imported asset document cannot get back. The asset service creates the document at
 * the upload, so `_createdAt` is the import time, and a patch that sets `_createdAt` is accepted
 * but leaves it unchanged (checked on staging in the WP8 review, note 9). Reported, not patched.
 */
export const ASSET_UNRESTORABLE_FIELDS = ['_createdAt'] as const

/** Fields the export leaves out of assets.json (@sanity/export EXCLUDE_PROPS). */
export const EXPORT_ASSET_EXCLUDED = ['_id', '_type', 'assetId', 'extension', 'mimeType', 'path', 'uploadId', 'url'] as const

export type SanityDoc = {_id: string; _type: string; [field: string]: unknown}

export interface Snapshot {
  dataset: string
  takenAt: string
  apiVersion: string
  documents: SanityDoc[]
  summary: SnapshotSummary
}

export interface SnapshotSummary {
  documents: number
  byType: Record<string, {published: number; drafts: number; versions: number}>
  systemDocuments: string[]
  images: number
  files: number
  assetSha1s: string[]
}

export function isAssetDoc(doc: {_type: string}): boolean {
  return doc._type === 'sanity.imageAsset' || doc._type === 'sanity.fileAsset'
}

export function isSystemDoc(doc: {_id: string}): boolean {
  return doc._id.startsWith('_.')
}

export function documentKind(id: string): 'published' | 'drafts' | 'versions' {
  if (id.startsWith('drafts.')) return 'drafts'
  if (id.startsWith('versions.')) return 'versions'
  return 'published'
}

export function summarize(documents: readonly SanityDoc[]): SnapshotSummary {
  const byType: SnapshotSummary['byType'] = {}
  for (const doc of documents) {
    if (isSystemDoc(doc)) continue
    const counts = (byType[doc._type] ??= {published: 0, drafts: 0, versions: 0})
    counts[documentKind(doc._id)]++
  }
  const assets = documents.filter(isAssetDoc)
  return {
    documents: documents.length,
    byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => (a < b ? -1 : 1))),
    systemDocuments: documents.filter(isSystemDoc).map((d) => d._id).sort(),
    images: assets.filter((a) => a._type === 'sanity.imageAsset').length,
    files: assets.filter((a) => a._type === 'sanity.fileAsset').length,
    assetSha1s: assets.map((a) => String(a.sha1hash)).sort(),
  }
}

/** `doc` without the given top-level fields. */
export function without(doc: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !fields.includes(key)))
}

/** Top-level fields whose values differ (stable JSON), sorted. */
export function differingFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((key) => stableStringify(a[key]) !== stableStringify(b[key])).sort()
}

/**
 * The export's file name of an asset: @sanity/export's generateFilename, exactly. Its extension
 * group only takes letters, so `file-<sha1>-mp4` is written as `<sha1>-mp4.bin`.
 */
export function exportFileName(assetId: string): {folder: 'images' | 'files'; name: string} {
  const match = /^(image|file)-(.*?)(-[a-z]+)?$/.exec(assetId)
  if (!match || !isAssetId(assetId)) throw new Error(`not an asset id: ${prefix(assetId)}`)
  const stem = match[2]
  const extension = (match[3] ?? 'bin').replace(/^-/, '')
  return {folder: match[1] === 'image' ? 'images' : 'files', name: stem ? `${stem}.${extension}` : `${assetId}.bin`}
}

/** The `_sanityAsset` pointer the export writes for an asset reference. */
export function exportPointer(assetId: string): string {
  const {folder, name} = exportFileName(assetId)
  return `${folder === 'images' ? 'image' : 'file'}@file://./${folder}/${name}`
}

/**
 * An exported document with its asset references written back: the export replaces every
 * `{asset: {_ref}, ...rest}` object by `{_sanityAsset: "<type>@file://./<folder>/<name>", ...rest}`.
 * `pointers` maps each pointer to its asset id (exportPointer of every asset in the snapshot); a
 * pointer that is not in it names an asset the snapshot does not have, which is an error.
 */
export function unrewriteAssets(value: unknown, pointers: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((member) => unrewriteAssets(member, pointers))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === '_sanityAsset') continue
    out[key] = unrewriteAssets(child, pointers)
  }
  if (typeof record._sanityAsset === 'string') {
    const id = pointers.get(record._sanityAsset)
    if (!id) throw new Error(`the export points at an asset that is not in the snapshot (${record._sanityAsset.slice(0, 30)}...)`)
    out.asset = {_ref: id, _type: 'reference'}
  }
  return out
}

/** First 8 hex characters of an asset id's sha1, or the first 12 characters of another id. */
export function prefix(id: string): string {
  const sha = /^(?:image|file)-([0-9a-f]{40})/i.exec(id)
  return sha ? `${id.split('-')[0]}-${sha[1]!.slice(0, 8)}` : id.slice(0, 12)
}

/** Every asset id named anywhere in a local file (inventories in any format). */
export function assetIdsInText(text: string): Set<string> {
  return new Set([...text.matchAll(ASSET_ID)].map((m) => m[0].toLowerCase()))
}

/**
 * Checks history-check's `--created-after` time against the History API baseline taken before the
 * delete, and returns it. It must be the time scripts/recreate-dataset.sh printed before
 * `datasets create`: the create itself writes the new dataset's `_.groups.*` and
 * `_.retention.*` documents, so the import start (after the create) makes those look like
 * history from before the recreate (recreate fix round 1, finding 3). A time that is not after
 * every transaction the baseline recorded would let old history pass, so it is refused.
 */
export function checkCreatedAfter(createdAfter: string, baseline: {current: {transactions: {timestamp: string}[]}[]; deleted: {transactions: {timestamp: string}[]}[]}): string {
  const at = Date.parse(createdAfter)
  if (Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAfter)) {
    throw new Error(`--created-after must be an ISO time in UTC (YYYY-MM-DDTHH:MM:SSZ), got ${JSON.stringify(createdAfter)}`)
  }
  let latest: string | null = null
  for (const doc of [...baseline.current, ...baseline.deleted]) {
    for (const tx of doc.transactions) if (latest === null || Date.parse(tx.timestamp) > Date.parse(latest)) latest = tx.timestamp
  }
  if (latest !== null && at <= Date.parse(latest)) {
    throw new Error(`--created-after ${createdAfter} is not after the old dataset's last transaction in the baseline (${latest}); pass the time scripts/recreate-dataset.sh printed before \`datasets create\``)
  }
  return createdAfter
}
