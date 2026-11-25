/**
 * Sanity Blueprint: infrastructure deployed with `npx sanity@latest blueprints deploy`
 * (run from this directory; `blueprints plan` first to preview).
 *
 * The project and Stack ids are set here rather than only in the gitignored
 * .sanity/blueprint.config.json, so plan and deploy work from any checkout. They are not
 * secrets. SANITY_PROJECT_ID / SANITY_BLUEPRINT_STACK_ID or CLI flags still take precedence.
 */
import {defineBlueprint, defineDocumentFunction} from '@sanity/blueprints'

import {
  TESTIMONIAL_ASCII_ART_FILTER,
  TESTIMONIAL_ASCII_ART_PROJECTION,
} from './functions/testimonial-ascii-art/trigger'

export default defineBlueprint({
  projectId: 'j3vdh6ti',
  // Stack "cjoshmartin-functions", created with `blueprints init --stack-name cjoshmartin-functions`.
  stackId: 'ST-jc4gwa3c4t',
  resources: [
    defineDocumentFunction({
      name: 'testimonial-ascii-art',
      displayName: 'Testimonial ASCII art',
      // Code and its own package.json live in functions/testimonial-ascii-art (the default src).
      // Fetching and decoding a full-size PNG of a large photo takes a few seconds.
      timeout: 60,
      memory: 1,
      event: {
        on: ['create', 'update'],
        // Only testimonials in production or staging whose asciiArt/asciiArtSource are out of
        // date with image.asset; see functions/testimonial-ascii-art/trigger.ts.
        filter: TESTIMONIAL_ASCII_ART_FILTER,
        projection: TESTIMONIAL_ASCII_ART_PROJECTION,
        // Also regenerate on drafts, so the Studio and the Presentation preview show the new art
        // before publishing. Published documents are always handled too: publishing is an update
        // of the published document, and if its art is stale the filter matches it.
        includeDrafts: true,
      },
    }),
  ],
})
