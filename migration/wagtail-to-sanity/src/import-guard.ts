/**
 * Protects documents that changed in the dataset since this migration last wrote them.
 *
 * The import replaces every migration document (`--replace`) and prunes migration ids the
 * transform no longer produces. Once editors use the Studio, that would silently undo their
 * edits, delete documents they published from a migrated draft, and delete drafts they are
 * working on. So every import (and the `baseline` step) records the `_rev` and a content hash of
 * each migration document it leaves in the dataset, in state/imported-<dataset>.json. The next
 * import compares the dataset with that record first and refuses when anything differs, unless
 * the run is told to discard those changes.
 *
 * A document counts as unchanged when its `_rev` is the recorded one, or when its content
 * (everything but the system fields) still hashes to the recorded value, so a no-op save or a
 * Function rewrite that produces the same content does not block a run.
 */
import {createHash} from 'node:crypto'

import {stableStringify} from './util'

/** _id patterns this migration owns (published and drafts). */
export const MIGRATION_ID_PATTERN =
  /^(?:drafts\.)?(?:homePage|person-\d+|testimonial-\d+|service-\d+|blogPost-\d+|project-\d+|flexPage-\d+|medium-[a-z0-9]+(?:-[a-z0-9]+)*|technology-[a-z0-9]+(?:-[a-z0-9]+)*|redirect-\d+|mux-video-\d+)$/

/** Fields the Content Lake sets itself; they are not part of a document's content. */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(['_rev', '_createdAt', '_updatedAt', '_system'])

export interface StoredDocument {
  _id: string
  _type: string
  _rev?: string
  [field: string]: unknown
}

export interface RecordedDocument {
  rev: string
  contentHash: string
}

export interface ImportRecord {
  dataset: string
  recordedAt: string
  /** `import` after a successful import, `baseline` when recorded from an untouched dataset. */
  source: 'import' | 'baseline'
  /** sha256 of the NDJSON the documents came from (the last import's or the baseline's). */
  ndjsonSha256: string
  documents: Record<string, RecordedDocument>
  /** Documents added later without a full import (the `videos` step), newest last. */
  additions?: {recordedAt: string; step: 'videos'; ids: string[]}[]
}

export interface StudioEdits {
  /** Migration documents whose content changed since the record. */
  changed: string[]
  /** Migration ids present in the dataset that the record does not know (for example a draft
   * an editor opened, or a page published from a migrated draft). */
  created: string[]
  /** Recorded documents that are gone (deleted, or a draft that was published or discarded). */
  deleted: string[]
  /** Release versions (`versions.<release>.<id>`) of migration documents. */
  inReleases: string[]
}

export function stripSystemFields<T extends {_id: string}>(doc: T): T {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !SYSTEM_FIELDS.has(key))) as T
}

/** sha256 of a document's content: stable JSON without the system fields. */
export function contentHash(doc: StoredDocument): string {
  return createHash('sha256').update(stableStringify(stripSystemFields(doc))).digest('hex')
}

/** The migration id a release version belongs to, or null (`versions.<release>.<id>`). */
export function releaseVersionTarget(id: string): string | null {
  const match = /^versions\.[^.]+\.(.+)$/.exec(id)
  return match && MIGRATION_ID_PATTERN.test(match[1]!) ? match[1]! : null
}

/**
 * Compares the migration documents in the dataset with the record of the last import.
 * `current` may contain any documents; only migration ids are considered. `versionIds` are the
 * ids under `versions.**`.
 */
export function findStudioEdits(
  record: ImportRecord,
  current: readonly StoredDocument[],
  versionIds: readonly string[],
): StudioEdits {
  const edits: StudioEdits = {changed: [], created: [], deleted: [], inReleases: []}
  const seen = new Set<string>()
  for (const doc of current) {
    if (!MIGRATION_ID_PATTERN.test(doc._id)) continue
    seen.add(doc._id)
    const recorded = record.documents[doc._id]
    if (!recorded) edits.created.push(doc._id)
    else if (doc._rev !== recorded.rev && contentHash(doc) !== recorded.contentHash) edits.changed.push(doc._id)
  }
  for (const id of Object.keys(record.documents)) {
    if (!seen.has(id)) edits.deleted.push(id)
  }
  for (const id of versionIds) {
    if (releaseVersionTarget(id)) edits.inReleases.push(id)
  }
  for (const list of Object.values(edits)) list.sort()
  return edits
}

export function hasStudioEdits(edits: StudioEdits): boolean {
  return Object.values(edits).some((list) => list.length > 0)
}

export function describeStudioEdits(edits: StudioEdits): string {
  const lines: string[] = []
  if (edits.changed.length) lines.push(`changed since the last import: ${edits.changed.join(', ')}`)
  if (edits.created.length) lines.push(`created since the last import (drafts or published copies): ${edits.created.join(', ')}`)
  if (edits.deleted.length) lines.push(`deleted, published or discarded since the last import: ${edits.deleted.join(', ')}`)
  if (edits.inReleases.length) lines.push(`in a release: ${edits.inReleases.join(', ')}`)
  return lines.map((line) => `- ${line}`).join('\n')
}

/**
 * Adds documents a later step created to the record. Only these documents are (re)recorded, so
 * changes to any other document stay visible to the next import's check.
 */
export function addToImportRecord(
  record: ImportRecord,
  step: 'videos',
  created: readonly {doc: StoredDocument; expected: StoredDocument}[],
  recordedAt: string = new Date().toISOString(),
): ImportRecord {
  if (!created.length) return record
  const documents = {...record.documents}
  for (const {doc, expected} of created) {
    if (typeof doc._rev !== 'string' || !doc._rev) throw new Error(`${doc._id} has no _rev`)
    const hash = contentHash(expected)
    if (contentHash(doc) !== hash) throw new Error(`${doc._id} differs from the document that was created`)
    documents[doc._id] = {rev: doc._rev, contentHash: hash}
  }
  return {
    ...record,
    documents: Object.fromEntries(Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    additions: [...(record.additions ?? []), {recordedAt, step, ids: created.map(({doc}) => doc._id).sort()}],
  }
}

/**
 * Builds the record of what an import (or a baseline) left in the dataset. Every expected
 * document must be in the dataset with exactly the expected content; anything else means the
 * dataset is not in the state the record would claim, so this throws instead.
 */
export function buildImportRecord(options: {
  dataset: string
  source: ImportRecord['source']
  ndjsonSha256: string
  expected: readonly StoredDocument[]
  stored: readonly StoredDocument[]
  recordedAt?: string
}): ImportRecord {
  const stored = new Map(options.stored.map((doc) => [doc._id, doc]))
  const problems: string[] = []
  const documents: Record<string, RecordedDocument> = {}
  for (const doc of options.expected) {
    const actual = stored.get(doc._id)
    if (!actual) {
      problems.push(`${doc._id} is missing`)
      continue
    }
    if (typeof actual._rev !== 'string' || !actual._rev) {
      problems.push(`${doc._id} has no _rev`)
      continue
    }
    const hash = contentHash(doc)
    if (contentHash(actual) !== hash) {
      problems.push(`${doc._id} differs from the expected document`)
      continue
    }
    documents[doc._id] = {rev: actual._rev, contentHash: hash}
  }
  const expectedIds = new Set(options.expected.map((doc) => doc._id))
  for (const id of stored.keys()) {
    if (MIGRATION_ID_PATTERN.test(id) && !expectedIds.has(id)) problems.push(`${id} is in the dataset but not expected`)
  }
  if (problems.length) {
    throw new Error(`The ${options.dataset} dataset does not match the documents to record:\n- ${problems.sort().join('\n- ')}`)
  }
  return {
    dataset: options.dataset,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    source: options.source,
    ndjsonSha256: options.ndjsonSha256,
    documents: Object.fromEntries(Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }
}
