/**
 * Sanity Function: removes location and personal metadata from uploads no document uses, which the
 * image-privacy and video-to-mp4 Functions (started by content documents) never see, and deletes
 * the unstripped upload. See trigger.ts for when it runs and orchestrator.ts for what a run does.
 * Images are stripped by the image-privacy Function's own processing, videos by the video-to-mp4
 * Function's stripper (in place for QuickTime/MP4), with the same bundled ffmpeg, and images
 * uploaded as file assets by the image stripper (image-file.ts).
 */
import {randomUUID} from 'node:crypto'

import {createClient} from '@sanity/client'
import {documentEventHandler} from '@sanity/functions'

import {createImageAssetProcessor} from '../image-privacy/orchestrator'
import {privateAssetFetch} from '../privacy/private-fetch'
import {PRIVACY_LINK_KEY_ENV, uploadDigesterFromEnv} from '../privacy/provenance'
import {FFMPEG_LINUX_ARM64_SHA256, ffmpegStaticPath, verifyFfmpegBinary} from '../video-to-mp4/ffmpeg'
import {ConversionFailure, type AssetDocument} from '../video-to-mp4/orchestrator'
import {stripOriginal} from '../video-to-mp4/strip-original'
import {stripImageFile} from './image-file'
import {describeOutcome, runUploadPrivacy, UploadStripFailure} from './orchestrator'
import {createSanityUploadStore} from './sanity'
import {FUNCTION_TIMEOUT_SECONDS, type UploadEventData} from './trigger'

const API_VERSION = '2025-02-19'

/** No new upload is started this close to the Function timeout. */
const DEADLINE_MARGIN_SECONDS = 120

export const handler = documentEventHandler<UploadEventData>(async ({context, event}) => {
  const startedAt = Date.now()
  const runId = randomUUID()
  const log = (message: string) => console.log(`[${runId.slice(0, 8)}] ${message}`)
  const client = createClient({...context.clientOptions, apiVersion: API_VERSION, useCdn: false})
  const deadline = startedAt + (FUNCTION_TIMEOUT_SECONDS - DEADLINE_MARGIN_SECONDS) * 1000
  const store = createSanityUploadStore(client, {deadline})

  if (context.local === true) {
    // `sanity functions test`: report what a deployed run would look at, without writing.
    log(`${event.data.operation} of ${event.data.id} (${event.data.type}); sweep: ${(await store.sweepCandidates([event.data.id])).join(', ') || 'nothing'} (local run, nothing written)`)
    return
  }

  const uploadDigest = uploadDigesterFromEnv()
  if (!uploadDigest) log(`${PRIVACY_LINK_KEY_ENV} is not set: stripped copies are not linked to their uploads`)
  // Uploads are read with their own cache key and the token, never through the plain public URL.
  const assetFetch = privateAssetFetch(client.config().token)
  const {processAsset} = createImageAssetProcessor({store, runId, log, uploadDigest})
  const outcome = await runUploadPrivacy({
    store,
    event: event.data,
    runId,
    deadline,
    log,
    processImage: processAsset,
    async stripVideo(upload) {
      try {
        const ffmpegPath = await verifyFfmpegBinary(await ffmpegStaticPath(), FFMPEG_LINUX_ARM64_SHA256)
        return await stripOriginal(client, upload as unknown as AssetDocument, {
          ffmpegPath,
          deadline: startedAt + (FUNCTION_TIMEOUT_SECONDS - 60) * 1000,
          log,
          fetchImpl: assetFetch,
          uploadDigest,
        })
      } catch (error) {
        if (error instanceof ConversionFailure) throw new UploadStripFailure(error.message)
        throw error
      }
    },
    stripImageFile: (upload) => stripImageFile(client, upload, {deadline, fetchImpl: assetFetch, uploadDigest}),
  })
  log(`${event.data.operation} ${event.data.id}: ${outcome.outcomes.map((o) => `${o.assetId} ${describeOutcome(o)}`).join(' | ') || 'nothing to do'} in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`)
})
