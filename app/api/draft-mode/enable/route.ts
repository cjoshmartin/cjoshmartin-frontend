import { defineEnableDraftMode } from 'next-sanity/draft-mode'

import { client } from '@/sanity/lib/client'
import { token } from '@/sanity/lib/token'

/**
 * Called by the Studio's Presentation tool (`previewMode.enable` in studio/sanity.config.ts). It
 * checks the preview secret the Studio created against the Content Lake with the viewer token,
 * then turns on Next.js Draft Mode and redirects to the page being previewed. Requests without a
 * valid secret are rejected.
 */
export const { GET } = defineEnableDraftMode({
  client: client.withConfig({ token }),
})
