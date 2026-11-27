'use client'

import { useIsPresentationTool } from 'next-sanity/hooks'
import { usePathname } from 'next/navigation'

/**
 * Floating "exit preview" control, shown in Draft Mode when the site is opened directly rather
 * than inside the Studio's Presentation tool (which manages Draft Mode itself). It is a form, not a
 * link, so it is never prefetched (a prefetch would end Draft Mode before the editor clicks).
 */
export function DisableDraftMode() {
  const isPresentationTool = useIsPresentationTool()
  const pathname = usePathname()

  if (isPresentationTool !== false) {
    return null
  }

  return (
    <form
      method="POST"
      action={`/api/draft-mode/disable?redirect=${encodeURIComponent(pathname)}`}
      style={{ position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 50 }}
    >
      <button
        type="submit"
        style={{
          backgroundColor: 'var(--primary-color)',
          color: 'black',
          padding: '0.5rem 1rem',
          border: '2px solid black',
          cursor: 'pointer',
        }}
      >
        Exit preview (Draft Mode)
      </button>
    </form>
  )
}
