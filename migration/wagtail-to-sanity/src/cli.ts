/**
 * Runs the Wagtail -> Sanity migration.
 *
 *   npm run migrate -- --dataset staging
 *
 * Steps, in order (all of them unless --steps is given):
 *   extract    unzip + verify the export, mirror the bucket, hash and reconcile files
 *   assets     upload every content file to the dataset (content-addressed, so reruns reuse)
 *   mux        create or reuse a Mux asset per Wagtail media item and wait until it is ready
 *   ascii      generate testimonial ASCII art from the uploaded photos (WP2 generator)
 *   transform  build every Sanity document and write NDJSON to transformed/<dataset>/
 *   import     validate the NDJSON with the Studio schema, import it with --replace, prune
 *              documents a previous run created that the transform no longer produces
 *   validate   counts, references, Portable Text integrity, hashes, Mux status, text parity
 *              and `sanity documents validate`; writes reports/validation-<dataset>.json
 *
 * Every step is deterministic and rerunnable; rerunning the whole pipeline converges to the
 * same dataset content.
 *
 * Options:
 *   --dataset <staging|production>   required
 *   --confirm-production             required together with --dataset production
 *   --steps a,b,c                    run only these steps (each still reads the state of the
 *                                    steps before it from state/)
 *   --no-gcs-sync                    reuse the local bucket mirror instead of running gsutil
 *   --allow-pending-videos           staging only: when Mux refuses new assets (free plan limit),
 *                                    record the videos as pending and run the remaining steps;
 *                                    validation still fails until every video is on Mux
 *   --data-dir <path>                migration data folder (default ~/cjoshmartin-migration)
 */
import {parseArgs} from 'node:util'

import {DATASETS, dataPaths, loadSecrets, type Dataset} from './config'
import {log} from './util'

const STEPS = ['extract', 'assets', 'mux', 'ascii', 'transform', 'import', 'validate'] as const
type Step = (typeof STEPS)[number]

async function main(): Promise<void> {
  const {values} = parseArgs({
    options: {
      dataset: {type: 'string'},
      'confirm-production': {type: 'boolean', default: false},
      steps: {type: 'string'},
      'no-gcs-sync': {type: 'boolean', default: false},
      'allow-pending-videos': {type: 'boolean', default: false},
      'data-dir': {type: 'string'},
    },
    strict: true,
    allowPositionals: false,
  })
  const dataset = values.dataset
  if (!dataset || !(DATASETS as readonly string[]).includes(dataset)) {
    throw new Error(`--dataset must be one of ${DATASETS.join(', ')}`)
  }
  if (dataset === 'production' && !values['confirm-production']) {
    throw new Error('Importing into production needs --confirm-production as well')
  }
  const steps: Step[] = values.steps
    ? values.steps.split(',').map((s) => {
        const step = s.trim() as Step
        if (!STEPS.includes(step)) throw new Error(`Unknown step "${s}". Steps: ${STEPS.join(', ')}`)
        return step
      })
    : [...STEPS]
  const paths = dataPaths(values['data-dir'])
  const target = dataset as Dataset

  log(`migrate: dataset ${target}, steps ${steps.join(', ')}`)
  for (const step of STEPS) {
    if (!steps.includes(step)) continue
    const started = Date.now()
    switch (step) {
      case 'extract': {
        const {extract} = await import('./steps/extract')
        await extract(paths, {syncGcs: !values['no-gcs-sync']})
        break
      }
      case 'assets': {
        const {uploadAssets} = await import('./steps/assets')
        await uploadAssets(paths, target, loadSecrets(paths))
        break
      }
      case 'mux': {
        const {migrateVideos} = await import('./steps/mux')
        await migrateVideos(paths, target, loadSecrets(paths), {
          allowPendingVideos: values['allow-pending-videos'],
        })
        break
      }
      case 'ascii': {
        const {generateAsciiArt} = await import('./steps/ascii')
        await generateAsciiArt(paths, target)
        break
      }
      case 'transform': {
        const {transform} = await import('./steps/transform')
        await transform(paths, target)
        break
      }
      case 'import': {
        const {importDataset} = await import('./steps/import')
        await importDataset(paths, target, loadSecrets(paths))
        break
      }
      case 'validate': {
        const {validateDataset} = await import('./steps/validate')
        await validateDataset(paths, target, loadSecrets(paths))
        break
      }
    }
    log(`migrate: ${step} done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  log('migrate: finished')
}

main().catch((error: unknown) => {
  process.stderr.write(`\nmigrate FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
