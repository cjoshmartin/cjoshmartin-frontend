/**
 * Sanity Function: keeps testimonial.asciiArt in sync with testimonial.image.
 *
 * Triggered (see ../../sanity.blueprint.ts and ./trigger.ts) on create and update of a
 * testimonial, published or draft, only when the generated fields are out of date. It renders
 * the photo with the exact ascii-magic port in ./generate.ts and patches `asciiArt` plus
 * `asciiArtSource` (the image asset id the art was made from), or unsets both when the image
 * was removed.
 */
import {ClientError, createClient, type SanityClient} from '@sanity/client'
import {documentEventHandler} from '@sanity/functions'

import {generateAsciiArtForSanityImage, UnsupportedImageError} from './generate'
import {planAsciiArtUpdate, type TestimonialArtEventData} from './trigger'

const API_VERSION = '2025-02-19'

type PatchSpec =
  {set: {asciiArt: string; asciiArtSource: string}} | {unset: ['asciiArt', 'asciiArtSource']}

/**
 * Applies the patch. A draft can be published or discarded while the art is being generated;
 * the patch then fails because the document is gone, which is fine: the published document
 * gets its own event. Any other failure is rethrown so it shows up in the Function logs.
 */
async function applyPatch(
  client: SanityClient,
  id: string,
  spec: PatchSpec,
  dryRun: boolean,
): Promise<boolean> {
  try {
    await client.patch(id, spec).commit({dryRun, autoGenerateArrayKeys: false})
    return true
  } catch (error) {
    if (error instanceof ClientError && (error.statusCode === 404 || error.statusCode === 409)) {
      const current = await client.getDocument(id)
      if (!current) {
        console.log(`${id} no longer exists (published or discarded meanwhile); nothing to patch`)
        return false
      }
    }
    throw error
  }
}

export const handler = documentEventHandler<TestimonialArtEventData>(async ({context, event}) => {
  const data = event.data
  const plan = planAsciiArtUpdate(data)
  if (plan.action === 'none') {
    console.log(`${data._id}: nothing to do (${plan.reason})`)
    return
  }

  const {projectId, dataset} = context.clientOptions
  const client = createClient({...context.clientOptions, apiVersion: API_VERSION, useCdn: false})
  const dryRun = context.local === true

  if (plan.action === 'clear') {
    if (await applyPatch(client, data._id, {unset: ['asciiArt', 'asciiArtSource']}, dryRun)) {
      console.log(
        `${data._id}: image removed, unset asciiArt and asciiArtSource${dryRun ? ' (dry run)' : ''}`,
      )
    }
    return
  }

  let html: string
  let detail: string
  try {
    const result = await generateAsciiArtForSanityImage({projectId, dataset, assetId: plan.assetId})
    html = result.html
    detail = `${result.columns}x${result.rows} from a ${result.fullSize ? 'full-size' : 'CDN pre-scaled'} source`
  } catch (error) {
    if (!(error instanceof UnsupportedImageError)) throw error
    // Same outcome as the Django serializer, which returned "" when an image could not be
    // rendered. Recording the asset id stops the Function from retrying the same asset.
    console.error(
      `${data._id}: ${plan.assetId} cannot be rendered as ASCII art; storing an empty string`,
      error,
    )
    html = ''
    detail = 'empty (unsupported image)'
  }

  if (
    await applyPatch(
      client,
      data._id,
      {set: {asciiArt: html, asciiArtSource: plan.assetId}},
      dryRun,
    )
  ) {
    console.log(
      `${data._id}: asciiArt ${detail}, asciiArtSource ${plan.assetId}${dryRun ? ' (dry run)' : ''}`,
    )
  }
})
