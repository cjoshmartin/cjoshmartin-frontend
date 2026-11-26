/**
 * In-memory ContentStore for the orchestrator tests: documents with revisions, revision-checked
 * patches with the `field[_key=="..."].child` paths the Function writes, and the two queries,
 * evaluated with groq-js against the same documents.
 */
import {randomUUID} from 'node:crypto'

import {evaluate, parse} from 'groq-js'

import {PRIVACY_FIELD, VIDEO_ORIGINAL_SOURCE_NAME, VIDEO_STRIP_VERSION} from '../../privacy/constants'
import {uploadDigest, type UploadDigester} from '../../privacy/provenance'
import {isWritableDocument, releaseDocumentId, releaseOfVersion} from '../../privacy/releases'
import type {AssetDocument, ContentStore, DeleteOutcome, StoredDocument} from '../orchestrator'
import type {PatchOps} from '../patches'
import {
  CONVERTED_ASSET_SETTINGS_FIELD,
  CONVERTED_ASSET_SOURCE_NAME,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
} from '../settings'
import {documentsUsingFileQuery} from '../trigger'

type Doc = Record<string, unknown> & {_id: string; _type: string}

/** The digest the tests' copies record instead of their upload's id (a fixed test key). */
export const testUploadDigest: UploadDigester = (id) => uploadDigest(id, 'ab'.repeat(32))

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[_key==("(?:[^"\\]|\\.)*")\])?$/

function splitPath(path: string): {field: string; key?: string}[] {
  // Keys are JSON strings, which may contain dots; split only on dots outside brackets.
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of path) {
    if (char === '[') depth += 1
    if (char === ']') depth -= 1
    if (char === '.' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts.map((part) => {
    const match = SEGMENT.exec(part)
    if (!match) throw new Error(`unsupported patch path segment ${part} in ${path}`)
    return {
      field: match[1],
      ...(match[2] === undefined ? {} : {key: JSON.parse(match[2]) as string}),
    }
  })
}

/** Applies set/unset like Sanity does for the paths the Function uses. */
export function applyPatch<T extends Record<string, unknown>>(doc: T, ops: PatchOps): T {
  const copy = structuredClone(doc) as Record<string, unknown>
  type Target =
    | {kind: 'field'; container: Record<string, unknown>; name: string}
    | {kind: 'item'; array: unknown[]; index: number}
  const resolve = (path: string, create: boolean): Target | null => {
    const segments = splitPath(path)
    let container: Record<string, unknown> = copy
    for (let i = 0; i < segments.length; i++) {
      const {field, key} = segments[i]
      const last = i === segments.length - 1
      if (key === undefined) {
        if (last) return {kind: 'field', container, name: field}
        if (container[field] === undefined) {
          if (!create) return null
          container[field] = {}
        }
        container = container[field] as Record<string, unknown>
        continue
      }
      const array = container[field]
      if (!Array.isArray(array)) return null
      const index = array.findIndex((item) => (item as {_key?: string})._key === key)
      if (index === -1) return null
      if (last) return {kind: 'item', array, index}
      container = array[index] as Record<string, unknown>
    }
    return null
  }
  for (const [path, value] of Object.entries(ops.set ?? {})) {
    const target = resolve(path, true)
    if (!target) continue // Sanity ignores set on a keyed path that matches nothing.
    if (target.kind === 'item') target.array[target.index] = structuredClone(value)
    else target.container[target.name] = structuredClone(value)
  }
  for (const path of ops.unset ?? []) {
    const target = resolve(path, false)
    if (!target) continue
    if (target.kind === 'item') target.array.splice(target.index, 1)
    else delete target.container[target.name]
  }
  return copy as T
}

export class MemoryStore implements ContentStore {
  readonly docs = new Map<string, Doc & {_rev: string}>()
  readonly patches: {id: string; ops: PatchOps}[] = []
  /** Revision conflicts to simulate: the next N patches of this id fail as if edited meanwhile. */
  readonly forcedConflicts = new Map<string, number>()
  /** Called after every successful patch (the "event" hook of the tests). */
  onPatch: ((id: string) => void) | undefined
  /** Awaited before every read, so a test can interleave runs at an exact point. */
  beforeRead: ((id: string) => Promise<void>) | undefined

  put(doc: Doc): Doc & {_rev: string} {
    const stored = {...structuredClone(doc), _rev: randomUUID()}
    this.docs.set(doc._id, stored)
    return stored
  }

  delete(id: string): void {
    this.docs.delete(id)
  }

  get(id: string): (Doc & {_rev: string}) | undefined {
    const doc = this.docs.get(id)
    return doc ? structuredClone(doc) : undefined
  }

  async getDocument(id: string): Promise<StoredDocument | null> {
    await Promise.resolve()
    await this.beforeRead?.(id)
    const doc = this.docs.get(id)
    return doc ? (structuredClone(doc) as StoredDocument) : null
  }

  async patchIfRevision(id: string, revision: string, ops: PatchOps): Promise<'ok' | 'conflict'> {
    await Promise.resolve()
    const forced = this.forcedConflicts.get(id) ?? 0
    if (forced > 0) {
      this.forcedConflicts.set(id, forced - 1)
      // Somebody else edited the document: bump its revision.
      const doc = this.docs.get(id)
      if (doc) this.docs.set(id, {...doc, _rev: randomUUID()})
      return 'conflict'
    }
    const doc = this.docs.get(id)
    if (!doc || doc._rev !== revision) return 'conflict'
    this.docs.set(id, {...applyPatch(doc, ops), _rev: randomUUID()})
    this.patches.push({id, ops})
    this.onPatch?.(id)
    return 'ok'
  }

  private async query<T>(query: string, params: Record<string, unknown>): Promise<T> {
    const result = await evaluate(parse(query), {dataset: [...this.docs.values()], params})
    return (await result.get()) as T
  }

  async documentsUsingFile(assetId: string): Promise<string[]> {
    return this.query<string[]>(documentsUsingFileQuery(), {assetId})
  }

  async isWritable(id: string): Promise<boolean> {
    const release = releaseOfVersion(id)
    const state = release === null ? null : ((this.docs.get(releaseDocumentId(release)) as {state?: string} | undefined)?.state ?? null)
    return isWritableDocument(id, state)
  }

  async findConvertedAsset(sourceAssetId: string): Promise<AssetDocument | null> {
    return this.query<AssetDocument | null>(
      `*[_type == "sanity.fileAsset" && source.name == $name && source.id == $id && mimeType == $mimeType && ${CONVERTED_ASSET_SETTINGS_FIELD} == $settingsVersion] | order(_createdAt asc)[0]`,
      {
        name: CONVERTED_ASSET_SOURCE_NAME,
        id: sourceAssetId,
        mimeType: OUTPUT_MIME_TYPE,
        settingsVersion: SETTINGS_VERSION,
      },
    )
  }

  async findStrippedOriginal(uploadAssetId: string): Promise<AssetDocument | null> {
    return this.query<AssetDocument | null>(
      `*[_type == "sanity.fileAsset" && source.name == $name && source.id == $id && ${PRIVACY_FIELD}.status == "stripped" && ${PRIVACY_FIELD}.version == $version] | order(_createdAt asc)[0]`,
      {name: VIDEO_ORIGINAL_SOURCE_NAME, id: testUploadDigest(uploadAssetId), version: VIDEO_STRIP_VERSION},
    )
  }

  /** Ids of every document (drafts and versions included) that references the asset. */
  async referencing(assetId: string): Promise<string[]> {
    return this.query<string[]>('*[references($id)]._id', {id: assetId})
  }

  async deleteAssetIfUnreferenced(assetId: string): Promise<DeleteOutcome> {
    const by = await this.referencing(assetId)
    if (by.length > 0) return {kind: 'referenced', by}
    if (!this.docs.has(assetId)) return {kind: 'missing'}
    this.docs.delete(assetId)
    return {kind: 'deleted'}
  }
}
