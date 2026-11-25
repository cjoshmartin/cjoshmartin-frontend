import { createClient } from '@sanity/client'
import { defineQuery } from 'groq'

import { apiVersion, dataset, projectId } from '@/sanity/env'

/*
 * Used by proxy.ts, before a page renders. It only needs @sanity/client (no next-sanity), and reads
 * published documents from the API CDN without a token.
 */

export const SLUG_EXISTS_QUERY = defineQuery(`
  count(*[_type == $type && slug.current == $slug]) > 0
`)

const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
  perspective: 'published',
})

export type SluggedType = 'blogPost' | 'project' | 'flexPage'

/** Whether a published document of `type` has this slug. */
export async function publishedSlugExists(type: SluggedType, slug: string): Promise<boolean> {
  return client.fetch(SLUG_EXISTS_QUERY, { type, slug })
}
