#!/usr/bin/env node
// Weekly Sanity backup. See README.md for the design and plan §10 for the spec.
import os from 'node:os'

import {BucketTooLargeError, DEFAULT_MAX_BUCKET_BYTES, runBackup} from './lib/backup.mjs'
import {createLogger, parseCli, parsePositiveInteger, readToolInfo, UsageError, writeStepSummary} from './lib/cli.mjs'
import {createMuxArchiver, MuxClient} from './lib/mux.mjs'
import {downloadSanityAsset} from './lib/sanity-assets.mjs'
import {assertDatasetName, assertProjectId, exportDataset} from './lib/sanity-export.mjs'
import {createStorage} from './lib/storage/index.mjs'
import {formatBytes} from './lib/util.mjs'

const USAGE = `Usage: node backup.mjs --dataset <name> --target gcs|local [options]

Options:
  --dataset <name>             Sanity dataset to back up (required)
  --target gcs|local           Where to write (required)
  --bucket <name>              GCS bucket for --target gcs (default: $BACKUP_BUCKET)
  --local-dir <dir>            Directory for --target local
  --project <id>               Sanity project id (default: $SANITY_PROJECT_ID)
  --dry-run                    Fingerprint, compare and list what would be written; write nothing
  --max-bucket-bytes <n>       Fail when the bucket holds more than this (default: ${DEFAULT_MAX_BUCKET_BYTES}, 4 GiB)
  --concurrency <n>            Parallel asset downloads/uploads (default: 4)
  --mux-timeout-minutes <n>    Per-video limit for Mux to prepare a master (default: 20)
  -h, --help                   Show this help

Environment:
  SANITY_PROJECT_ID            Sanity project id
  SANITY_READ_TOKEN            Sanity token with the Viewer role (reads drafts); required
  MUX_TOKEN_ID, MUX_TOKEN_SECRET
                               Mux token (Video read + write); required when a Mux original
                               is not in the bucket yet
  BACKUP_BUCKET                Default for --bucket
  GOOGLE_APPLICATION_CREDENTIALS
                               Set by google-github-actions/auth in CI; locally use
                               gcloud auth application-default login

Exit codes: 0 snapshot written, no changes, or dry run; 1 failure;
            3 snapshot written with warnings (see the manifest's "warnings").`

async function main() {
  const args = parseCli(process.argv.slice(2), {
    dataset: {type: 'string'},
    target: {type: 'string'},
    bucket: {type: 'string'},
    'local-dir': {type: 'string'},
    project: {type: 'string'},
    'dry-run': {type: 'boolean', default: false},
    'max-bucket-bytes': {type: 'string'},
    concurrency: {type: 'string'},
    'mux-timeout-minutes': {type: 'string'},
  }, USAGE)

  if (!args.dataset) throw new UsageError(`--dataset is required\n\n${USAGE}`)
  if (args.target !== 'gcs' && args.target !== 'local') throw new UsageError(`--target must be gcs or local\n\n${USAGE}`)
  const projectId = args.project ?? process.env.SANITY_PROJECT_ID
  assertProjectId(projectId)
  assertDatasetName(args.dataset)
  const token = process.env.SANITY_READ_TOKEN
  if (!token) throw new UsageError('SANITY_READ_TOKEN is not set (a Viewer token; it must be able to read drafts)')
  const maxBucketBytes = parsePositiveInteger(args['max-bucket-bytes'], '--max-bucket-bytes') ?? DEFAULT_MAX_BUCKET_BYTES
  const concurrency = parsePositiveInteger(args.concurrency, '--concurrency') ?? 4
  const muxTimeoutMinutes = parsePositiveInteger(args['mux-timeout-minutes'], '--mux-timeout-minutes') ?? 20

  const log = createLogger()
  const storage = await createStorage({
    kind: args.target,
    bucket: args.bucket ?? process.env.BACKUP_BUCKET,
    localDir: args['local-dir'],
  })

  const muxArchiver =
    process.env.MUX_TOKEN_ID && process.env.MUX_TOKEN_SECRET
      ? createMuxArchiver({
          client: new MuxClient({tokenId: process.env.MUX_TOKEN_ID, tokenSecret: process.env.MUX_TOKEN_SECRET}),
          timeoutMs: muxTimeoutMinutes * 60_000,
          log: log.info,
        })
      : null

  const result = await runBackup({
    projectId,
    dataset: args.dataset,
    storage,
    exportDocuments: () => exportDataset({projectId, dataset: args.dataset, token}),
    downloadAsset: (asset, destPath) => downloadSanityAsset({asset, token, destPath}),
    muxArchiver,
    tmpDir: process.env.RUNNER_TEMP || os.tmpdir(),
    log,
    dryRun: args['dry-run'],
    maxBucketBytes,
    concurrency,
    tool: await readToolInfo(),
  })

  const summary = [
    `### Sanity backup: ${projectId}/${args.dataset}`,
    '',
    `- Result: **${result.status}**${result.timestamp ? ` (snapshot ${result.timestamp})` : ''}`,
    `- Documents: ${result.counts.total} (${result.counts.published} published, ${result.counts.drafts} drafts, ${result.counts.versions} release versions, ${result.counts.system} system)`,
    `- Fingerprint: \`${result.fingerprint}\``,
    `- Previous snapshot: ${result.previousTimestamp ?? 'none'}`,
    `- Bucket size: ${formatBytes(result.bucketBytes)}`,
    ...(result.status === 'snapshot' ? [`- Written this run: ${formatBytes(result.writtenBytes)} (${result.storedAssets} assets, ${result.storedMux} Mux originals)`] : []),
    ...(result.plan ? [`- Dry run: would write ${result.plan.writes.length} objects`] : []),
    ...result.warnings.map((warning) => `- Warning: ${warning}`),
  ].join('\n')
  await writeStepSummary(summary)

  if (result.status === 'snapshot' && result.warnings.length > 0) {
    log.error(`Snapshot ${result.timestamp} was written, but with ${result.warnings.length} warning(s); see above and the manifest`)
    process.exitCode = 3
  }
}

main().catch((error) => {
  const log = createLogger()
  if (error instanceof UsageError) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  log.error(error instanceof BucketTooLargeError ? error.message : error.stack ?? String(error))
  process.exitCode = 1
})
