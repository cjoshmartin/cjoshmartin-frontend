// Crawls every route on the old (Wagtail-backed) and new (Sanity-backed) site and stores the raw
// observations and screenshots. compare.mjs turns them into the parity report.
//
// Usage: node src/crawl.mjs [--out <dir>] [--only <substring>] [--concurrency <n>]
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { NEW_BASE, OLD_BASE, PARITY_DIR, USER_AGENT, VIEWPORTS, ensureDir, launchBrowser, routeFileName } from './config.mjs'
import { extractPage } from './page-extract.mjs'
import { buildRoutes } from './routes.mjs'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: PARITY_DIR },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
  },
})

const SITES = { old: OLD_BASE, new: NEW_BASE }
const BROWSER_KINDS = new Set(['page', 'listing', 'static', 'not-found'])
const REDIRECT_KINDS = new Set(['redirect', 'wagtail-redirect'])
const outDir = ensureDir(args.out)
const rawDir = ensureDir(path.join(outDir, 'raw'))
const shotDir = ensureDir(path.join(outDir, 'shots'))

/** Follows redirects by hand so every hop (status and Location) is recorded. */
async function httpProbe(url) {
  const chain = []
  let current = url
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetch(current, { redirect: 'manual', headers: { 'user-agent': USER_AGENT } })
    const location = response.headers.get('location')
    const contentType = response.headers.get('content-type') ?? ''
    const entry = { url: current, status: response.status, location, contentType }
    chain.push(entry)
    if (response.status >= 300 && response.status < 400 && location) {
      await response.arrayBuffer()
      current = new URL(location, current).href
      // Stop at the first hop that leaves the site (Studio, Wagtail admin): those are not crawled.
      if (new URL(current).host !== new URL(url).host) {
        chain.push({ url: current, status: null, location: null, contentType: null, offSite: true })
        break
      }
      continue
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    entry.bytes = buffer.length
    if (/text\/(html|plain|xml)|application\/xml/.test(contentType)) {
      const body = buffer.toString('utf8')
      if (/text\/html/.test(contentType)) {
        entry.noindex = /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(body)
      } else {
        entry.body = body
      }
    }
    break
  }
  const last = chain[chain.length - 1]
  return { firstStatus: chain[0].status, firstLocation: chain[0].location, final: last, chain }
}

/** Collects console errors, page errors and failed requests for one page. */
function watch(page) {
  const log = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], badResponses: [] }
  page.on('console', (message) => {
    const entry = { text: message.text().slice(0, 500), location: message.location()?.url ?? '' }
    if (message.type() === 'error') log.consoleErrors.push(entry)
    else if (message.type() === 'warning') log.consoleWarnings.push(entry)
  })
  page.on('pageerror', (error) => log.pageErrors.push(String(error).slice(0, 500)))
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown'
    log.failedRequests.push({ url: request.url().slice(0, 300), type: request.resourceType(), failure })
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      log.badResponses.push({ url: response.url().slice(0, 300), status: response.status(), type: response.request().resourceType() })
    }
  })
  return log
}

/** Scrolls through the page so lazy images, lazy STL viewers and in-view animations run. */
async function settle(page) {
  await page.waitForTimeout(2500)
  // Typing animations (TypeIt on /start-a-project) change the text for several seconds: wait until
  // the visible text has been stable for 2.5 s (at most 30 s).
  await page.evaluate(async () => {
    let last = document.body.innerText
    let stableSince = Date.now()
    const started = Date.now()
    while (Date.now() - stableSince < 2500 && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const now = document.body.innerText
      if (now !== last) {
        last = now
        stableSince = Date.now()
      }
    }
  })
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let i = 0; i < 80; i++) {
      const before = window.scrollY
      window.scrollBy(0, step)
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (window.scrollY === before) break
    }
  })
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(800)
}

/** Loads a page with no Referer header and records what it shows (old flex pages crash). */
async function probeWithoutReferer(browser, url) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: USER_AGENT })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
  const response = await page.goto(url, { waitUntil: 'load', timeout: 90_000 })
  await page.waitForTimeout(4000)
  const h1 = await page.evaluate(() => [...document.querySelectorAll('h1')].map((heading) => heading.textContent.trim()))
  await context.close()
  return { status: response?.status() ?? null, h1, pageErrors }
}

async function screenshot(page, file) {
  try {
    await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 55, animations: 'disabled', timeout: 60_000 })
    return { file: path.relative(outDir, file) }
  } catch (error) {
    return { file: null, error: error.message.split('\n')[0] }
  }
}

async function visitPage(browser, base, route, site) {
  const result = {}
  const referer = site === 'old' && route.oldReferer ? OLD_BASE + route.oldReferer : undefined
  if (referer) result.withoutReferer = await probeWithoutReferer(browser, base + route.path)
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({
      viewport,
      userAgent: USER_AGENT,
      ...(viewportName === 'mobile' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    })
    const page = await context.newPage()
    const log = watch(page)
    const started = Date.now()
    let response
    try {
      response = await page.goto(base + route.path, { waitUntil: 'load', timeout: 90_000, referer })
    } catch (error) {
      result[viewportName] = { error: `navigation failed: ${error.message.split('\n')[0]}`, log }
      await context.close()
      continue
    }
    await settle(page)
    const entry = { status: response?.status() ?? null, loadMs: Date.now() - started, log }
    if (viewportName === 'desktop') {
      entry.extract = await page.evaluate(extractPage)
    } else {
      entry.extract = await page.evaluate(() => ({
        url: location.href,
        pageHeight: document.documentElement.scrollHeight,
        horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
      }))
    }
    entry.screenshot = await screenshot(page, path.join(shotDir, `${routeFileName(route.path)}.${site}.${viewportName}.jpg`))
    result[viewportName] = entry
    await context.close()
  }
  return result
}

/**
 * Follows a redirect route in the browser (server redirects and client-side `redirect()`),
 * recording every main-frame navigation. Off-site documents (Studio, Wagtail admin) are not loaded.
 */
async function visitRedirect(browser, base, route, site) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: USER_AGENT })
  const page = await context.newPage()
  const log = watch(page)
  const navigations = []
  const siteHost = new URL(base).host
  await page.route('**/*', (request) => {
    const url = new URL(request.request().url())
    if (request.request().isNavigationRequest() && request.request().frame() === page.mainFrame()) {
      navigations.push(url.href)
      if (url.host !== siteHost) return request.abort('blockedbyclient')
    }
    return request.continue()
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && navigations[navigations.length - 1] !== frame.url()) navigations.push(frame.url())
  })
  let error = null
  try {
    await page.goto(base + route.path, { waitUntil: 'load', timeout: 60_000 })
  } catch (navigationError) {
    // An aborted off-site navigation is how the redirect target is observed, not a failure.
    if (!/ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/.test(navigationError.message)) error = navigationError.message.split('\n')[0]
  }
  await page.waitForTimeout(5000)
  // Chrome shows chrome-error://chromewebdata/ for the aborted off-site document.
  const real = [...new Set(navigations)].filter((url) => /^https?:/.test(url))
  const firstOffSite = real.find((url) => new URL(url).host !== siteHost) ?? null
  const finalUrl = firstOffSite ?? real[real.length - 1] ?? page.url()
  const onSite = new URL(finalUrl).host === siteHost
  const shot = onSite ? await screenshot(page, path.join(shotDir, `${routeFileName(route.path)}.${site}.desktop.jpg`)) : null
  const title = onSite ? await page.title() : null
  await context.close()
  return { desktop: { navigations: real, firstOffSite, finalUrl, title, error, log, screenshot: shot } }
}

async function crawlRoute(browser, route) {
  const record = { route, crawledAt: new Date().toISOString(), sites: {} }
  await Promise.all(
    Object.entries(SITES).map(async ([site, base]) => {
      const http = await httpProbe(base + route.path)
      let browserResult = null
      if (BROWSER_KINDS.has(route.kind)) browserResult = await visitPage(browser, base, route, site)
      else if (REDIRECT_KINDS.has(route.kind)) browserResult = await visitRedirect(browser, base, route, site)
      record.sites[site] = { base, http, browser: browserResult }
    }),
  )
  fs.writeFileSync(path.join(rawDir, `${routeFileName(route.path)}.json`), JSON.stringify(record, null, 1))
  return record
}

async function pickFilters() {
  const response = await fetch(OLD_BASE + '/projects', { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Old /projects returned ${response.status}`)
  const html = await response.text()
  const first = (key) => {
    const match = html.match(new RegExp(`href="/projects\\?${key}=([^"&]+)"`))
    if (!match) throw new Error(`No ${key} filter link on the old /projects page`)
    return decodeURIComponent(match[1].replace(/\+/g, ' '))
  }
  return { medium: first('medium'), technology: first('technologies') }
}

const filters = await pickFilters()
const allRoutes = buildRoutes(filters)
// routes.json always lists every route; --only re-crawls a subset into the same directory.
fs.writeFileSync(path.join(outDir, 'routes.json'), JSON.stringify({ filters, routes: allRoutes, old: OLD_BASE, new: NEW_BASE }, null, 1))
const routes = args.only ? allRoutes.filter((route) => route.path.includes(args.only)) : allRoutes
console.log(`Crawling ${routes.length} routes (medium filter "${filters.medium}", technology filter "${filters.technology}")`)

const browser = await launchBrowser()
const queue = [...routes]
const failures = []
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    for (let route = queue.shift(); route; route = queue.shift()) {
      try {
        const record = await crawlRoute(browser, route)
        const summary = Object.entries(record.sites)
          .map(([site, data]) => `${site}=${data.http.firstStatus}${data.http.firstLocation ? '→' + data.http.firstLocation : ''}`)
          .join(' ')
        console.log(`${route.path} ${summary}`)
      } catch (error) {
        failures.push({ route: route.path, error: error.stack })
        console.error(`FAILED ${route.path}: ${error.message}`)
      }
    }
  }),
)
await browser.close()
if (failures.length) {
  fs.writeFileSync(path.join(outDir, 'crawl-failures.json'), JSON.stringify(failures, null, 1))
  console.error(`${failures.length} routes failed to crawl`)
  process.exit(1)
}
