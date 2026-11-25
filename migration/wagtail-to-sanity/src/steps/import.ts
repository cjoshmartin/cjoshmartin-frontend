/**
 * Step 6: import.
 *
 * 1. Validates the NDJSON against the Studio schema of the target workspace with
 *    `sanity documents validate --file ... --level error` (run from studio/ with the Studio's
 *    own CLI, so the schema, plugins and custom rules are exactly the deployed ones).
 * 2. Imports it with `sanity datasets import --replace`: documents with the same _id are
 *    replaced, so reruns converge.
 * 3. Prunes documents that an earlier run created but the transform no longer produces (for
 *    example a page that has since been published, whose drafts.<id> must go). Only ids that
 *    follow this migration's deterministic patterns are considered; assets, secrets.mux and
 *    anything an editor created (Studio ids are random) are never touched.
 *
 * The CLI uses the machine's `sanity login` (the project owner).
 */
import path from 'node:path'

import {STUDIO_DIR, type Dataset, type DataPaths, type Secrets} from '../config'
import {sanityClient} from '../sanity'
import {log, run, writeText} from '../util'
import {ndjsonPath, readNdjson} from './transform'

/** _id patterns this migration owns (published and drafts). */
export const MIGRATION_ID_PATTERN =
  /^(?:drafts\.)?(?:homePage|person-\d+|testimonial-\d+|service-\d+|blogPost-\d+|project-\d+|flexPage-\d+|medium-[a-z0-9]+(?:-[a-z0-9]+)*|technology-[a-z0-9]+(?:-[a-z0-9]+)*|redirect-\d+|mux-video-\d+)$/

export async function sanityCli(args: string[], logName: string, paths: DataPaths): Promise<string> {
  const result = await run('npx', ['--no-install', 'sanity', ...args], {cwd: STUDIO_DIR, timeoutMs: 30 * 60 * 1000})
  writeText(path.join(paths.reports, 'wp3', logName), `$ sanity ${args.join(' ')}\n\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

export async function validateNdjson(paths: DataPaths, dataset: Dataset, file: string): Promise<void> {
  const out = await sanityCli(
    ['documents', 'validate', '--workspace', dataset, '--file', file, '--level', 'error', '--yes', '--format', 'json'],
    `validate-ndjson-${dataset}.log`,
    paths,
  )
  const markers = JSON.parse(out.trim() || '[]') as {documentId: string; markers: {level: string; message: string; path: unknown[]}[]}[]
  const errors = markers.flatMap((doc) =>
    doc.markers.filter((m) => m.level === 'error').map((m) => `${doc.documentId} ${JSON.stringify(m.path)}: ${m.message}`),
  )
  if (errors.length) throw new Error(`The NDJSON fails Studio validation:\n- ${errors.join('\n- ')}`)
}

export async function importDataset(paths: DataPaths, dataset: Dataset, secrets: Secrets): Promise<void> {
  const file = ndjsonPath(paths, dataset)
  const documents = readNdjson(file)
  for (const doc of documents) {
    if (!MIGRATION_ID_PATTERN.test(doc._id)) throw new Error(`Refusing to import ${doc._id}: not a migration id`)
  }

  log(`import: validating ${documents.length} documents against the ${dataset} workspace schema`)
  await validateNdjson(paths, dataset, file)

  log(`import: sanity datasets import --replace into ${dataset}`)
  await sanityCli(['datasets', 'import', file, '--dataset', dataset, '--replace'], `import-${dataset}.log`, paths)

  const client = sanityClient(dataset, secrets)
  const wanted = new Set(documents.map((d) => d._id))
  const present = await client.fetch<string[]>(`*[!(_id in path("_.**")) && !(_id in path("versions.**"))]._id`)
  const stale = present.filter((id) => MIGRATION_ID_PATTERN.test(id) && !wanted.has(id)).sort()
  if (stale.length) {
    log(`import: deleting ${stale.length} documents an earlier run created that the transform no longer produces: ${stale.join(', ')}`)
    const tx = client.transaction()
    for (const id of stale) tx.delete(id)
    await tx.commit({visibility: 'sync'})
  }
  const missing = [...wanted].filter((id) => !present.includes(id))
  if (missing.length) throw new Error(`import: ${missing.length} documents are missing after the import: ${missing.join(', ')}`)
  log(`import: ${documents.length} documents in ${dataset}, ${stale.length} stale documents removed`)
}
