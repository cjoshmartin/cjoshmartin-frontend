// Interactive checks on the new site: Mux videos reach the playing state, STL canvases draw a
// moving model, YouTube embeds load a player, testimonial ASCII art renders (same art as Sanity
// and the old site) and the hover/touch reveal works, testimonials rotate, and no console errors.
// The pages to visit come from the crawl data (raw/*.json), so run src/crawl.mjs first.
//
// Usage: node src/interactive.mjs [--dir <parity dir with the crawl>] [--out <dir, default --dir>] [--dataset production]
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { LIVE_SNAPSHOT_DIR, NEW_BASE, OLD_BASE, PARITY_DIR, USER_AGENT, VIEWPORTS, ensureDir, launchBrowser, readJson, routeFileName } from './config.mjs'
import { fetchReference } from './sanity-reference.mjs'

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: PARITY_DIR },
    out: { type: 'string' },
    only: { type: 'string' },
    dataset: { type: 'string', default: 'production' },
  },
})

const outDir = ensureDir(args.out ?? args.dir)
const shotDir = ensureDir(path.join(outDir, 'interactive'))
const routesFile = readJson(path.join(args.dir, 'routes.json'))
const reference = await fetchReference(args.dataset)

/** The old site's testimonial art (live API snapshot of the home page), by full name. */
const oldArt = new Map(
  readJson(path.join(LIVE_SNAPSHOT_DIR, 'page-3.json')).testimonials.map(({ testimonial }) => [
    `${testimonial.first_name} ${testimonial.last_name}`.trim(),
    testimonial.image?.value ?? null,
  ]),
)
const sanityArt = new Map(reference.testimonials.map((testimonial) => [`${testimonial.firstName} ${testimonial.lastName}`.trim(), testimonial.asciiArt]))

// Pick the pages from what the crawl saw on the new site.
const targets = []
for (const route of routesFile.routes) {
  if (!['page', 'listing', 'static'].includes(route.kind)) continue
  if (args.only && !route.path.includes(args.only)) continue
  const record = readJson(path.join(args.dir, 'raw', `${routeFileName(route.path)}.json`))
  const extract = record.sites.new.browser?.desktop?.extract
  if (!extract) continue
  const doc = reference.byPath.get(route.path.split('?')[0])
  const needs = {
    videos: extract.videos.length,
    pendingVideos: doc?.pendingVideoBlocks ?? 0,
    stl: extract.stl.canvases,
    youtube: extract.iframes.filter((frame) => frame.kind === 'youtube').length,
    testimonials: extract.testimonials.length,
    disqus: extract.iframes.some((frame) => frame.kind === 'disqus'),
  }
  if (needs.videos || needs.pendingVideos || needs.stl || needs.youtube || needs.testimonials || needs.disqus) targets.push({ route, needs })
}

/** The Disqus thread parameters a page loads: identifier, URL and title must match the old site. */
async function disqusParams(browser, url) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: USER_AGENT })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 })
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  let src = null
  try {
    const frame = await page.waitForSelector('iframe[src*="disqus.com/embed/comments"]', { state: 'attached', timeout: 25_000 })
    src = await frame.getAttribute('src')
  } catch (error) {
    await context.close()
    return { error: error.message.split('\n')[0] }
  }
  await context.close()
  const params = new URL(src).searchParams
  return { identifier: params.get('t_i'), url: params.get('t_u'), title: params.get('t_t'), forum: params.get('f') }
}

function watch(page) {
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ text: message.text().slice(0, 300), location: message.location()?.url ?? '' })
  })
  page.on('pageerror', (error) => errors.push({ text: `pageerror: ${String(error).slice(0, 300)}`, location: '' }))
  return errors
}

async function checkVideos(page) {
  const count = await page.locator('video').count()
  const results = []
  for (let index = 0; index < count; index++) {
    const video = page.locator('video').nth(index)
    await video.scrollIntoViewIfNeeded()
    const started = Date.now()
    let state
    while (Date.now() - started < 25_000) {
      state = await video.evaluate((element) => ({
        paused: element.paused,
        currentTime: element.currentTime,
        readyState: element.readyState,
        networkState: element.networkState,
        error: element.error ? `${element.error.code} ${element.error.message}` : null,
        src: (element.currentSrc || element.getAttribute('src') || '').slice(0, 120),
        muted: element.muted,
        loop: element.loop,
        playsInline: element.playsInline,
        controls: element.controls,
        width: element.videoWidth,
        height: element.videoHeight,
      }))
      if (!state.paused && state.currentTime > 0.5 && state.readyState >= 3) break
      if (state.error) break
      await page.waitForTimeout(500)
    }
    const playing = !state.paused && state.currentTime > 0.5 && state.readyState >= 3
    results.push({ index, playing, secondsToPlay: playing ? Number(((Date.now() - started) / 1000).toFixed(1)) : null, ...state })
  }
  return results
}

/** Decodes a PNG in the page and measures it: distinct colours and the fraction of non-black pixels. */
async function measurePng(page, buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const colours = new Set()
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
      if (data[i] + data[i + 1] + data[i + 2] > 60) lit++
    }
    return { width: canvas.width, height: canvas.height, colours: colours.size, litFraction: Number((lit / (data.length / 4)).toFixed(4)) }
  }, buffer.toString('base64'))
}

async function checkStl(page, slug) {
  const canvases = page.locator('.App canvas')
  const count = await canvases.count()
  const results = []
  for (let index = 0; index < count; index++) {
    const canvas = canvases.nth(index)
    await canvas.scrollIntoViewIfNeeded()
    await page.waitForTimeout(3000)
    const first = await canvas.screenshot({ type: 'png' })
    await page.waitForTimeout(1500)
    const second = await canvas.screenshot({ type: 'png', path: path.join(shotDir, `${slug}.stl-${index}.png`) })
    const measured = await measurePng(page, second)
    results.push({
      index,
      ...measured,
      // The model rotates every frame (useFrame), so two captures 1.5 s apart must differ.
      animating: !first.equals(second),
      rendered: measured.colours > 8 && measured.litFraction > 0.005,
    })
  }
  return results
}

async function checkYouTube(page) {
  const frames = page.locator('iframe[src*="youtube.com/embed"]')
  const count = await frames.count()
  const results = []
  for (let index = 0; index < count; index++) {
    const element = frames.nth(index)
    await element.scrollIntoViewIfNeeded()
    const src = await element.getAttribute('src')
    const frame = await (await element.elementHandle()).contentFrame()
    if (!frame) {
      results.push({ index, src, loaded: false, error: 'no frame' })
      continue
    }
    let loaded = false
    let error = null
    try {
      await frame.waitForSelector('#movie_player, .html5-video-player', { timeout: 20_000 })
      loaded = true
    } catch (waitError) {
      error = waitError.message.split('\n')[0]
    }
    const info = loaded
      ? await frame.evaluate(() => ({
          title: document.querySelector('.ytp-title-link')?.textContent?.trim() || document.title,
          playerError: document.querySelector('.ytp-error')?.textContent?.trim() || null,
        }))
      : {}
    let played = null
    if (loaded && !info.playerError) {
      // Click the middle of the embed (the play button), the way a visitor starts it.
      await page.waitForTimeout(1500)
      const box = await element.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(6000)
      played = await frame.evaluate(() => {
        const video = document.querySelector('video')
        return video ? { currentTime: Number(video.currentTime.toFixed(2)), paused: video.paused } : null
      })
      // Stop it again so the next embed on the page is not competing with it.
      await frame.evaluate(() => document.querySelector('video')?.pause())
    }
    results.push({ index, src, loaded, error, ...info, played })
  }
  return results
}

/** Reads the shown testimonial's art as [colour, character] pairs, and parses an HTML string the same way. */
async function artCells(page, html) {
  return page.evaluate((source) => {
    const cells = (root) =>
      [...root.querySelectorAll('span[style*="color"]')].map((span) => `${span.style.color}|${span.textContent}`)
    if (source === null) {
      const wrapper = [...document.querySelectorAll('[class*="Testimonial-module"]')].find((element) =>
        [...element.classList].some((name) => /^Testimonial-module__[A-Za-z0-9_-]+__image$/.test(name)),
      )
      return wrapper ? cells(wrapper) : null
    }
    const parsed = new DOMParser().parseFromString(`<div id="art">${source}</div>`, 'text/html')
    return cells(parsed.getElementById('art'))
  }, html)
}

async function testimonialState(page) {
  return page.evaluate(() => {
    const find = (local) =>
      [...document.querySelectorAll('[class*="Testimonial-module"]')].find((element) =>
        [...element.classList].some((name) => new RegExp(`^Testimonial-module__[A-Za-z0-9_-]+__${local}$`).test(name)),
      )
    const art = find('image')
    const wrapper = find('imageWrapper')
    const photo = wrapper?.querySelector('img')
    const photoWrapper = photo?.parentElement
    const container = find('container')
    return {
      name: container?.querySelector('h3')?.textContent?.trim() ?? null,
      artOpacity: art ? Number(getComputedStyle(art).opacity) : null,
      artSpans: art ? art.querySelectorAll('span[style*="color"]').length : 0,
      photoOpacity: photoWrapper ? Number(getComputedStyle(photoWrapper).opacity) : null,
      photoLoaded: photo ? photo.complete && photo.naturalWidth > 0 : false,
      photoHost: photo ? new URL(photo.currentSrc || photo.src).searchParams.get('url')?.split('/')[2] ?? new URL(photo.currentSrc || photo.src).host : null,
      wrapperVisible: wrapper ? wrapper.checkVisibility() : false,
    }
  })
}

async function checkTestimonial(page, { mobile, rotation }) {
  const wrapper = page.locator('[class*="Testimonial-module"][class*="imageWrapper"]').first()
  await wrapper.scrollIntoViewIfNeeded()
  await page.waitForTimeout(600)
  const before = await testimonialState(page)
  const shown = await artCells(page, null)
  const expectedSanity = sanityArt.has(before.name) ? await artCells(page, sanityArt.get(before.name)) : null
  const expectedOld = oldArt.has(before.name) ? await artCells(page, oldArt.get(before.name)) : null
  const same = (a, b) => Boolean(a && b) && a.length === b.length && a.every((cell, index) => cell === b[index])
  if (mobile) await wrapper.dispatchEvent('touchstart')
  else await wrapper.hover()
  await page.waitForTimeout(900)
  const revealed = await testimonialState(page)
  if (mobile) await wrapper.dispatchEvent('touchend')
  else await page.mouse.move(5, 5)
  await page.waitForTimeout(900)
  const after = await testimonialState(page)
  const result = {
    name: before.name,
    artSpans: before.artSpans,
    artMatchesSanity: same(shown, expectedSanity),
    artMatchesOldSite: same(shown, expectedOld),
    before: { artOpacity: before.artOpacity, photoOpacity: before.photoOpacity },
    revealed: { artOpacity: revealed.artOpacity, photoOpacity: revealed.photoOpacity, photoLoaded: revealed.photoLoaded, photoHost: revealed.photoHost },
    after: { artOpacity: after.artOpacity, photoOpacity: after.photoOpacity },
  }
  result.revealWorks = before.artOpacity === 1 && revealed.artOpacity === 0 && revealed.photoOpacity === 1 && revealed.photoLoaded && after.artOpacity === 1
  if (rotation) {
    // The first testimonial is shown for 30 s, then a different one is picked.
    await page.waitForTimeout(32_000)
    const later = await testimonialState(page)
    result.rotation = { first: before.name, after32s: later.name, rotated: Boolean(later.name) && later.name !== before.name, artSpansAfter: later.artSpans }
  }
  return result
}

const browser = await launchBrowser()
const results = []
for (const { route, needs } of targets) {
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    // Videos, STL and YouTube are checked at both widths; the rotation wait only once.
    const context = await browser.newContext({
      viewport,
      userAgent: USER_AGENT,
      ...(viewportName === 'mobile' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    })
    const page = await context.newPage()
    const errors = watch(page)
    const response = await page.goto(NEW_BASE + route.path, { waitUntil: 'load', timeout: 90_000 })
    await page.waitForTimeout(2500)
    const entry = { route: route.path, viewport: viewportName, status: response?.status() ?? null, needs }
    const slug = `${routeFileName(route.path)}.${viewportName}`
    if (needs.testimonials) entry.testimonial = await checkTestimonial(page, { mobile: viewportName === 'mobile', rotation: route.path === '/' && viewportName === 'desktop' })
    if (needs.videos || needs.pendingVideos) entry.videos = await checkVideos(page)
    if (needs.stl) entry.stl = await checkStl(page, slug)
    if (needs.youtube) entry.youtube = await checkYouTube(page)
    if (needs.youtube && viewportName === 'desktop') {
      // The same click on the old site, to tell YouTube's own behaviour in headless Chrome apart
      // from the site's.
      const oldContext = await browser.newContext({ viewport, userAgent: USER_AGENT })
      const oldPage = await oldContext.newPage()
      await oldPage.goto(OLD_BASE + route.path, { waitUntil: 'load', timeout: 90_000 })
      await oldPage.waitForTimeout(2500)
      entry.youtubeOldSite = await checkYouTube(oldPage)
      await oldContext.close()
    }
    if (needs.disqus && viewportName === 'desktop') {
      const [oldThread, newThread] = await Promise.all([disqusParams(browser, OLD_BASE + route.path), disqusParams(browser, NEW_BASE + route.path)])
      entry.disqus = { old: oldThread, new: newThread, same: !oldThread.error && JSON.stringify(oldThread) === JSON.stringify(newThread) }
    }
    entry.consoleErrors = errors
    results.push(entry)
    console.log(JSON.stringify({ route: entry.route, viewport: viewportName, status: entry.status, testimonial: entry.testimonial && { name: entry.testimonial.name, revealWorks: entry.testimonial.revealWorks, matchesSanity: entry.testimonial.artMatchesSanity, matchesOld: entry.testimonial.artMatchesOldSite, rotation: entry.testimonial.rotation }, videos: entry.videos?.map((video) => video.playing), stl: entry.stl?.map((model) => model.rendered && model.animating), youtube: entry.youtube?.map((frame) => `${frame.loaded && !frame.playerError ? 'loaded' : 'NOT LOADED'}/${frame.played?.currentTime > 0 ? 'played' : 'not played'}`), youtubeOldSite: entry.youtubeOldSite?.map((frame) => (frame.played?.currentTime > 0 ? 'played' : 'not played')), disqus: entry.disqus?.same, consoleErrors: errors.length }))
    await context.close()
  }
}
await browser.close()
fs.writeFileSync(path.join(outDir, 'interactive-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: NEW_BASE, results }, null, 1))
