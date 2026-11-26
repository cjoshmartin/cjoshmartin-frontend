// Hosts the Sanity-backed site must never contact. Mux was dropped on 2026-11-26 (every video is an
// MP4 file asset in Sanity), and every Wagtail file was copied out of the old GCS bucket, so a
// request to either means something still points at the old infrastructure.

/** Mux delivery and API hosts (stream.mux.com, image.mux.com, api.mux.com). */
const MUX_HOST = /(^|\.)mux\.com$/

/** Mux Data's beacon host, used by the Mux players. */
const MUX_DATA_HOST = /(^|\.)litix\.io$/

/** The old Wagtail bucket, path style and virtual-hosted style. */
const OLD_BUCKET = 'images-for-cms'

/**
 * Why a request URL is forbidden on the new site, or null when it is allowed. Non-HTTP URLs (data:,
 * blob:, about:) are allowed: they never leave the browser.
 */
export function forbiddenRequest(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  if (MUX_HOST.test(host)) return 'Mux host'
  if (MUX_DATA_HOST.test(host)) return 'Mux Data host'
  if (host === `${OLD_BUCKET}.storage.googleapis.com`) return 'old Wagtail bucket'
  if (host === 'storage.googleapis.com' && parsed.pathname.split('/')[1] === OLD_BUCKET) return 'old Wagtail bucket'
  return null
}

/** Strings that must not appear in the new site's HTML (a URL there would make the browser fetch it). */
export const FORBIDDEN_HTML_PATTERNS = [
  { name: 'Mux host', pattern: /[a-z0-9.-]*\bmux\.com\b/gi },
  { name: 'Mux Data host', pattern: /[a-z0-9.-]*\blitix\.io\b/gi },
  { name: 'old Wagtail bucket', pattern: /storage\.googleapis\.com\/images-for-cms\b|images-for-cms\.storage\.googleapis\.com/gi },
]

/** Every forbidden string in an HTML document, with how often it occurs. */
export function forbiddenInHtml(html) {
  const found = []
  for (const { name, pattern } of FORBIDDEN_HTML_PATTERNS) {
    const matches = html.match(pattern) ?? []
    if (matches.length) found.push({ name, count: matches.length, examples: [...new Set(matches)].slice(0, 5) })
  }
  return found
}
