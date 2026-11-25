/**
 * Step `baseline` (not part of the default run): records the migration documents of a dataset
 * that was imported before the import kept a record (state/imported-<dataset>.json), so the
 * next import can tell Studio edits apart.
 *
 * It only records what it can prove is untouched: every migration document in the dataset must
 * equal the document in transformed/<dataset>/data.ndjson (the file the last import used), with
 * no extra or missing ids and no release versions. Run it before the transform changes that file.
 * It refuses to replace an existing record, because recording a dataset's current state would
 * hide any edit made since the record was written.
 */
import {existsSync} from 'node:fs'

import type {Dataset, DataPaths, Secrets} from '../config'
import {buildImportRecord, releaseVersionTarget} from '../import-guard'
import {sanityClient} from '../sanity'
import {log, writeJson} from '../util'
import {fetchStoredDocuments, fetchVersionIds, fileSha256, importRecordPath} from './import'
import {ndjsonPath, readNdjson} from './transform'

export async function recordBaseline(paths: DataPaths, dataset: Dataset, secrets: Secrets): Promise<void> {
  const recordFile = importRecordPath(paths, dataset)
  if (existsSync(recordFile)) {
    throw new Error(`baseline: ${recordFile} already exists; the import check uses it, so it is not replaced`)
  }
  const file = ndjsonPath(paths, dataset)
  const expected = readNdjson(file)
  const client = sanityClient(dataset, secrets)
  const [stored, versionIds] = await Promise.all([fetchStoredDocuments(client), fetchVersionIds(client)])
  const versions = versionIds.filter((id) => releaseVersionTarget(id))
  if (versions.length) {
    throw new Error(`baseline: ${dataset} has release versions of migration documents (${versions.join(', ')}); it is not untouched`)
  }
  const record = buildImportRecord({dataset, source: 'baseline', ndjsonSha256: fileSha256(file), expected, stored})
  writeJson(recordFile, record)
  log(
    `baseline: ${dataset} equals ${file} (sha256 ${record.ndjsonSha256.slice(0, 16)}…); ` +
      `recorded ${Object.keys(record.documents).length} revisions in ${recordFile}`,
  )
}
