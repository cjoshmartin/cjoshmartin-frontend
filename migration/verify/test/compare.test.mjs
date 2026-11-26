import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SETTINGS_VERSION } from '../../../studio/functions/video-to-mp4/settings.ts'
import { compareRecord, EXPECTED, SAME, UNEXPECTED } from '../src/compare.mjs'
import { forbiddenInHtml, forbiddenRequest } from '../src/forbidden.mjs'

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
  dataset: 'production',
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

const MP4_URL = (n) => `https://cdn.sanity.io/files/j3vdh6ti/production/${String(n).repeat(40).slice(0, 40)}.mp4`

/** A contract v2 block whose MP4 is served from the given URL. */
function videoBlock(n, originalFilename) {
  const sha1 = String(n).repeat(40).slice(0, 40)
  return {
    _key: `k${n}`,
    fileRef: `file-${sha1}-mp4`,
    url: MP4_URL(n),
    mimeType: 'video/mp4',
    extension: 'mp4',
    sourceName: 'video-to-mp4',
    sourceId: `file-original${n}-mov`,
    originalRef: `file-original${n}-mov`,
    originalFilename,
    originalSourceUrl: `https://storage.googleapis.com/images-for-cms/media/${originalFilename}`,
    status: 'ready',
    sourceAssetId: `file-original${n}-mov`,
    outputAssetId: `file-${sha1}-mp4`,
    settingsVersion: SETTINGS_VERSION,
  }
}

const oldVideo = (name, height = 550) => ({
  src: `https://storage.googleapis.com/images-for-cms/media/${name}`,
  sources: [],
  fallbackLinks: [],
  autoplay: true,
  muted: true,
  loop: true,
  playsInline: true,
  controls: true,
  preload: null,
  width: 253,
  height,
  videoWidth: 1004,
  videoHeight: 2176,
  readyState: 4,
  error: null,
})

const newVideo = (n, height = 550, overrides = {}) => ({
  ...oldVideo('x', height),
  src: MP4_URL(n),
  sources: [{ src: MP4_URL(n), type: 'video/mp4' }],
  fallbackLinks: [MP4_URL(n)],
  preload: 'metadata',
  videoWidth: 884,
  videoHeight: 1920,
  ...overrides,
})

function videoRecord(oldVideos, newVideos, { oldHeight = 3000, newHeight = 3000 } = {}) {
  return {
    route: { path: '/projects/p', kind: 'page' },
    sites: { old: site(extract({ videos: oldVideos, pageHeight: oldHeight })), new: site(extract({ videos: newVideos, pageHeight: newHeight })) },
  }
}

test('MP4 videos of contract v2 with the same originals in the same order are EXPECTED', () => {
  const doc = { path: '/projects/p', videos: [videoBlock(1, 'IMG_1.MOV'), videoBlock(2, 'step count.mp4')] }
  const record = videoRecord([oldVideo('IMG_1.MOV'), oldVideo('step%20count.mp4', 300)], [newVideo(1), newVideo(2, 301)], { newHeight: 3001 })
  const result = compareRecord(record, reference([doc]), new Map())
  assert.equal(field(result, 'video count').verdict, SAME)
  assert.equal(field(result, 'video count = Sanity video blocks').verdict, SAME)
  assert.equal(field(result, 'video attributes').verdict, SAME)
  assert.equal(field(result, 'video autoplay attribute').verdict, SAME)
  assert.equal(field(result, 'video files (contract v2)').verdict, SAME)
  assert.equal(field(result, 'video order (old file = Sanity original)').verdict, SAME)
  assert.equal(field(result, 'video sources').verdict, EXPECTED)
  assert.equal(field(result, 'video sizes').verdict, EXPECTED)
  assert.equal(field(result, 'forbidden hosts (Mux, images-for-cms)').verdict, SAME)
})

test('a missing, reordered, untyped or unconverted video is UNEXPECTED', () => {
  const blocks = [videoBlock(1, 'a.mov'), videoBlock(2, 'b.mov')]
  const run = (oldVideos, newVideos, docBlocks = blocks) =>
    compareRecord(videoRecord(oldVideos, newVideos), reference([{ path: '/projects/p', videos: docBlocks }]), new Map())

  // One video fewer than the old page: no exceptions any more.
  let result = run([oldVideo('a.mov'), oldVideo('b.mov')], [newVideo(1)])
  assert.equal(field(result, 'video count').verdict, UNEXPECTED)
  assert.equal(field(result, 'video count = Sanity video blocks').verdict, UNEXPECTED)

  // The old page showed the files in another order.
  result = run([oldVideo('b.mov'), oldVideo('a.mov')], [newVideo(1), newVideo(2)])
  assert.equal(field(result, 'video order (old file = Sanity original)').verdict, UNEXPECTED)

  // <source> without type="video/mp4".
  result = run([oldVideo('a.mov'), oldVideo('b.mov')], [newVideo(1), newVideo(2, 550, { sources: [{ src: MP4_URL(2), type: null }] })])
  assert.equal(field(result, 'video files (contract v2)').verdict, UNEXPECTED)
  assert.equal(field(result, 'video sources').verdict, UNEXPECTED)

  // A block whose file still needs conversion (file != outputAssetId).
  const pending = { ...videoBlock(2, 'b.mov'), status: 'processing', outputAssetId: undefined }
  result = run([oldVideo('a.mov'), oldVideo('b.mov')], [newVideo(1), newVideo(2)], [blocks[0], pending])
  assert.match(JSON.stringify(field(result, 'video files (contract v2)').new), /conversion status processing/)

  // Missing autoplay attribute.
  result = run([oldVideo('a.mov'), oldVideo('b.mov')], [newVideo(1), newVideo(2, 550, { autoplay: false })])
  assert.equal(field(result, 'video attributes').verdict, UNEXPECTED)
  assert.equal(field(result, 'video autoplay attribute').verdict, UNEXPECTED)

  // A video box that differs by more than the rounding tolerance.
  result = run([oldVideo('a.mov'), oldVideo('b.mov')], [newVideo(1), newVideo(2, 540)])
  assert.equal(field(result, 'video sizes').verdict, UNEXPECTED)
})

test('page height differences are explained by video boxes only within the rounding tolerance', () => {
  const doc = { path: '/projects/p', videos: [videoBlock(1, 'a.mov'), videoBlock(2, 'b.mov'), videoBlock(3, 'c.mov')] }
  const oldVideos = [oldVideo('a.mov', 450), oldVideo('b.mov', 450), oldVideo('c.mov', 450)]
  const explained = compareRecord(videoRecord(oldVideos, [newVideo(1, 452), newVideo(2, 452), newVideo(3, 452)], { newHeight: 3006 }), reference([doc]), new Map())
  assert.equal(field(explained, 'desktop page height').verdict, EXPECTED)
  assert.equal(field(explained, 'desktop page height').videoDelta, 6)
  const unexplained = compareRecord(videoRecord(oldVideos, [newVideo(1, 450), newVideo(2, 450), newVideo(3, 450)], { newHeight: 3020 }), reference([doc]), new Map())
  assert.equal(field(unexplained, 'desktop page height').verdict, UNEXPECTED)
})

test('a request to Mux or the old bucket, or either in the HTML, is UNEXPECTED on any route', () => {
  const log = emptyLog()
  log.requestHosts = { 'localhost:3000': 10, 'stream.mux.com': 1 }
  log.forbiddenRequests = [{ url: 'https://stream.mux.com/abc.m3u8', type: 'xhr', reason: 'Mux host' }]
  const record = { route: { path: '/blog/a', kind: 'page' }, sites: { old: site(extract()), new: site(extract(), { log }) } }
  assert.equal(field(compareRecord(record, reference(), new Map()), 'forbidden hosts (Mux, images-for-cms)').verdict, UNEXPECTED)

  const html = site(extract())
  html.http.chain = [{ url: 'http://localhost:3000/blog/a', forbiddenInBody: forbiddenInHtml('<a href="https://storage.googleapis.com/images-for-cms/documents/cv.pdf">') }]
  const result = compareRecord({ route: { path: '/blog/a', kind: 'page' }, sites: { old: site(extract()), new: html } }, reference(), new Map())
  assert.equal(field(result, 'forbidden hosts (Mux, images-for-cms)').verdict, UNEXPECTED)
})

test('forbiddenRequest matches Mux, Mux Data and the old bucket only', () => {
  assert.equal(forbiddenRequest('https://stream.mux.com/x.m3u8'), 'Mux host')
  assert.equal(forbiddenRequest('https://image.mux.com/x/thumbnail.jpg'), 'Mux host')
  assert.equal(forbiddenRequest('https://inferred.litix.io/'), 'Mux Data host')
  assert.equal(forbiddenRequest('https://storage.googleapis.com/images-for-cms/media/a.mov'), 'old Wagtail bucket')
  assert.equal(forbiddenRequest('https://images-for-cms.storage.googleapis.com/media/a.mov'), 'old Wagtail bucket')
  assert.equal(forbiddenRequest('https://storage.googleapis.com/other-bucket/a.mov'), null)
  assert.equal(forbiddenRequest('https://cdn.sanity.io/files/j3vdh6ti/production/a.mp4'), null)
  assert.equal(forbiddenRequest('https://notmux.com/'), null)
  assert.equal(forbiddenRequest('blob:http://localhost:3000/x'), null)
  assert.equal(forbiddenRequest('data:text/plain,mux.com'), null)
  assert.deepEqual(forbiddenInHtml('<video src="https://cdn.sanity.io/files/j3vdh6ti/production/a.mp4">'), [])
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
  assert.equal(field(result, 'desktop failed requests (site, Sanity)').verdict, SAME)
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
