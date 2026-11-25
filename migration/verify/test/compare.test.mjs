import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareRecord, EXPECTED, SAME, UNEXPECTED } from '../src/compare.mjs'

const FOOTER_OLD = 'Hand made by a clanker and @cjoshmartin , with Django , Next.js and Wagtail (© 2026 )'
const FOOTER_NEW = 'Hand made by a clanker and @cjoshmartin , with Next.js and Sanity (© 2026 )'

function extract(overrides = {}) {
  return {
    url: 'http://x/',
    title: 'T',
    description: 'D',
    ogImage: 'https://images.unsplash.com/a.jpg',
    canonical: 'https://cjoshmartin.com/blog/a',
    robots: null,
    h1: [],
    headings: [{ tag: 'h3', id: 'boom', text: 'BOOM! #' }],
    images: [],
    iframes: [],
    videos: [],
    codeBlocks: [],
    stl: { canvases: 0, loadErrors: 0 },
    internalLinks: ['/', '/blog'],
    externalLinks: [],
    anchorLinks: ['boom'],
    allIds: ['boom'],
    text: `Body text. ${FOOTER_OLD}`,
    testimonials: [],
    pageHeight: 1000,
    horizontalScroll: false,
    ...overrides,
  }
}

const emptyLog = () => ({ consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], badResponses: [] })

function site(desktopExtract, { log = emptyLog(), status = 200, mobileHeight = 2000 } = {}) {
  return {
    http: { firstStatus: status, firstLocation: null, final: { status, url: 'x' }, chain: [] },
    browser: {
      desktop: { status, extract: desktopExtract, log, screenshot: { file: 'a.jpg' } },
      mobile: { status, extract: { pageHeight: mobileHeight, horizontalScroll: false }, log: emptyLog(), screenshot: { file: 'b.jpg' } },
    },
  }
}

const reference = (pages = []) => ({
  pages,
  byPath: new Map(pages.map((page) => [page.path, page])),
  redirects: [],
  testimonials: [],
})

const field = (result, name) => result.checks.find((item) => item.field === name)

test('identical pages apart from the footer credit are EXPECTED', () => {
  const record = {
    route: { path: '/blog/a', kind: 'page' },
    sites: {
      old: site(extract({ externalLinks: ['www.djangoproject.com/', 'wagtail.org/'] })),
      new: site(extract({ text: `Body text. ${FOOTER_NEW}`, externalLinks: ['www.sanity.io/'] })),
    },
  }
  const result = compareRecord(record, reference(), new Map())
  assert.equal(result.verdict, EXPECTED)
  assert.equal(field(result, 'visible text').verdict, EXPECTED)
  assert.equal(field(result, 'external links').verdict, EXPECTED)
  assert.equal(field(result, 'old heading anchors resolve').verdict, SAME)
})

test('changed body text is UNEXPECTED', () => {
  const record = {
    route: { path: '/blog/a', kind: 'page' },
    sites: { old: site(extract()), new: site(extract({ text: `Other text. ${FOOTER_OLD}` })) },
  }
  const result = compareRecord(record, reference(), new Map())
  assert.equal(field(result, 'visible text').verdict, UNEXPECTED)
  assert.equal(result.verdict, UNEXPECTED)
})

test('a lost heading anchor is UNEXPECTED; a #link broken on both sites is only info', () => {
  const record = {
    route: { path: '/blog/a', kind: 'page' },
    sites: {
      old: site(extract({ anchorLinks: ['boom', 'https://example.com/'] })),
      new: site(extract({ headings: [{ tag: 'h3', id: 'boom-2', text: 'BOOM! #' }], allIds: ['boom-2'], anchorLinks: ['boom-2', 'https://example.com/'] })),
    },
  }
  const result = compareRecord(record, reference(), new Map())
  assert.deepEqual(field(result, 'old heading anchors resolve').missing, ['boom'])
  assert.equal(field(result, 'in-page links broken on both sites').verdict, 'info')
})

test('videos missing only for pending Mux assets are EXPECTED', () => {
  const video = { src: 'https://storage.googleapis.com/v.mp4', autoplay: true, muted: true, loop: true, playsInline: true, controls: true }
  const mux = { src: 'blob:http://localhost:3000/x', autoplay: false, muted: true, loop: true, playsInline: true, controls: true }
  const doc = { path: '/projects/p', pendingVideoBlocks: 2, pendingVideoRefs: ['mux-video-11', 'mux-video-12'] }
  const record = {
    route: { path: '/projects/p', kind: 'page' },
    sites: { old: site(extract({ videos: [video, video, video] })), new: site(extract({ videos: [mux] })) },
  }
  const result = compareRecord(record, reference([doc]), new Map())
  assert.equal(field(result, 'video count').verdict, EXPECTED)
  assert.equal(field(result, 'video attributes').verdict, SAME)
  assert.equal(field(result, 'video autoplay attribute').verdict, EXPECTED)
  // One more missing video than pending is not explained.
  record.sites.new = site(extract({ videos: [] }))
  assert.equal(field(compareRecord(record, reference([doc]), new Map()), 'video count').verdict, UNEXPECTED)
})

test('console errors: site errors are UNEXPECTED, third-party and pre-existing ones are info', () => {
  const oldLog = emptyLog()
  oldLog.badResponses.push({ url: 'https://www.cjoshmartin.com/font/a.css', status: 404, type: 'stylesheet' })
  const newLog = emptyLog()
  newLog.consoleErrors.push({ text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', location: 'http://localhost:3000/font/a.css' })
  newLog.badResponses.push({ url: 'http://localhost:3000/font/a.css', status: 404, type: 'stylesheet' })
  newLog.consoleErrors.push({ text: 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED', location: 'https://usermatch.krxd.net/um' })
  const record = {
    route: { path: '/blog/a', kind: 'page' },
    sites: { old: site(extract(), { log: oldLog }), new: site(extract(), { log: newLog }) },
  }
  let result = compareRecord(record, reference(), new Map())
  assert.equal(field(result, 'desktop console errors (site)').verdict, SAME)
  assert.equal(field(result, 'desktop failed requests (site, Sanity, Mux)').verdict, SAME)
  assert.equal(field(result, 'desktop console errors (third-party)').verdict, 'info')
  assert.equal(field(result, 'desktop failed requests (also on old site)').verdict, 'info')

  newLog.pageErrors.push('TypeError: x is undefined')
  result = compareRecord(record, reference(), new Map())
  assert.equal(field(result, 'desktop console errors (site)').verdict, UNEXPECTED)
})

test('flex title and canonical changes are EXPECTED only in their documented form', () => {
  const doc = { path: '/flex/portfolio', title: 'Portfolio' }
  const record = {
    route: { path: '/flex/portfolio', kind: 'page' },
    sites: {
      old: site(extract({ title: "Home - Josh Martin's Website", canonical: 'https://cjoshmartin.com' })),
      new: site(extract({ title: "Portfolio - Josh Martin's Website", canonical: 'https://cjoshmartin.com/flex/portfolio' })),
    },
  }
  let result = compareRecord(record, reference([doc]), new Map())
  assert.equal(field(result, 'title').verdict, EXPECTED)
  assert.equal(field(result, 'canonical').verdict, EXPECTED)
  record.sites.new = site(extract({ title: 'Portfolio', canonical: 'https://cjoshmartin.com/flex/portfolio' }))
  result = compareRecord(record, reference([doc]), new Map())
  assert.equal(field(result, 'title').verdict, UNEXPECTED)
})

function redirectSite({ status, location = null, finalStatus = status, finalUrl = 'http://localhost:3000/blog/add-a-background' }) {
  return { http: { firstStatus: status, firstLocation: location, final: { status: finalStatus, url: finalUrl }, chain: location ? [{}, {}] : [{}] } }
}

test('a Wagtail redirect to a never-published page is EXPECTED to be a plain 404 (draft redirect)', () => {
  const route = { path: '/blog/add-a-background', kind: 'wagtail-redirect', redirectPageId: 17, permanent: true }
  const old = redirectSite({ status: 200, finalUrl: 'https://www.cjoshmartin.com/blog/add-a-background' })
  const draft = compareRecord({ route, sites: { old, new: redirectSite({ status: 404, finalUrl: 'http://localhost:3000/blog/add-a-background' }) } }, reference(), new Map())
  assert.equal(field(draft, 'redirect destination status').verdict, EXPECTED)
  assert.equal(draft.verdict, EXPECTED)

  // Served anyway (the redirect was published while the page was not): still a failure.
  const served = compareRecord(
    { route, sites: { old, new: redirectSite({ status: 308, location: '/blog/unpublished', finalStatus: 404, finalUrl: 'http://localhost:3000/blog/unpublished' }) } },
    { ...reference(), redirects: [{ source: route.path, destination: '/blog/unpublished', permanent: true }] },
    new Map(),
  )
  assert.equal(field(served, 'redirect destination status').verdict, UNEXPECTED)

  // A redirect to a published page must still end on a 200.
  const published = compareRecord(
    { route, sites: { old, new: redirectSite({ status: 404 }) } },
    reference([{ path: '/blog/p', wagtailId: 17 }]),
    new Map(),
  )
  assert.equal(field(published, 'redirect destination status').verdict, UNEXPECTED)
})

test('a link corrected by a migration content fix is EXPECTED only when both halves are seen', () => {
  const route = { path: '/projects/squid-games-nerf-gun', kind: 'page' }
  const oldPage = extract({
    internalLinks: ['/', '/projects/squid-games-nerf-gun#https://pypi.org/project/face-recognition/'],
    externalLinks: ['www.djangoproject.com/', 'wagtail.org/'],
  })
  const fixed = extract({ text: `Body text. ${FOOTER_NEW}`, internalLinks: ['/'], externalLinks: ['pypi.org/project/face-recognition/', 'www.sanity.io/'] })
  const result = compareRecord({ route, sites: { old: site(oldPage), new: site(fixed) } }, reference(), new Map())
  assert.equal(field(result, 'internal links').verdict, EXPECTED)
  assert.equal(field(result, 'external links').verdict, EXPECTED)
  assert.match(field(result, 'internal links').reason, /R1-5/)

  // The in-page link disappeared but nothing replaced it: not explained.
  const dropped = extract({ text: `Body text. ${FOOTER_NEW}`, internalLinks: ['/'], externalLinks: ['www.sanity.io/'] })
  assert.equal(field(compareRecord({ route, sites: { old: site(oldPage), new: site(dropped) } }, reference(), new Map()), 'internal links').verdict, UNEXPECTED)
})

test('resume page height may change only when the old site missed the Charter stylesheet', () => {
  const route = { path: '/resume', kind: 'static' }
  const missing = { ...emptyLog(), badResponses: [{ url: 'https://www.cjoshmartin.com/font/charter-font.css', status: 404, type: 'stylesheet' }] }
  const oldSite = site(extract({ pageHeight: 907 }), { log: missing })
  const newSite = site(extract({ pageHeight: 989 }))
  const result = compareRecord({ route, sites: { old: oldSite, new: newSite } }, reference(), new Map())
  assert.equal(field(result, 'desktop page height').verdict, EXPECTED)
  const bothMissing = compareRecord({ route, sites: { old: oldSite, new: site(extract({ pageHeight: 989 }), { log: missing }) } }, reference(), new Map())
  assert.equal(field(bothMissing, 'desktop page height').verdict, UNEXPECTED)
})
