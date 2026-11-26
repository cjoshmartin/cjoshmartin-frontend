/**
 * Pure helpers of the dataset comparison (src/compare.ts), kept apart so they can be unit-tested
 * without running the command.
 */
import {createHash} from 'node:crypto'

import {PROJECT_ID} from './config'
import {stableStringify} from './util'

export type Doc = {_id: string; _type: string; [field: string]: unknown}

export const SYSTEM_FIELDS = new Set(['_rev', '_createdAt', '_updatedAt', '_system'])
export const ASSET_TYPES = new Set(['sanity.imageAsset', 'sanity.fileAsset'])
/**
 * Documents under `secrets.` hold tokens (plugins keep API keys there). The comparison never reads
 * them, only lists their ids.
 */
export const SECRETS_PATH = 'secrets.**'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A document without system fields; for assets also without the per-upload and per-dataset fields. */
export function comparable(doc: Doc, dataset: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (SYSTEM_FIELDS.has(key)) continue
    if (ASSET_TYPES.has(doc._type)) {
      if (key === 'uploadId') continue
      if ((key === 'path' || key === 'url') && typeof value === 'string') {
        out[key] = value.replace(`/${PROJECT_ID}/${dataset}/`, `/${PROJECT_ID}/<dataset>/`)
        continue
      }
    }
    out[key] = value
  }
  return out
}

/** sha256 of every blockContent field, keyed `<_id>.<field>`, sorted by key. */
export function portableTextHashes(docs: Doc[], fields: Record<string, string[]>): Map<string, string> {
  const hashes: [string, string][] = []
  for (const doc of docs) {
    for (const field of fields[doc._type] ?? []) {
      if (doc[field] === undefined) continue
      hashes.push([`${doc._id}.${field}`, sha256(stableStringify(doc[field]))])
    }
  }
  return new Map(hashes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function digest(hashes: Map<string, string>): string {
  return sha256([...hashes].map(([key, hash]) => `${key}=${hash}\n`).join(''))
}

export function countByType(docs: Doc[]): Record<string, {published: number; drafts: number; versions: number}> {
  const counts: Record<string, {published: number; drafts: number; versions: number}> = {}
  for (const doc of docs) {
    const entry = (counts[doc._type] ??= {published: 0, drafts: 0, versions: 0})
    if (doc._id.startsWith('drafts.')) entry.drafts++
    else if (doc._id.startsWith('versions.')) entry.versions++
    else entry.published++
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * For two versions of the same asset whose `metadata` differs only because one upload asked Sanity
 * to extract more (e.g. thumbHash), returns the keys each side has on its own. Returns null when
 * any metadata key present on both sides has different values, i.e. a real difference.
 */
export function extraMetadataKeys(a: unknown, b: unknown): {onlyInA: string[]; onlyInB: string[]} | null {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const key of Object.keys(x)) {
    if (key in y && stableStringify(x[key]) !== stableStringify(y[key])) return null
  }
  const onlyInA = Object.keys(x).filter((k) => !(k in y)).sort()
  const onlyInB = Object.keys(y).filter((k) => !(k in x)).sort()
  return onlyInA.length || onlyInB.length ? {onlyInA, onlyInB} : null
}

export function differingFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => stableStringify(a[key]) !== stableStringify(b[key]))
    .sort()
}
