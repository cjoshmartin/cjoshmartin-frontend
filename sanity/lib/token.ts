import 'server-only'

/**
 * Viewer-role token. It lets `sanityFetch` read drafts in Draft Mode, lets the Draft Mode route
 * validate the Presentation tool's preview secret, and is handed to the browser by `<SanityLive>`
 * only while Draft Mode is enabled. Never import this from a Client Component.
 */
export const token = process.env.SANITY_API_READ_TOKEN

if (!token) {
  throw new Error('Missing environment variable: SANITY_API_READ_TOKEN')
}
