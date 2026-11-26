/**
 * Step 7: import.
 *
 * 1. Checks that no migration document changed in the dataset since this migration last wrote it
 *    (src/import-guard.ts, record in state/imported-<dataset>.json). Studio edits, drafts opened
 *    in the Studio, documents published from a migrated draft and release versions all stop the
 *    run before anything is written, unless `discardStudioEdits` is set.
 * 2. Validates the NDJSON against the Studio schema of the target workspace with
 *    `sanity documents validate --file ... --level error` (run from studio/ with the Studio's
 *    own CLI, so the schema, plugins and custom rules are exactly the deployed ones).
 * 3. Imports it with `sanity datasets import --replace`: documents with the same _id are
 *    replaced, so reruns converge.
 * 4. Prunes documents that an earlier run created but the transform no longer produces (for
 *    example a page that has since been published, whose drafts.<id> must go, or the
 *    mux.videoAsset documents of earlier runs). Only ids that follow this migration's
 *    deterministic patterns are considered; assets, `secrets.*` documents and anything an editor
 *    created (Studio ids are random) are never touched.
 * 5. Records the `_rev` and content hash of every migration document for the next run's check.
 *
 * The CLI uses the machine's `sanity login` (the project owner).
 */
import {createHash} from 'node:crypto'
import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'

import type {SanityClient} from '@sanity/client'

import {STUDIO_DIR, type Dataset, type DataPaths, type Secrets} from '../config'
import {
  buildImportRecord,
  describeStudioEdits,
  findStudioEdits,
  hasStudioEdits,
  MIGRATION_ID_PATTERN,
  type ImportRecord,
  type StoredDocument,
  type StudioEdits,
} from '../import-guard'
import {sanityClient} from '../sanity'
import {log, readJson, run, sleep, writeJson, writeText} from '../util'
import {ndjsonPath, readNdjson} from './transform'

export {MIGRATION_ID_PATTERN}

export async function sanityCli(args: string[], logName: string, paths: DataPaths): Promise<string> {
  const result = await run('npx', ['--no-install', 'sanity', ...args], {cwd: STUDIO_DIR, timeoutMs: 30 * 60 * 1000})
  writeText(path.join(paths.reports, 'wp3', logName), `$ sanity ${args.join(' ')}\n\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

/**
 * Runs `sanity documents validate ... --level error --format json` and returns every error marker
 * as "<document id> <path>: <message>". The CLI exits 1 when it finds errors; that exit is only
 * accepted together with JSON output that lists at least one error, anything else fails.
 */
export async function studioValidationErrors(args: string[], logName: string, paths: DataPaths): Promise<string[]> {
  const fullArgs = ['documents', 'validate', ...args, '--level', 'error', '--yes', '--format', 'json']
  const result = await run('npx', ['--no-install', 'sanity', ...fullArgs], {cwd: STUDIO_DIR, timeoutMs: 30 * 60 * 1000, okExitCodes: [1]})
  writeText(path.join(paths.reports, 'wp3', logName), `$ sanity ${fullArgs.join(' ')}\n(exit ${result.exitCode})\n\n${result.stdout}\n${result.stderr}`)
  let markers: {documentId: string; markers: {level: string; message: string; path: unknown[]}[]}[]
  try {
    markers = JSON.parse(result.stdout.trim() || '[]') as typeof markers
  } catch {
    throw new Error(`sanity ${fullArgs.join(' ')} exited ${result.exitCode} without JSON output:\n${(result.stderr || result.stdout).slice(-4000)}`)
  }
  const errors = markers.flatMap((doc) =>
    doc.markers.filter((m) => m.level === 'error').map((m) => `${doc.documentId} ${JSON.stringify(m.path)}: ${m.message}`),
  )
  if (result.exitCode !== 0 && errors.length === 0) {
    throw new Error(`sanity ${fullArgs.join(' ')} exited ${result.exitCode} but listed no errors:\n${result.stderr.slice(-4000)}`)
  }
  return errors
}

export async function validateNdjson(paths: DataPaths, dataset: Dataset, file: string): Promise<void> {
  const errors = await studioValidationErrors(['--workspace', dataset, '--file', file], `validate-ndjson-${dataset}.log`, paths)
  if (errors.length) throw new Error(`The NDJSON fails Studio validation:\n- ${errors.join('\n- ')}`)
}

/** How long the import waits for the dataset to read back as imported. */
const READ_BACK_TIMEOUT_MS = 60_000

/**
 * Runs `read` until it succeeds, every 2 s, for at most READ_BACK_TIMEOUT_MS, then throws its last
 * error. For reads that check what a write just did, because queries can lag behind writes.
 */
async function untilConsistent<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + READ_BACK_TIMEOUT_MS
  for (let attempt = 1; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (Date.now() > deadline) throw error
      if (attempt === 1) log(`import: the dataset does not read back as imported yet, retrying for up to ${READ_BACK_TIMEOUT_MS / 1000} s`)
      await sleep(2000)
    }
  }
}

export function importRecordPath(paths: DataPaths, dataset: Dataset): string {
  return path.join(paths.state, `imported-${dataset}.json`)
}

export function readImportRecord(paths: DataPaths, dataset: Dataset): ImportRecord | null {
  const file = importRecordPath(paths, dataset)
  if (!existsSync(file)) return null
  const record = readJson<ImportRecord>(file)
  if (record.dataset !== dataset) throw new Error(`${file} is the record of dataset ${record.dataset}, not ${dataset}`)
  return record
}

export function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every document outside `_.**` and `versions.**` (raw perspective: published and drafts). */
export async function fetchStoredDocuments(client: SanityClient): Promise<StoredDocument[]> {
  return client.fetch<StoredDocument[]>(`*[!(_id in path("_.**")) && !(_id in path("versions.**"))]`)
}

export async function fetchVersionIds(client: SanityClient): Promise<string[]> {
  return client.fetch<string[]>(`*[_id in path("versions.**")]._id`)
}

/**
 * The Studio-edit check. Throws, before anything is written, when migration documents changed
 * since the record, or when there is no record for a dataset that already holds migration
 * documents. Returns what was found (all empty when nothing changed).
 */
export async function checkForStudioEdits(
  paths: DataPaths,
  dataset: Dataset,
  client: SanityClient,
  options: {discardStudioEdits: boolean},
): Promise<StudioEdits> {
  const [stored, versionIds] = await Promise.all([fetchStoredDocuments(client), fetchVersionIds(client)])
  const record = readImportRecord(paths, dataset)
  const migrationIds = stored.filter((doc) => MIGRATION_ID_PATTERN.test(doc._id)).map((doc) => doc._id)
  if (!record) {
    if (migrationIds.length === 0) {
      log(`import: ${dataset} holds no migration documents yet, nothing to protect`)
      return {changed: [], created: [], deleted: [], inReleases: []}
    }
    if (!options.discardStudioEdits) {
      throw new Error(
        `import: ${dataset} already holds ${migrationIds.length} migration documents, but there is no record of the last ` +
          `import (${importRecordPath(paths, dataset)}), so Studio edits cannot be told apart. ` +
          `If the dataset is untouched since the last import, record it with --steps baseline before changing the transform.`,
      )
    }
    log(`import: WARNING no import record for ${dataset}; --discard-studio-edits replaces all ${migrationIds.length} migration documents`)
    return {changed: migrationIds, created: [], deleted: [], inReleases: []}
  }
  const edits = findStudioEdits(record, stored, versionIds)
  if (!hasStudioEdits(edits)) {
    log(`import: no Studio edits to migration documents since the record of ${record.recordedAt}`)
    return edits
  }
  if (!options.discardStudioEdits) {
    throw new Error(
      `import: refusing to import into ${dataset}; migration documents changed since this migration last wrote them ` +
        `(${record.source}, ${record.recordedAt}):\n${describeStudioEdits(edits)}\n` +
        'An import would overwrite or delete these changes. Keep them (and change those documents in the Studio instead), ' +
        'or pass --discard-studio-edits to overwrite them on purpose.',
    )
  }
  log(`import: WARNING --discard-studio-edits overwrites these changes in ${dataset}:\n${describeStudioEdits(edits)}`)
  return edits
}

export async function importDataset(
  paths: DataPaths,
  dataset: Dataset,
  secrets: Secrets,
  options: {discardStudioEdits: boolean},
): Promise<void> {
  const file = ndjsonPath(paths, dataset)
  const documents = readNdjson(file)
  for (const doc of documents) {
    if (!MIGRATION_ID_PATTERN.test(doc._id)) throw new Error(`Refusing to import ${doc._id}: not a migration id`)
  }
  const client = sanityClient(dataset, secrets)

  await checkForStudioEdits(paths, dataset, client, options)

  log(`import: validating ${documents.length} documents against the ${dataset} workspace schema`)
  await validateNdjson(paths, dataset, file)

  log(`import: sanity datasets import --replace into ${dataset}`)
  await sanityCli(['datasets', 'import', file, '--dataset', dataset, '--replace'], `import-${dataset}.log`, paths)

  // `sanity datasets import` writes references weak first and strengthens them in a second pass,
  // and queries can lag a few seconds behind both. Every read below therefore waits until the
  // dataset reads back as imported (or fails after READ_BACK_TIMEOUT_MS with the last difference).
  const wanted = new Set(documents.map((d) => d._id))
  const present = await untilConsistent(async () => {
    const ids = await client.fetch<string[]>(`*[!(_id in path("_.**")) && !(_id in path("versions.**"))]._id`)
    const missing = [...wanted].filter((id) => !ids.includes(id))
    if (missing.length) throw new Error(`import: ${missing.length} documents are missing after the import: ${missing.join(', ')}`)
    return ids
  })
  const stale = present.filter((id) => MIGRATION_ID_PATTERN.test(id) && !wanted.has(id)).sort()
  if (stale.length) {
    log(`import: deleting ${stale.length} documents an earlier run created that the transform no longer produces: ${stale.join(', ')}`)
    const tx = client.transaction()
    for (const id of stale) tx.delete(id)
    await tx.commit({visibility: 'sync'})
  }

  const ndjsonSha256 = fileSha256(file)
  const record = await untilConsistent(async () =>
    buildImportRecord({dataset, source: 'import', ndjsonSha256, expected: documents, stored: await fetchStoredDocuments(client)}),
  )
  writeJson(importRecordPath(paths, dataset), record)
  log(
    `import: ${documents.length} documents in ${dataset}, ${stale.length} stale documents removed; ` +
      `recorded ${Object.keys(record.documents).length} revisions in ${importRecordPath(paths, dataset)}`,
  )
}
