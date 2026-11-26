/**
 * Sanity Function: converts every video uploaded in the Studio to an MP4 (video contract v2).
 *
 * Triggered (see ../../sanity.blueprint.ts and ./trigger.ts) on create and update of a document
 * with a Portable Text video block that needs conversion, draft or published, in production or
 * staging. One run handles one block (orchestrator.ts): it marks the block `processing`, converts
 * the upload with the fixed settings in settings.ts (or reuses an earlier conversion of the same
 * upload made with the same settings), uploads the MP4, and points `file` at it, keeping the
 * upload in `original`. A video that cannot be converted is recorded as `failed` with a message,
 * with `file` left on the upload; a problem that is not the video's fault is recorded as `pending`
 * and retried after RETRY_DELAY_SECONDS (trigger.ts).
 */
import {randomUUID} from 'node:crypto'

import {createClient} from '@sanity/client'
import {documentEventHandler} from '@sanity/functions'

import {PRIVACY_LINK_KEY_ENV, uploadDigesterFromEnv} from '../privacy/provenance'
import {FFMPEG_LINUX_ARM64_SHA256, ffmpegStaticPath, verifyFfmpegBinary} from './ffmpeg'
import {runVideoToMp4} from './orchestrator'
import {createSanityConverter, createSanityStore} from './sanity'
import {DEFAULT_PRESET} from './settings'
import {FUNCTION_TIMEOUT_SECONDS, nextPendingVideo, type VideoEventData} from './trigger'

const API_VERSION = '2025-02-19'

/**
 * ffmpeg is stopped this long before the Function timeout, so the failure can still be recorded
 * and the lease released instead of the run being killed mid-way.
 */
const DEADLINE_MARGIN_SECONDS = 60

/** libx264 preset. The spike measured `medium` at 54 s for the worst case at 10 GB. */
const PRESET = DEFAULT_PRESET

export const handler = documentEventHandler<VideoEventData>(async ({context, event}) => {
  const startedAt = Date.now()
  const runId = randomUUID()
  const documentId = event.data._id
  const log = (message: string) => console.log(`[${runId.slice(0, 8)}] ${message}`)
  const client = createClient({...context.clientOptions, apiVersion: API_VERSION, useCdn: false})
  const uploadDigest = uploadDigesterFromEnv()
  const store = createSanityStore(client, {uploadDigest})

  if (context.local === true) {
    // `sanity functions test`: report what a deployed run would do, without writing or converting
    // (the local ffmpeg-static binary is not the Lambda build).
    const doc = await store.getDocument(documentId)
    const video = doc ? nextPendingVideo(doc, new Date()) : undefined
    log(
      doc
        ? video
          ? `${documentId}: would convert ${video.block.file?.asset?._ref} in ${video.field}[_key=="${video.key}"] (local run, nothing written)`
          : `${documentId}: no video block needs conversion`
        : `${documentId}: document not found`,
    )
    return
  }

  if (!uploadDigest) log(`${PRIVACY_LINK_KEY_ENV} is not set: stripped copies are not linked to their uploads`)
  const deadline = startedAt + (FUNCTION_TIMEOUT_SECONDS - DEADLINE_MARGIN_SECONDS) * 1000
  const converter = createSanityConverter(client, {
    ffmpeg: async () => verifyFfmpegBinary(await ffmpegStaticPath(), FFMPEG_LINUX_ARM64_SHA256),
    preset: PRESET,
    deadline,
    log,
    uploadDigest,
  })

  const outcome = await runVideoToMp4({store, converter, documentId, runId, log})
  const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)} s`
  switch (outcome.kind) {
    case 'document-missing':
      log(`${documentId}: no longer exists (published or discarded meanwhile); nothing to do`)
      break
    case 'nothing-to-do':
      log(`${documentId}: no video block needs conversion`)
      break
    case 'waiting':
      log(
        `${documentId}: ${outcome.assetId} is being converted by run ${outcome.holder}; marked waiting`,
      )
      break
    case 'no-target':
      log(`${documentId}: no block waits for ${outcome.assetId} any more; nothing converted`)
      break
    case 'done': {
      const {result} = outcome
      const summary =
        result.status === 'ready'
          ? `ready: ${result.fileAssetId} -> ${result.outputAssetId}`
          : result.status === 'restart'
            ? `restart: ${result.fileAssetId} was made with older settings; file set back to ${result.originalAssetId}`
            : result.status === 'retry'
              ? `pending (retried later): ${result.message}`
              : `failed: ${result.message}`
      log(
        `${documentId}: ${summary}; patched ${outcome.patchedDocuments.join(', ') || 'no document'} in ${elapsed}`,
      )
      break
    }
  }
})
