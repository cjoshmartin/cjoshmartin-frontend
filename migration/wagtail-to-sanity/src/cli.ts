/**
 * Runs the Wagtail -> Sanity migration.
 *
 *   npm run migrate -- --dataset staging
 *
 * Steps, in order (all of them unless --steps is given):
 *   extract    unzip + verify the export, mirror the bucket, hash and reconcile files
 *   assets     upload every image, document and video thumbnail to the dataset (content-addressed,
 *              so reruns reuse); refuses before writing if asset metadata changed since its last
 *              run (state/assets-<dataset>.json)
 *   convert    convert every Wagtail video to MP4 with studio/functions/video-to-mp4/settings.ts
 *              and check each output (video-mp4/, state/video-mp4.json); reruns reuse unchanged
 *              MP4s
 *   videos     upload each video's original and its MP4 as file assets (the MP4 with source
 *              video-to-mp4, reusing an existing conversion of the original); same metadata
 *              check as assets (state/videos-<dataset>.json)
 *   ascii      generate testimonial ASCII art from the uploaded photos (WP2 generator)
 *   transform  build every Sanity document and write NDJSON to transformed/<dataset>/
 *   import     refuse if migration documents changed in the dataset since the last import
 *              (state/imported-<dataset>.json), validate the NDJSON with the Studio schema,
 *              import it with --replace, prune documents a previous run created that the
 *              transform no longer produces (including the mux.videoAsset documents of
 *              earlier runs), record what is now in the dataset
 *   prune-mp4s delete the MP4s of the Wagtail videos made with other settings than the current
 *              SETTINGS_VERSION, once nothing references them (after a settings change)
 *   validate   counts, references, Portable Text integrity, hashes, videos (contract v2, no
 *              Mux left), text parity and `sanity documents validate`; writes
 *              reports/validation-<dataset>.json
 *
 * Steps that only run when named in --steps:
 *   baseline   record an untouched dataset that was imported before imports kept a record
 *
 * Every step is deterministic and rerunnable; rerunning the whole pipeline converges to the
 * same dataset content.
 *
 * When the run includes `import`, its Studio-edit check also runs before the first step, so a run
 * that the import would refuse stops before any step writes to the dataset. The import checks
 * again, because the dataset can change while the run is in progress.
 *
 * Options:
 *   --dataset <staging|production>   required
 *   --confirm-production             required together with --dataset production
 *   --steps a,b,c                    run only these steps (each still reads the state of the
 *                                    steps before it from state/)
 *   --no-gcs-sync                    reuse the local bucket mirror instead of running gsutil
 *   --discard-studio-edits           let the import overwrite or delete migration documents
 *                                    that changed in the dataset since the last import, and the
 *                                    assets and videos steps overwrite asset metadata that changed
 *                                    since their last run (all refuse otherwise and list them)
 *   --data-dir <path>                migration data folder (default ~/cjoshmartin-migration)
 */
import {parseArgs} from 'node:util'

import {DATASETS, dataPaths, loadSecrets, type Dataset} from './config'
import {log} from './util'

const STEPS = ['extract', 'assets', 'convert', 'videos', 'ascii', 'transform', 'import', 'prune-mp4s', 'validate'] as const
/** Steps that never run by default; their position in this list is their order in a run. */
const EXTRA_STEPS = ['baseline'] as const
const ALL_STEPS = ['baseline', ...STEPS] as const
type Step = (typeof ALL_STEPS)[number]

async function main(): Promise<void> {
  const {values} = parseArgs({
    options: {
      dataset: {type: 'string'},
      'confirm-production': {type: 'boolean', default: false},
      steps: {type: 'string'},
      'no-gcs-sync': {type: 'boolean', default: false},
      'discard-studio-edits': {type: 'boolean', default: false},
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
        if (!(ALL_STEPS as readonly string[]).includes(step)) {
          throw new Error(`Unknown step "${s}". Steps: ${STEPS.join(', ')}; only with --steps: ${EXTRA_STEPS.join(', ')}`)
        }
        return step
      })
    : [...STEPS]
  const paths = dataPaths(values['data-dir'])
  const target = dataset as Dataset

  log(`migrate: dataset ${target}, steps ${steps.join(', ')}`)
  if (steps.includes('import')) {
    const [{checkForStudioEdits}, {sanityClient}] = await Promise.all([import('./steps/import'), import('./sanity')])
    log('migrate: checking for Studio edits before any step writes')
    await checkForStudioEdits(paths, target, sanityClient(target, loadSecrets(paths)), {
      discardStudioEdits: values['discard-studio-edits'],
    })
  }
  for (const step of ALL_STEPS) {
    if (!steps.includes(step)) continue
    const started = Date.now()
    switch (step) {
      case 'baseline': {
        const {recordBaseline} = await import('./steps/baseline')
        await recordBaseline(paths, target, loadSecrets(paths))
        break
      }
      case 'extract': {
        const {extract} = await import('./steps/extract')
        await extract(paths, {syncGcs: !values['no-gcs-sync']})
        break
      }
      case 'assets': {
        const {uploadAssets} = await import('./steps/assets')
        await uploadAssets(paths, target, loadSecrets(paths), {
          discardStudioEdits: values['discard-studio-edits'],
        })
        break
      }
      case 'convert': {
        const {convertVideos} = await import('./steps/convert')
        await convertVideos(paths)
        break
      }
      case 'videos': {
        const {uploadVideos} = await import('./steps/videos')
        await uploadVideos(paths, target, loadSecrets(paths), {
          discardStudioEdits: values['discard-studio-edits'],
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
        await importDataset(paths, target, loadSecrets(paths), {
          discardStudioEdits: values['discard-studio-edits'],
        })
        break
      }
      case 'prune-mp4s': {
        const {pruneStaleMp4s} = await import('./steps/prune-mp4s')
        await pruneStaleMp4s(paths, target, loadSecrets(paths))
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
