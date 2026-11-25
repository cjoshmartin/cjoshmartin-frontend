/**
 * Resolves a user-supplied `redirect` value to a URL on this site. Anything that would leave the
 * site falls back to the home page.
 *
 * The check runs on the resolved URL, not on the raw string. The WHATWG URL parser strips ASCII tab
 * and newline characters and treats `\` like `/` in special URLs, so a value such as `/\t/evil.com`
 * or `/\evil.com` passes any string-prefix check yet resolves to another host. Comparing origins
 * after resolution covers every such form.
 */
export function sameOriginRedirect(requested: string | null, siteOrigin: string): URL {
  const home = new URL('/', siteOrigin)
  if (!requested || !requested.startsWith('/')) {
    return home
  }

  let target: URL
  try {
    target = new URL(requested, home)
  } catch {
    return home
  }

  return target.origin === home.origin ? target : home
}
