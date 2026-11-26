/**
 * Sanity Function: replaces every image added to a document that carries location or other
 * personal metadata (GPS, camera make, model and serial numbers, maker notes, authors, dates,
 * XMP, IPTC, comments, thumbnails) with a copy that has none, losslessly (the coded image is not
 * touched; the orientation and ICC profile stay), then deletes the upload. Images without personal
 * metadata are left as they are.
 *
 * Triggered (see ../../sanity.blueprint.ts and ./trigger.ts) on create and update of a document
 * with an image whose asset still needs work, draft or published, in production or staging. See
 * orchestrator.ts for what one run does.
 */
import {randomUUID} from 'node:crypto'

import {createClient} from '@sanity/client'
import {documentEventHandler} from '@sanity/functions'

import {createSanityImageStore} from './sanity'
import {describeOutcome, runImagePrivacy} from './orchestrator'
import {FUNCTION_TIMEOUT_SECONDS, imageAssetIds, type ImageEventData} from './trigger'

const API_VERSION = '2025-02-19'

/** No new image is started this close to the Function timeout. */
const DEADLINE_MARGIN_SECONDS = 60

export const handler = documentEventHandler<ImageEventData>(async ({context, event}) => {
  const startedAt = Date.now()
  const runId = randomUUID()
  const documentId = event.data._id
  const log = (message: string) => console.log(`[${runId.slice(0, 8)}] ${message}`)
  const client = createClient({...context.clientOptions, apiVersion: API_VERSION, useCdn: false})
  const deadline = startedAt + (FUNCTION_TIMEOUT_SECONDS - DEADLINE_MARGIN_SECONDS) * 1000
  const store = createSanityImageStore(client, {deadline})

  if (context.local === true) {
    // `sanity functions test`: report what a deployed run would look at, without writing.
    const doc = await store.getDocument(documentId)
    log(doc ? `${documentId}: images ${imageAssetIds(doc).join(', ') || 'none'} (local run, nothing written)` : `${documentId}: not found`)
    return
  }

  const outcome = await runImagePrivacy({store, documentId, runId, deadline, log})
  const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)} s`
  if (outcome.kind === 'document-missing') log(`${documentId}: no longer exists (published or discarded meanwhile)`)
  else if (outcome.kind === 'nothing-to-do') log(`${documentId}: no image needs work`)
  else log(`${documentId}: ${outcome.assets.map((a) => `${a.assetId} ${describeOutcome(a)}`).join(' | ')} in ${elapsed}`)
})
