import { stegaClean } from '@sanity/client/stega'

import { getYouTubeEmbedUrl } from '@/lib/youtube'

/**
 * A YouTube player in the markup Wagtail's oEmbed produced (`.responsive-object` wrapper around a
 * 200x113 iframe); the global `.responsive-object` styles make it full width at 16:9.
 */
export default function YouTubeEmbed({ url }: { url: string | null | undefined }) {
  const cleanUrl = stegaClean(url ?? '')
  const src = getYouTubeEmbedUrl(cleanUrl)

  if (!src) {
    // The Studio only accepts YouTube video URLs, so this only happens while a draft is being
    // edited. Skip the player instead of failing the whole page.
    console.error(`YouTubeEmbed: not a YouTube video URL: ${JSON.stringify(cleanUrl)}`)
    return null
  }

  return (
    <div style={{ paddingBottom: '56.5%' }} className="responsive-object">
      <iframe
        width="200"
        height="113"
        src={src}
        frameBorder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        title="YouTube video player"
      />
    </div>
  )
}
