// The route list: every live page in the Wagtail export, the listing and utility routes, and the
// redirects. Each route has a `kind` that decides how it is compared.
import { EXPORT_JSON, readJson } from './config.mjs'

/** Where each live Wagtail page type is served on the frontend. */
const PAGE_PATHS = {
  'home.HomePage': () => '/',
  'blog.BlogPage': (slug) => `/blog/${slug}`,
  'blog.ProjectPage': (slug) => `/projects/${slug}`,
  'flex.FlexPage': (slug) => `/flex/${slug}`,
}

/** The live pages of the export, as frontend routes, in Wagtail tree order. */
export function livePageRoutes(exportJson = readJson(EXPORT_JSON)) {
  const routes = []
  for (const page of exportJson.pages) {
    if (!page.live || page.type === 'wagtailcore.Page') continue
    const toPath = PAGE_PATHS[page.type]
    if (!toPath) throw new Error(`Live page ${page.id} has an unmapped type ${page.type}`)
    const route = { path: toPath(page.slug), kind: 'page', wagtailId: page.id, wagtailType: page.type, title: page.title }
    // The old flex page builds its data URL from the Referer header and crashes without one
    // (plan §7.3 bug 6), so the old site is crawled as if the visitor came from the home page.
    if (page.type === 'flex.FlexPage') route.oldReferer = '/'
    routes.push(route)
  }
  return routes
}

/** Wagtail redirect objects (old_path → page), which the new site serves as Sanity redirects. */
export function wagtailRedirectRoutes(exportJson = readJson(EXPORT_JSON)) {
  return exportJson.redirects.map((redirect) => ({
    path: redirect.old_path,
    kind: 'wagtail-redirect',
    redirectPageId: redirect.redirect_page_id,
    permanent: redirect.is_permanent,
  }))
}

/**
 * The full route list.
 * @param {{medium: string, technology: string}} filters one medium and one technology tag title
 *   (taken from the old /projects page, so they are real tags).
 */
export function buildRoutes({ medium, technology }, exportJson = readJson(EXPORT_JSON)) {
  const pages = livePageRoutes(exportJson)
  const expectedCounts = { 'home.HomePage': 1, 'blog.BlogPage': 7, 'blog.ProjectPage': 13, 'flex.FlexPage': 2 }
  for (const [type, count] of Object.entries(expectedCounts)) {
    const actual = pages.filter((route) => route.wagtailType === type).length
    if (actual !== count) throw new Error(`Expected ${count} live ${type} pages in the export, found ${actual}`)
  }
  const search = (key, value) => `/projects?${new URLSearchParams({ [key]: value }).toString()}`
  return [
    ...pages,
    { path: '/blog', kind: 'listing' },
    { path: '/projects', kind: 'listing' },
    { path: '/projects?project_type=CLI', kind: 'listing' },
    { path: '/projects?project_type=PER', kind: 'listing' },
    { path: search('medium', medium), kind: 'listing' },
    { path: search('technologies', technology), kind: 'listing' },
    { path: '/screen', kind: 'static' },
    { path: '/ascii', kind: 'static' },
    { path: '/start-a-project', kind: 'static' },
    { path: '/resume', kind: 'static' },
    { path: '/sitemap.xml', kind: 'sitemap' },
    { path: '/robots.txt', kind: 'robots' },
    { path: '/about', kind: 'redirect' },
    { path: '/portfolio', kind: 'redirect' },
    { path: '/info', kind: 'redirect' },
    { path: '/admin', kind: 'redirect' },
    // Extra checks beyond the brief: plan §7.3 bugs 3 and 5, the printable resume (an HTML page
    // with a "save as PDF" prompt), and the Wagtail redirects.
    { path: '/?utm_source=test', kind: 'page', title: 'Home with a query string (bug 3)', compareWithNew: '/' },
    { path: '/blog/does-not-exist', kind: 'not-found' },
    { path: '/projects/does-not-exist', kind: 'not-found' },
    { path: '/resume/pdf', kind: 'static' },
    ...wagtailRedirectRoutes(exportJson),
  ]
}
