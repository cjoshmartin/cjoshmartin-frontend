import 'server-only'

import { defineLive } from 'next-sanity/live'

import { client } from '@/sanity/lib/client'
import { token } from '@/sanity/lib/token'

/**
 * `sanityFetch` reads published content (and drafts with stega in Draft Mode); `<SanityLive>` in the
 * root layout listens to the Live Content API so published edits show up within seconds.
 */
export const { sanityFetch, SanityLive } = defineLive({
  client,
  serverToken: token,
  browserToken: token,
})
