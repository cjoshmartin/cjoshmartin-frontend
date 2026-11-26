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
import {
  FUNCTION_TIMEOUT_SECONDS as VIDEO_TO_MP4_TIMEOUT_SECONDS,
  VIDEO_TO_MP4_FILTER,
  VIDEO_TO_MP4_PROJECTION,
} from './functions/video-to-mp4/trigger'

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
    defineDocumentFunction({
      name: 'video-to-mp4',
      displayName: 'Video to MP4',
      // Code, its own package.json (ffmpeg-static pinned) and tests live in functions/video-to-mp4.
      // DEPLOY WITH npm_config_platform=linux npm_config_arch=arm64 in the environment, or the
      // deploy bundles this machine's ffmpeg and every conversion fails its binary check (see
      // functions/video-to-mp4/README.md).
      // Sizing from docs/sanity-migration/reports/video-spike.md: the work is CPU-bound and CPU
      // grows with memory, so 10 GB costs about the same GB-seconds as 4 GB and is 2.5x faster
      // (worst case 54 s). The timeout is the maximum; ffmpeg is stopped 60 s before it.
      memory: 10,
      timeout: VIDEO_TO_MP4_TIMEOUT_SECONDS,
      runtime: 'nodejs24.x',
      event: {
        on: ['create', 'update'],
        // Only documents in production or staging with a video block whose upload is not yet
        // converted and not already being converted or failed; see functions/video-to-mp4/trigger.ts.
        filter: VIDEO_TO_MP4_FILTER,
        projection: VIDEO_TO_MP4_PROJECTION,
        // Drafts too, so a video is converted while the editor is still writing. A draft published
        // mid-conversion gets its result in the published document (no second conversion).
        includeDrafts: true,
      },
    }),
  ],
})
