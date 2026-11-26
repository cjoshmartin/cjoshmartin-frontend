import { revalidateTag } from 'next/cache'
import type { NextRequest } from 'next/server'
import { parseBody } from 'next-sanity/webhook'

import { SANITY_CONTENT_TAG } from '@/sanity/lib/live'

/**
 * Target of the Sanity GROQ-powered webhook "Revalidate cjoshmartin.com" (create, update and
 * delete of published documents in the production dataset; see
 * docs/sanity-migration/morning-report.md). `<SanityLive>` only revalidates while a browser has
 * the site open, so a change made while nobody does would otherwise stay invisible until the next
 * deploy. The request must carry a valid `sanity-webhook-signature` for SANITY_REVALIDATE_SECRET.
 * Every cached Sanity fetch is expired at once (SANITY_CONTENT_TAG): the site is small, and a
 * webhook payload does not carry the Live Content API's sync tags.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SANITY_REVALIDATE_SECRET
  if (!secret) {
    return Response.json({ message: 'Missing environment variable SANITY_REVALIDATE_SECRET' }, { status: 500 })
  }
  // Waits a few seconds (Content Lake eventual consistency) once the signature is valid.
  const { isValidSignature, body } = await parseBody<{ _id?: string; _type?: string }>(request, secret)
  if (!isValidSignature) {
    return Response.json({ message: 'Invalid signature' }, { status: 401 })
  }
  // The next request for any page fetches fresh content instead of serving the cached one.
  revalidateTag(SANITY_CONTENT_TAG, { expire: 0 })
  return Response.json({ revalidated: SANITY_CONTENT_TAG, document: body?._id ?? null })
}
