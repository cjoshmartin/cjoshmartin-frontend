/**
 * Pure helpers used by schema validation rules. They have no Studio dependencies, so they also
 * run inside `sanity documents validate`.
 */

/** Lowercase words separated by single hyphens, the format every Wagtail slug already uses. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function validateSlugFormat(slug: {current?: string} | undefined): true | string {
  const current = slug?.current
  if (!current) return true
  return SLUG_PATTERN.test(current)
    ? true
    : 'Use lowercase letters, numbers and single hyphens only (for example "my-first-post")'
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

/** Path prefixes on youtube.com whose next segment is the video id. */
const YOUTUBE_ID_PATH_PREFIXES = ['embed', 'live', 'shorts', 'v']

/**
 * Returns the 11-character YouTube video id from any of the URL shapes YouTube uses
 * (watch?v=, youtu.be/, /embed/, /live/, /shorts/, /v/), or null when the URL is not a
 * YouTube video URL.
 */
export function getYouTubeVideoId(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  let id: string | null = null

  if (host === 'youtu.be') {
    id = segments[0] ?? null
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') {
      id = url.searchParams.get('v')
    } else if (segments.length >= 2 && YOUTUBE_ID_PATH_PREFIXES.includes(segments[0])) {
      id = segments[1]
    }
  }

  return id && YOUTUBE_ID_PATTERN.test(id) ? id : null
}

export function validateYouTubeUrl(value: string | undefined): true | string {
  if (!value) return true
  return getYouTubeVideoId(value)
    ? true
    : 'Enter a YouTube video URL (youtube.com/watch?v=…, youtu.be/…, youtube.com/live/… or youtube.com/shorts/…)'
}

/** A site-relative path such as "/blog/old-slug" (no scheme, no host, no spaces). */
export function validateSitePath(value: string | undefined): true | string {
  if (!value) return true
  if (!value.startsWith('/')) return 'Must start with "/"'
  if (value.startsWith('//')) return 'Must be a path on this site, not a protocol-relative URL'
  if (/\s/.test(value)) return 'Must not contain spaces'
  return true
}

/** A site-relative path ("/projects") or an absolute http(s) URL ("https://example.com"). */
export function validatePathOrAbsoluteUrl(value: string | undefined): true | string {
  if (!value) return true
  if (value.startsWith('/')) return validateSitePath(value)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Enter a path starting with "/" or an absolute URL starting with https://'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Absolute URLs must use http or https'
  }
  return true
}

/**
 * Sanity file asset ids have the form `file-<sha1>-<extension>`, so the extension of the uploaded
 * file can be read from the reference without fetching the asset document.
 */
export function fileAssetExtension(assetRef: string): string | null {
  const match = /^file-[a-f0-9]+-([a-z0-9]+)$/i.exec(assetRef)
  return match ? match[1].toLowerCase() : null
}
