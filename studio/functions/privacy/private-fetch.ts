/**
 * How the Functions read an asset's bytes from the asset CDN without putting them in its public
 * cache under the asset's guessable URL (privacy review round 2, finding 1).
 *
 * The asset CDN (cdn.sanity.io, Google Cloud CDN) caches a file for up to 30 days
 * (`cache-control: public, max-age=31536000, s-maxage=2592000`), keyed by the full URL, and
 * deleting the asset does not purge it: an unstripped upload a Function had downloaded through its
 * plain URL stayed downloadable there after the Function deleted it. Measured on staging with fresh
 * random assets (docs/sanity-migration/reports/privacy-review.md, round 2): after an anonymous GET
 * of the plain URL and the deletion, the plain URL still answered 200; after a GET with a unique
 * query parameter, or with the Function's token, the plain URL answered 404.
 *
 * So every read adds both: a unique `privacyFetch` parameter (a cache key nobody can guess) and the
 * token (requests with an Authorization header were not cached under the plain URL). The bytes are
 * the same (the callers check size and sha1).
 */
import {randomUUID} from 'node:crypto'

/** Query parameter with a random value on every read, so the read has its own cache key. */
export const PRIVATE_FETCH_PARAM = 'privacyFetch'

/** The asset URL with a unique PRIVATE_FETCH_PARAM (other parameters are kept). */
export function privateAssetUrl(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set(PRIVATE_FETCH_PARAM, randomUUID())
  return parsed.toString()
}

/**
 * A `fetch` for asset bytes: every request goes to privateAssetUrl(url) and carries the token.
 * Range requests and the other options are passed through.
 */
export function privateAssetFetch(token: string | undefined, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetchImpl(privateAssetUrl(url), {...init, headers})
  }
}
