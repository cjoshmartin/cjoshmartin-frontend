import { draftMode } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Turns Draft Mode off and returns to the page the editor was on. `redirect` must be a path on
 * this site; anything else (including `//host` and `/\host`, which browsers treat as another host)
 * falls back to the home page.
 */
function isSitePath(value: string | null): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'))
}

async function disableDraftMode(request: NextRequest) {
  ;(await draftMode()).disable()

  const requested = request.nextUrl.searchParams.get('redirect')
  const path = isSitePath(requested) ? requested : '/'

  // 303 so a POST from the exit-preview form is followed by a GET.
  return NextResponse.redirect(new URL(path, request.url), 303)
}

export const GET = disableDraftMode
export const POST = disableDraftMode
