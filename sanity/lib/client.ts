import { createClient } from 'next-sanity'

import { apiVersion, dataset, projectId, studioUrl } from '@/sanity/env'

/**
 * Read-only client for published content. `sanityFetch` (sanity/lib/live.ts) switches it to drafts,
 * adds the viewer token and turns on stega encoding when Draft Mode is enabled.
 *
 * The Studio has one workspace per dataset, named after the dataset (`/production`, `/staging`),
 * so Visual Editing overlays open the workspace that matches the dataset this site reads.
 */
export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
  perspective: 'published',
  stega: {
    studioUrl: `${studioUrl}/${dataset}`,
  },
})
