import { draftMode } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

import { sameOriginRedirect } from '@/lib/sameOriginRedirect'

/**
 * Turns Draft Mode off and returns to the page the editor was on. `redirect` must resolve to a URL
 * on this site; anything else (including `//host`, `/\host` and forms with tabs or newlines, which
 * browsers treat as another host) falls back to the home page.
 */
async function disableDraftMode(request: NextRequest) {
  ;(await draftMode()).disable()

  const target = sameOriginRedirect(
    request.nextUrl.searchParams.get('redirect'),
    request.nextUrl.origin,
  )

  // 303 so a POST from the exit-preview form is followed by a GET.
  return NextResponse.redirect(target, 303)
}

export const GET = disableDraftMode
export const POST = disableDraftMode
