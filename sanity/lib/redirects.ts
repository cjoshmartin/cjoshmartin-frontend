import { createClient } from '@sanity/client'
import { defineQuery } from 'groq'

/*
 * Loaded by next.config.ts while Next.js reads its config, before any app code runs. It therefore
 * uses @sanity/client directly (no next-sanity, no `@/` path alias, no server-only guard) and
 * reads the environment itself.
 */

export const REDIRECTS_QUERY = defineQuery(`
  *[_type == "redirect" && defined(source) && defined(destination)] | order(source asc){
    source,
    destination,
    permanent
  }
`)

export interface SiteRedirect {
  source: string
  destination: string
  permanent: boolean
}

/**
 * path-to-regexp treats these characters as pattern syntax in a redirect `source`. Sanity redirect
 * sources are literal paths, so they are escaped (see the "Regex Path Matching" section of the
 * Next.js redirects docs).
 */
const PATTERN_CHARACTERS = /[(){}:*+?\\]/g

function escapeSourcePath(path: string): string {
  return path.replace(PATTERN_CHARACTERS, (character) => `\\${character}`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing environment variable: ${name} (needed to load redirects from Sanity)`)
  }
  return value
}

/**
 * Every published `redirect` document, in the shape next.config.ts `redirects()` returns. Runs
 * once per build; a failed request fails the build instead of silently dropping redirects.
 */
export async function fetchSanityRedirects(): Promise<SiteRedirect[]> {
  const client = createClient({
    projectId: requireEnv('NEXT_PUBLIC_SANITY_PROJECT_ID'),
    dataset: requireEnv('NEXT_PUBLIC_SANITY_DATASET'),
    apiVersion: '2026-11-01',
    useCdn: false,
    perspective: 'published',
  })

  const documents = await client.fetch(REDIRECTS_QUERY)

  return documents.map(({ source, destination, permanent }) => {
    if (!source || !destination || typeof permanent !== 'boolean') {
      throw new Error(
        `Invalid Sanity redirect (source, destination and permanent are required): ${JSON.stringify({ source, destination, permanent })}`,
      )
    }
    return {
      source: escapeSourcePath(source),
      destination,
      permanent,
    }
  })
}
