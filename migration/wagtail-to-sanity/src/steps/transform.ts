/**
 * Step 5: transform.
 *
 * Builds every Sanity document (src/transform/documents.ts) and writes them, sorted by _id, to
 * transformed/<dataset>/data.ndjson. The output only depends on the export and the state files,
 * so reruns write the same bytes.
 *
 * Reports (outside git, may quote unpublished text): reports/wp3/transform-<dataset>.json with
 * per-record issues, tag merges, link-text flattening and the Wagtail -> Sanity mapping.
 * Any error-level issue (an element or value outside the allowlist, a missing reference, ...)
 * fails the step after the report is written.
 */
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import path from 'node:path'

import type {Dataset, DataPaths} from '../config'
import {buildDocuments, type SanityDocument} from '../transform/documents'
import {loadStudioSchema} from '../transform/schema'
import {log, readJson, writeJson, writeText} from '../util'
import {loadExport, loadTagSlugs} from '../wagtail'
import type {AsciiMap} from './ascii'
import type {AssetMap} from './assets'
import type {MuxMap} from './mux'

export function ndjsonPath(paths: DataPaths, dataset: Dataset): string {
  return path.join(paths.transformed, dataset, 'data.ndjson')
}

export function readNdjson(file: string): SanityDocument[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SanityDocument)
}

export function countByType(documents: SanityDocument[]): Record<string, {published: number; drafts: number}> {
  const counts: Record<string, {published: number; drafts: number}> = {}
  for (const doc of documents) {
    const entry = (counts[doc._type] ??= {published: 0, drafts: 0})
    if (doc._id.startsWith('drafts.')) entry.drafts++
    else entry.published++
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

export async function transform(paths: DataPaths, dataset: Dataset): Promise<SanityDocument[]> {
  const data = loadExport(paths.exportJson)
  const result = buildDocuments({
    data,
    tagSlugs: loadTagSlugs(paths.dumpdataJson),
    assets: readJson<AssetMap>(path.join(paths.state, `assets-${dataset}.json`)),
    mux: readJson<MuxMap>(path.join(paths.state, 'mux-map.json')),
    ascii: readJson<AsciiMap>(path.join(paths.state, `ascii-${dataset}.json`)),
    schema: await loadStudioSchema(),
  })
  const documents = [...result.documents].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
  const counts = countByType(documents)
  const errors = result.issues.filter((i) => i.level === 'error')
  writeJson(path.join(paths.reports, 'wp3', `transform-${dataset}.json`), {
    dataset,
    exportGeneratedAt: data.generated_at,
    counts,
    issues: result.issues,
    tagMerges: result.tagMerges,
    linkTextFlattening: result.linkTextFlattening,
    mapping: result.mapping,
  })
  if (errors.length) {
    throw new Error(`transform: ${errors.length} error(s):\n- ${errors.map((e) => e.message).join('\n- ')}`)
  }
  const ndjson = documents.map((doc) => JSON.stringify(doc)).join('\n') + '\n'
  const file = ndjsonPath(paths, dataset)
  writeText(file, ndjson)
  const sha = createHash('sha256').update(ndjson).digest('hex').slice(0, 16)
  const warnings = result.issues.filter((i) => i.level === 'warning').length
  log(`transform: ${documents.length} documents -> ${file} (sha256 ${sha}…), ${warnings} warnings, ${result.tagMerges.length} tag merges`)
  for (const [type, c] of Object.entries(counts)) log(`  ${type}: ${c.published} published, ${c.drafts} drafts`)
  return documents
}
