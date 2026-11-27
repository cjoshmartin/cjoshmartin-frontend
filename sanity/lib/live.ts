import 'server-only'

import { defineLive } from 'next-sanity/live'

import { client } from '@/sanity/lib/client'
import { token } from '@/sanity/lib/token'

/**
 * Cache tag on every `sanityFetch` result, so the revalidation webhook
 * (app/api/revalidate/route.ts) can expire all cached Sanity data at once.
 */
export const SANITY_CONTENT_TAG = 'sanity-content'

const live = defineLive({
  client,
  serverToken: token,
  browserToken: token,
})

/**
 * `sanityFetch` reads published content (and drafts with stega in Draft Mode). Its results stay in
 * the Next.js Data Cache until a tag of theirs is expired:
 * - their Sanity sync tags, by `<SanityLive>` in the root layout, which listens to the Live Content
 *   API and revalidates within seconds, but only while a browser has the site open;
 * - SANITY_CONTENT_TAG, by the revalidation webhook, for changes made while nobody has the site
 *   open (an editor publishing, the video-to-mp4 Function finishing, a migration run).
 */
export const sanityFetch = ((options: Parameters<typeof live.sanityFetch>[0]) =>
  live.sanityFetch({
    ...options,
    tags: [SANITY_CONTENT_TAG, ...(options.tags ?? [])],
  })) as typeof live.sanityFetch

export const { SanityLive } = live
