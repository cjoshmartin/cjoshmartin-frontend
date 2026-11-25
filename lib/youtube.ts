/*
 * YouTube URL parsing for `youtube` blocks. The id rules match the Studio's validation
 * (studio/schemaTypes/shared/validation.ts), which only accepts URLs these functions understand.
 * The Next.js app does not import from studio/, so the rules are repeated here.
 */

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

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/** The 11-character video id, or null when the URL is not a YouTube video URL. */
export function getYouTubeVideoId(value: string): string | null {
  const url = parseUrl(value)
  if (!url) return null

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

/**
 * Start offset in seconds from `t` or `start` (`555`, `555s`, `9m15s`, `1h2m3s`), or null.
 * YouTube's oEmbed, which the old site used, turned `t=555` into `start=555` the same way.
 */
export function getYouTubeStartSeconds(value: string): number | null {
  const url = parseUrl(value)
  const raw = url?.searchParams.get('t') ?? url?.searchParams.get('start')
  if (!raw) return null

  if (/^\d+s?$/.test(raw)) {
    return Number.parseInt(raw, 10)
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw)
  if (!match || match[0] === '') return null
  const [, hours, minutes, seconds] = match
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
}

/** Embed URL in the same form the old oEmbed markup used: /embed/<id>?start=<s>&feature=oembed. */
export function getYouTubeEmbedUrl(value: string): string | null {
  const id = getYouTubeVideoId(value)
  if (!id) return null
  const start = getYouTubeStartSeconds(value)
  const query = start ? `start=${start}&feature=oembed` : 'feature=oembed'
  return `https://www.youtube.com/embed/${id}?${query}`
}
