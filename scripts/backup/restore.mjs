#!/usr/bin/env node
// Restores a snapshot written by backup.mjs into a Sanity dataset with
// `sanity datasets import`. See README.md ("Restore") before using it.
import {spawn} from 'node:child_process'
import {mkdtemp, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {createLogger, parseCli, parsePositiveInteger, UsageError} from './lib/cli.mjs'
import {
  buildRestoreArchive,
  compareWithSnapshot,
  needsAllowAssetsInDifferentDataset,
  planAssetMetadataPatches,
  planExactDeletions,
  resolveSnapshot,
} from './lib/restore.mjs'
import {assertDatasetName, assertProjectId, exportDataset} from './lib/sanity-export.mjs'
import {deleteDocuments, patchDocuments} from './lib/sanity-mutate.mjs'
import {createStorage} from './lib/storage/index.mjs'
import {formatBytes} from './lib/util.mjs'

const USAGE = `Usage: node restore.mjs (--snapshot <ts> | --latest) --dataset <target> --source gcs|local [options]

Snapshot selection:
  --snapshot <ts>              A completed snapshot, e.g. 20261129T090000Z
  --latest                     The newest completed snapshot of the source dataset (newest marker name)
  --from-dataset <name>        The dataset the snapshot was taken of (default: --dataset). A snapshot
                               of another dataset is refused unless this names it, so
                               --latest --dataset production never picks a staging snapshot.

Source:
  --source gcs|local           Where the backups are (required)
  --bucket <name>              GCS bucket (default: $BACKUP_BUCKET)
  --local-dir <dir>            Backup directory for --source local

Target and import:
  --dataset <name>             Dataset to import into (required unless --build-only)
  --project <id>               Target project (default: $SANITY_PROJECT_ID)
  --replace                    Replace documents that already exist (sanity datasets import --replace),
                               then restore the metadata of asset documents the import reused
  --exact                      After importing, delete target documents that are not in the snapshot
                               (implies --replace; never touches _.* system documents)
  --i-understand-production    Required for --exact when the target dataset is "production"
  --verify                     After importing, compare the target with the snapshot and fail on differences
  --allow-failing-assets       Let the import skip assets that are missing from the bucket
  --sanity-cli <spec>          npm spec of the CLI to run with npx (default: sanity@latest)

Archive:
  --build-only                 Only build the import tarball; do not touch Sanity
  --output <file.tar.gz>       Where to write the tarball (default: inside the work directory)
  --work-dir <dir>             Parent of the temporary work directory (default: OS temp)
  --keep-work-dir              Keep the work directory (and tarball) after an import
  --concurrency <n>            Parallel asset downloads (default: 4)
  -h, --help                   Show this help

Environment:
  SANITY_PROJECT_ID            Default for --project
  SANITY_WRITE_TOKEN           Editor token. Passed to the CLI as SANITY_AUTH_TOKEN; required for
                               --replace, --exact and --verify. Without it a plain import uses
                               your \`sanity login\` session.
  BACKUP_BUCKET                Default for --bucket

A restore is not a point-in-time reset: see README.md.`

function runCommand(command, commandArgs, {env}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {stdio: 'inherit', env})
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${commandArgs.slice(0, 4).join(' ')} … exited with ${signal ?? `code ${code}`}`))
    })
  })
}

async function main() {
  const args = parseCli(process.argv.slice(2), {
    snapshot: {type: 'string'},
    latest: {type: 'boolean', default: false},
    'from-dataset': {type: 'string'},
    source: {type: 'string'},
    bucket: {type: 'string'},
    'local-dir': {type: 'string'},
    dataset: {type: 'string'},
    project: {type: 'string'},
    replace: {type: 'boolean', default: false},
    exact: {type: 'boolean', default: false},
    'i-understand-production': {type: 'boolean', default: false},
    verify: {type: 'boolean', default: false},
    'allow-failing-assets': {type: 'boolean', default: false},
    'sanity-cli': {type: 'string', default: 'sanity@latest'},
    'build-only': {type: 'boolean', default: false},
    output: {type: 'string'},
    'work-dir': {type: 'string'},
    'keep-work-dir': {type: 'boolean', default: false},
    concurrency: {type: 'string'},
  }, USAGE)
  const log = createLogger()

  if (args.source !== 'gcs' && args.source !== 'local') throw new UsageError(`--source must be gcs or local\n\n${USAGE}`)
  const buildOnly = args['build-only']
  if (buildOnly && (args.exact || args.verify || args.replace)) throw new UsageError('--build-only cannot be combined with --replace, --exact or --verify')
  let projectId
  if (!buildOnly) {
    if (!args.dataset) throw new UsageError(`--dataset is required\n\n${USAGE}`)
    assertDatasetName(args.dataset)
    projectId = args.project ?? process.env.SANITY_PROJECT_ID
    assertProjectId(projectId)
    if (args.exact && args.dataset === 'production' && !args['i-understand-production']) {
      throw new UsageError('--exact deletes documents. Refusing to run it against "production" without --i-understand-production')
    }
  }
  const token = process.env.SANITY_WRITE_TOKEN
  const replace = args.replace || args.exact
  if ((replace || args.verify) && !token) throw new UsageError('--replace, --exact and --verify need SANITY_WRITE_TOKEN (Editor role)')
  const concurrency = parsePositiveInteger(args.concurrency, '--concurrency') ?? 4

  // The dataset the snapshot must be of. Defaults to the target, so restoring one dataset's
  // snapshot into another always needs --from-dataset.
  const sourceDataset = args['from-dataset'] ?? args.dataset
  if (sourceDataset !== undefined) assertDatasetName(sourceDataset)
  if (args.latest && sourceDataset === undefined) {
    throw new UsageError(`--latest needs --dataset or --from-dataset: the dataset whose newest snapshot to use\n\n${USAGE}`)
  }

  const storage = await createStorage({kind: args.source, bucket: args.bucket ?? process.env.BACKUP_BUCKET, localDir: args['local-dir']})
  const timestamp = await resolveSnapshot(storage, {snapshot: args.snapshot, latest: args.latest, sourceDataset})
  log.info(`Restoring snapshot ${timestamp} from ${storage.describe()}`)
  if (!buildOnly && sourceDataset !== args.dataset) {
    log.warn(`Restoring a snapshot of dataset ${sourceDataset} into dataset ${args.dataset} (--from-dataset)`)
  }

  const workDir = await mkdtemp(path.join(args['work-dir'] ?? os.tmpdir(), 'sanity-restore-'))
  const tarballPath = path.resolve(args.output ?? path.join(workDir, `snapshot-${timestamp}.tar.gz`))
  // --build-only without --output leaves the tarball inside the work directory, so keep it.
  let keepWorkDir = args['keep-work-dir'] || (buildOnly && !args.output)
  try {
    const archive = await buildRestoreArchive({
      storage,
      timestamp,
      workDir,
      tarballPath,
      allowFailingAssets: args['allow-failing-assets'],
      concurrency,
      log,
    })
    const {marker, prepared} = archive
    log.info(
      `Snapshot of ${marker.projectId}/${marker.dataset} taken ${marker.createdAt}: ${marker.documentCount} documents. ` +
        `Import file: ${prepared.importDocuments.length} documents, ${archive.assetCount} asset binaries; ` +
        `${prepared.droppedSystemIds.length} Sanity-managed system documents left out`,
    )
    log.info(`Import tarball: ${tarballPath}`)
    if (buildOnly) return

    const allowDifferentDataset = needsAllowAssetsInDifferentDataset(prepared.otherAssetDocuments, {projectId, dataset: args.dataset})
    const cliArgs = [
      '--yes',
      args['sanity-cli'],
      'datasets',
      'import',
      tarballPath,
      '--project',
      projectId,
      '--dataset',
      args.dataset,
      ...(replace ? ['--replace'] : []),
      ...(allowDifferentDataset ? ['--allow-assets-in-different-dataset'] : []),
      ...(args['allow-failing-assets'] ? ['--allow-failing-assets'] : []),
    ]
    const env = {...process.env}
    if (token) env.SANITY_AUTH_TOKEN = token
    log.info(`Running: npx ${cliArgs.join(' ')}`)
    await runCommand('npx', cliArgs, {env})

    if (replace) {
      const targetDocuments = await exportDataset({projectId, dataset: args.dataset, token})
      const patches = planAssetMetadataPatches({prepared, targetDocuments})
      log.info(`Asset metadata: ${patches.length} of ${prepared.assetDocuments.length} asset documents in the target differ from the snapshot`)
      for (const {id, set, unset} of patches) {
        log.info(`  ${id}: set ${Object.keys(set).join(', ') || '(nothing)'}; unset ${unset.join(', ') || '(nothing)'}`)
      }
      if (patches.length > 0) await patchDocuments({projectId, dataset: args.dataset, token, patches})
    }

    if (args.exact) {
      const targetDocuments = await exportDataset({projectId, dataset: args.dataset, token})
      const plan = planExactDeletions({prepared, targetDocuments})
      log.info(`--exact: deleting ${plan.deleteDocumentIds.length} documents and ${plan.deleteAssetIds.length} assets that are not in the snapshot`)
      for (const id of plan.keptSystemIds) log.warn(`Release ${id} is not in the snapshot; archive it in the Studio if it should go`)
      if (plan.deleteDocumentIds.length > 0) await deleteDocuments({projectId, dataset: args.dataset, token, ids: plan.deleteDocumentIds})
      if (plan.deleteAssetIds.length > 0) await deleteDocuments({projectId, dataset: args.dataset, token, ids: plan.deleteAssetIds})
    }

    if (args.verify) {
      const targetDocuments = await exportDataset({projectId, dataset: args.dataset, token})
      const result = compareWithSnapshot({documents: archive.documents, prepared, targetDocuments})
      const problems = result.missing.length + result.changed.length + result.missingAssets.length + (args.exact ? result.extra.length : 0)
      log.info(
        `Verify: ${result.missing.length} missing, ${result.changed.length} changed, ${result.missingAssets.length} missing assets, ` +
          `${result.extra.length} extra documents in the target${args.exact ? '' : ' (allowed without --exact)'}`,
      )
      for (const id of result.missing.slice(0, 20)) log.warn(`Missing in target: ${id}`)
      for (const {id, path: fieldPath} of result.changed.slice(0, 20)) log.warn(`Differs from snapshot: ${id} at ${fieldPath}`)
      for (const id of result.missingAssets.slice(0, 20)) log.warn(`Asset missing in target: ${id}`)
      for (const id of result.extra.slice(0, 20)) (args.exact ? log.warn : log.info)(`Not in snapshot: ${id}`)
      if (result.createdAtDiffers.length > 0) {
        log.info(
          `${result.createdAtDiffers.length} restored documents have another _createdAt than in the snapshot. ` +
            'sanity datasets import --replace keeps the _createdAt of documents that already exist in the target, and a ' +
            're-created release definition gets the time of the import. This is not counted as a difference.',
        )
      }
      if (problems > 0) {
        keepWorkDir = true
        throw new Error(`Verification failed with ${problems} problem(s); the work directory is kept at ${workDir}`)
      }
      log.info('Verification passed: the target matches the snapshot (ignoring _rev, _updatedAt and _createdAt, and the url, path and uploadId of assets)')
    }
    log.info(`Restore of ${timestamp} into ${projectId}/${args.dataset} finished (tarball ${formatBytes((await stat(tarballPath)).size)})`)
  } finally {
    if (keepWorkDir) log.info(`Work directory kept: ${workDir}`)
    else await rm(workDir, {recursive: true, force: true})
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message)
  } else {
    createLogger().error(error.stack ?? String(error))
  }
  process.exitCode = 1
})
