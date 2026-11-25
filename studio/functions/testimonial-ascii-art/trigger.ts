/**
 * When the testimonial-ascii-art Function runs, what it receives, and what it does.
 *
 * The filter and projection are used by ../../sanity.blueprint.ts, and the same decision is
 * made again in code (planAsciiArtUpdate) so the handler never relies on the event filter alone.
 * test/trigger.test.ts evaluates the filter with groq-js against the same cases as the planner.
 *
 * Recursion guard: the Function only matches documents whose generated fields are out of date.
 * Its own patch makes asciiArtSource equal to the image asset id (or unsets both fields when
 * there is no image), so the update event caused by that patch no longer matches. If the image
 * changed again while art was being generated, the stale patch still records which asset the
 * art came from, the filter matches again and the next run catches up.
 */

/** Datasets the Function writes to. */
export const TESTIMONIAL_ASCII_ART_DATASETS = ['production', 'staging'] as const

/**
 * GROQ filter body (no `*[...]`) for the Function's create and update events:
 * - the image has an asset and the stored art is missing or was generated from another asset, or
 * - there is no image asset but generated fields are still set.
 */
export const TESTIMONIAL_ASCII_ART_FILTER = [
  '_type == "testimonial"',
  `sanity::dataset() in [${TESTIMONIAL_ASCII_ART_DATASETS.map((d) => `"${d}"`).join(', ')}]`,
  '(' +
    '(defined(image.asset._ref) && (!defined(asciiArtSource) || asciiArtSource != image.asset._ref || !defined(asciiArt)))' +
    ' || ' +
    '(!defined(image.asset._ref) && (defined(asciiArt) || defined(asciiArtSource)))' +
    ')',
].join(' && ')

/** Projection for event.data, so the handler never has to fetch the document. */
export const TESTIMONIAL_ASCII_ART_PROJECTION =
  '{_id, _type, "imageAssetId": image.asset._ref, asciiArtSource, "hasAsciiArt": defined(asciiArt)}'

/** Shape of event.data produced by TESTIMONIAL_ASCII_ART_PROJECTION (missing fields are null). */
export interface TestimonialArtEventData {
  _id: string
  _type: string
  imageAssetId: string | null
  asciiArtSource: string | null
  hasAsciiArt: boolean
}

export type AsciiArtPlan =
  {action: 'generate'; assetId: string} | {action: 'clear'} | {action: 'none'; reason: string}

/** Decides what the Function does for one event. Mirrors TESTIMONIAL_ASCII_ART_FILTER. */
export function planAsciiArtUpdate(data: TestimonialArtEventData): AsciiArtPlan {
  if (data._type !== 'testimonial')
    return {action: 'none', reason: `not a testimonial (${data._type})`}
  const assetId =
    typeof data.imageAssetId === 'string' && data.imageAssetId !== '' ? data.imageAssetId : null
  const source = data.asciiArtSource ?? null
  if (assetId !== null) {
    if (source === assetId && data.hasAsciiArt) {
      return {action: 'none', reason: `asciiArt is already generated from ${assetId}`}
    }
    return {action: 'generate', assetId}
  }
  if (data.hasAsciiArt || source !== null) return {action: 'clear'}
  return {action: 'none', reason: 'no image and no generated fields'}
}
