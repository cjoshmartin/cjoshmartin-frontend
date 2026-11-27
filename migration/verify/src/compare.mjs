// Compares the crawled old and new observations route by route and classifies every difference
// as EXPECTED (with the reason and its source in the plan or a work-package note) or UNEXPECTED.
import { CONVERTED_ASSET_SOURCE_NAME, OUTPUT_EXTENSION, OUTPUT_MIME_TYPE, SETTINGS_VERSION } from '../../../studio/functions/video-to-mp4/settings.ts'
import { LINK_HREF_FIXES } from '../../wagtail-to-sanity/src/content-fixes.ts'
import { SANITY_PROJECT_ID } from './config.mjs'
import { compareText } from './text-diff.mjs'

export const SAME = 'same'
export const EXPECTED = 'expected'
export const UNEXPECTED = 'unexpected'
export const INFO = 'info'

/** Infrastructure the new site serves its own content from. Errors there are the site's errors. */
const NEW_INFRA = /(^|\.)sanity\.io$/

/**
 * Largest difference in a rendered video box (px) explained by the MP4's size: the converter scales
 * to at most 1920 px and rounds both sides down to even numbers (settings.ts VIDEO_FILTER), which
 * changes the aspect ratio by under 0.5 %.
 */
const VIDEO_BOX_TOLERANCE = 2

/** The site itself on either deployment, so a path that failed on both can be matched. */
const SITE_HOSTS = new Set(['localhost:3000', 'www.cjoshmartin.com', 'cjoshmartin.com'])

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Removes per-request noise (URLs, numbers, the HTTP status text, which HTTP/2 leaves empty) so the
 * same error on both sites matches.
 */
const normalizeMessage = (text) =>
  text
    .replace(/https?:\/\/[^\s)']+/g, '<url>')
    .replace(/(status of \d+) \([^)]*\)/, '$1')
    .replace(/\d+/g, '#')
    .slice(0, 200)

/** A request URL as host-independent site path, or the full URL for other hosts. */
const requestKey = (url) => {
  try {
    const parsed = new URL(url)
    return SITE_HOSTS.has(parsed.host) ? `site:${parsed.pathname}` : `${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

const countItems = (list) => {
  const counts = new Map()
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

/** Multiset difference: items in a missing from b (with multiplicity). */
function missingFrom(a, b) {
  const counts = countItems(b)
  const missing = []
  for (const item of a) {
    const left = counts.get(item) ?? 0
    if (left > 0) counts.set(item, left - 1)
    else missing.push(item)
  }
  return missing
}

function check(field, verdict, details) {
  return { field, verdict, ...details }
}

/** Compares a field that must be identical. `explain` may return {verdict, reason} for a difference. */
function exact(field, oldValue, newValue, explain) {
  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return check(field, SAME, { old: oldValue, new: newValue })
  const explanation = explain?.(oldValue, newValue)
  if (explanation) return check(field, explanation.verdict ?? EXPECTED, { old: oldValue, new: newValue, reason: explanation.reason })
  return check(field, UNEXPECTED, { old: oldValue, new: newValue })
}

/** Expected-difference rules that depend on the route and the Sanity document behind it. */
function routeRules(route, doc) {
  const flexSlug = route.path.match(/^\/flex\/([^/?#]+)$/)?.[1]
  return {
    title(oldValue, newValue) {
      if (flexSlug && doc && newValue === `${doc.title} - Josh Martin's Website` && oldValue === "Home - Josh Martin's Website") {
        return {
          reason:
            'Flex pages now get their own <title> instead of inheriting the home page metadata (WP4 deviation 4, listed as expected by WP4).',
        }
      }
      return null
    },
    canonical(oldValue, newValue) {
      if (flexSlug && newValue === `https://cjoshmartin.com/flex/${flexSlug}` && oldValue === 'https://cjoshmartin.com') {
        return { reason: 'Flex pages now have their own canonical URL (WP4 deviation 4).' }
      }
      return null
    },
    description(oldValue, newValue) {
      if (doc?.seoDescription && newValue === doc.seoDescription.trim()) {
        return {
          reason: `Plan §7.3 bug 2: the description now comes from seo.description (the Wagtail search_description); the old site used ${oldValue === doc.intro ? 'the intro' : 'another field'}.`,
        }
      }
      return null
    },
    ogImage(oldValue, newValue) {
      if (!oldValue || !newValue || hostOf(oldValue) !== 'storage.googleapis.com') return null
      const url = new URL(newValue)
      const params = url.searchParams
      if (url.host === 'cdn.sanity.io' && params.get('w') === '1200' && params.get('h') === '630' && params.get('fm') === 'jpg') {
        return { reason: 'og:image is a 1200x630 JPEG crop from cdn.sanity.io instead of the GCS original (WP4 deviation 5; images moved to Sanity).' }
      }
      return null
    },
  }
}

/** Maps an old GCS asset URL host to the Sanity CDN, so external link lists compare. */
const normalizeExternal = (link) =>
  link
    .replace(/^storage\.googleapis\.com\/images-for-cms\/(documents|original_images|images|media)\/.*$/, 'migrated-asset')
    .replace(/^cdn\.sanity\.io\/(files|images)\/j3vdh6ti\/production\/.*$/, 'migrated-asset')

function compareConsole(oldLog, newLog, route) {
  const results = []
  const oldMessages = new Set(
    [...(oldLog?.consoleErrors ?? []).map((entry) => entry.text), ...(oldLog?.pageErrors ?? [])].map(normalizeMessage),
  )
  // Resources that failed on the old site too (same path), e.g. a missing stylesheet.
  const oldFailed = new Set(
    [...(oldLog?.badResponses ?? []), ...(oldLog?.failedRequests ?? [])].map((entry) => requestKey(entry.url)),
  )
  const isSite = (host) => host === '' || SITE_HOSTS.has(host) || NEW_INFRA.test(host)
  const firstParty = []
  const thirdParty = []
  const alsoOld = []
  for (const entry of newLog?.consoleErrors ?? []) {
    const host = hostOf(entry.location)
    const resource = /Failed to load resource/.test(entry.text)
    // A failed resource is logged with the resource URL as its location.
    if (route.kind === 'not-found' && resource && SITE_HOSTS.has(host)) continue
    const sameAsOld = resource ? oldFailed.has(requestKey(entry.location)) : oldMessages.has(normalizeMessage(entry.text))
    if (sameAsOld) alsoOld.push(`${entry.text} (${entry.location})`)
    else if (!isSite(host)) thirdParty.push(`${entry.text} (${host})`)
    else firstParty.push(`${entry.text}${entry.location ? ` (${entry.location})` : ''}`)
  }
  for (const text of newLog?.pageErrors ?? []) {
    if (oldMessages.has(normalizeMessage(text))) alsoOld.push(`pageerror: ${text}`)
    else firstParty.push(`pageerror: ${text}`)
  }
  results.push(
    firstParty.length
      ? check('console errors (site)', UNEXPECTED, { new: firstParty })
      : check('console errors (site)', SAME, { new: [] }),
  )
  if (thirdParty.length) {
    results.push(check('console errors (third-party)', INFO, { new: [...new Set(thirdParty)], reason: 'Ads, analytics and embeds loaded by Disqus, HubSpot, YouTube and Plausible; not the site.' }))
  }
  if (alsoOld.length) results.push(check('console errors (also on old site)', INFO, { new: [...new Set(alsoOld)], reason: 'Pre-existing: the old site logs the same error.' }))

  const failed = [
    ...(newLog?.badResponses ?? []).map((entry) => ({ ...entry, failure: `HTTP ${entry.status}` })),
    ...(newLog?.failedRequests ?? []),
  ].filter((entry) => {
    const host = hostOf(entry.url)
    if (route.kind === 'not-found' && entry.type === 'document' && SITE_HOSTS.has(host)) return false
    // Navigations away (YouTube player teardown, aborted prefetches) are not failures.
    if (entry.failure === 'net::ERR_ABORTED') return false
    return SITE_HOSTS.has(host) || NEW_INFRA.test(host)
  })
  const failedAlsoOld = failed.filter((entry) => oldFailed.has(requestKey(entry.url)))
  const failedNew = failed.filter((entry) => !oldFailed.has(requestKey(entry.url)))
  results.push(
    failedNew.length
      ? check('failed requests (site, Sanity)', UNEXPECTED, { new: failedNew.map((entry) => `${entry.failure} ${entry.type} ${entry.url}`) })
      : check('failed requests (site, Sanity)', SAME, { new: [] }),
  )
  if (failedAlsoOld.length) {
    results.push(
      check('failed requests (also on old site)', INFO, {
        new: [...new Set(failedAlsoOld.map((entry) => `${entry.failure} ${entry.type} ${entry.url}`))],
        reason: 'Pre-existing: the same path fails on the old site.',
      }),
    )
  }
  return results
}

/** Footer credit words: "with Django, Next.js and Wagtail" became "with Next.js and Sanity" (plan §7.2). */
const FOOTER_OLD_WORDS = new Set(['django', 'django,', 'wagtail', ',', 'and'])
const FOOTER_NEW_WORDS = new Set(['sanity', 'and', ','])
const FOOTER_CONTEXT = /(@cjoshmartin ,? with|next\.js,?( and)?)$/

/** Explains text hunks that come from known, intended changes. */
function explainTextHunk(hunk) {
  const oldWords = hunk.old.split(' ').filter(Boolean)
  const newWords = hunk.new.split(' ').filter(Boolean)
  if (
    FOOTER_CONTEXT.test(hunk.before) &&
    oldWords.every((word) => FOOTER_OLD_WORDS.has(word)) &&
    newWords.every((word) => FOOTER_NEW_WORDS.has(word)) &&
    (oldWords.some((word) => /django|wagtail/.test(word)) || newWords.includes('sanity'))
  ) {
    return 'Footer credit now names Next.js and Sanity instead of Django and Wagtail (plan §7.2).'
  }
  return null
}

function compareTextField(oldText, newText) {
  const result = compareText(oldText, newText)
  if (result.hunks && result.hunks.length === 0) return check('visible text', SAME, { ratio: 1, oldWords: result.oldWords, newWords: result.newWords })
  const hunks = (result.hunks ?? []).map((hunk) => ({ ...hunk, reason: explainTextHunk(hunk) }))
  const unexplained = hunks.filter((hunk) => !hunk.reason)
  const verdict = result.hunks === null || unexplained.length ? UNEXPECTED : EXPECTED
  return check('visible text', verdict, {
    ratio: Number(result.ratio.toFixed(4)),
    oldWords: result.oldWords,
    newWords: result.newWords,
    hunks: hunks.slice(0, 40),
    reason: verdict === EXPECTED ? [...new Set(hunks.map((hunk) => hunk.reason))].join(' ') : undefined,
  })
}

function compareImages(oldImages, newImages) {
  const results = []
  const content = (images) => images.filter((image) => image.kind !== 'testimonial')
  const oldContent = content(oldImages)
  const newContent = content(newImages)
  results.push(exact('image count', oldContent.length, newContent.length))
  const broken = newImages.filter((image) => image.broken)
  results.push(broken.length ? check('broken images', UNEXPECTED, { new: broken }) : check('broken images', SAME, { new: [] }))
  if (oldContent.length === newContent.length) {
    const sizeDiffs = []
    oldContent.forEach((oldImage, index) => {
      const newImage = newContent[index]
      const dw = Math.abs(oldImage.width - newImage.width)
      const dh = Math.abs(oldImage.height - newImage.height)
      if (dw > 0 || dh > 0) sizeDiffs.push({ index, kind: oldImage.kind, old: `${oldImage.width}x${oldImage.height}`, new: `${newImage.width}x${newImage.height}`, dw, dh })
    })
    const large = sizeDiffs.filter((diff) => diff.dw > 3 || diff.dh > 3)
    if (large.length) results.push(check('image sizes', UNEXPECTED, { diffs: large }))
    else if (sizeDiffs.length) results.push(check('image sizes', EXPECTED, { diffs: sizeDiffs, reason: 'Within ±3 px: Sanity CDN renditions round differently from Wagtail renditions (WP4).' }))
    else results.push(check('image sizes', SAME, {}))
  }
  const hosts = (images) => [...new Set(images.map((image) => image.host))].sort()
  const oldHosts = hosts(oldContent)
  const newHosts = hosts(newContent)
  results.push(
    exact('image hosts', oldHosts, newHosts, (_, newValue) =>
      newValue.every((host) => ['cdn.sanity.io', 'images.unsplash.com', 'next-image:cdn.sanity.io', 'next-image:images.unsplash.com'].includes(host))
        ? { reason: 'Images are served from the Sanity CDN instead of storage.googleapis.com/images-for-cms.' }
        : null,
    ),
  )
  return results
}

/** The URL the Sanity CDN serves a converted MP4 file asset from (video contract v2). */
const mp4UrlPattern = (dataset) => new RegExp(`^https://cdn\\.sanity\\.io/files/${SANITY_PROJECT_ID}/${dataset}/[0-9a-f]{40}\\.${OUTPUT_EXTENSION}$`)

/** The file name at the end of a URL, decoded ("IMG_3151.MOV"). */
const urlFileName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    return ''
  }
}

/**
 * Problems with one rendered video against its Sanity block (video contract v2,
 * docs/sanity-migration/schema-contract.md): the page must play the block's converted MP4 from the
 * Sanity CDN, typed video/mp4, and the block must be a finished conversion of its kept original
 * with the current settings.
 */
export function videoContractProblems(video, block, dataset) {
  if (!block) return ['no matching video block in Sanity']
  const problems = []
  const expect = (condition, message) => {
    if (!condition) problems.push(message)
  }
  expect(mp4UrlPattern(dataset).test(block.url ?? ''), `file URL ${block.url} is not a ${dataset} MP4 on cdn.sanity.io`)
  expect(block.mimeType === OUTPUT_MIME_TYPE && block.extension === OUTPUT_EXTENSION, `file is ${block.mimeType} .${block.extension}`)
  expect(
    block.sourceName === CONVERTED_ASSET_SOURCE_NAME && block.sourceId === block.originalRef,
    `file source is ${block.sourceName}/${block.sourceId}, not ${CONVERTED_ASSET_SOURCE_NAME}/${block.originalRef}`,
  )
  expect(block.status === 'ready', `conversion status ${block.status}`)
  expect(block.outputAssetId === block.fileRef, `conversion.outputAssetId ${block.outputAssetId} is not file ${block.fileRef} (needs conversion)`)
  expect(block.sourceAssetId === block.originalRef, `conversion.sourceAssetId ${block.sourceAssetId} is not original ${block.originalRef}`)
  expect(block.settingsVersion === SETTINGS_VERSION, `settingsVersion ${block.settingsVersion}, current ${SETTINGS_VERSION}`)
  expect(video.sources?.length === 1, `${video.sources?.length ?? 0} <source> elements`)
  expect(video.sources?.[0]?.src === block.url, `<source src> ${video.sources?.[0]?.src} is not the block's file`)
  expect(video.sources?.[0]?.type === OUTPUT_MIME_TYPE, `<source type> ${video.sources?.[0]?.type}`)
  expect(video.src === block.url, `currentSrc ${video.src} is not the block's file`)
  expect(JSON.stringify(video.fallbackLinks ?? []) === JSON.stringify([block.url]), `fallback link ${JSON.stringify(video.fallbackLinks)}`)
  expect(!video.error, `media error ${video.error}`)
  return problems
}

function compareVideos(oldVideos, newVideos, doc, dataset) {
  const blocks = doc?.videos ?? []
  const results = []
  // Every Wagtail video is in Sanity now (owner decision 2026-11-26: Mux dropped), so the counts
  // must be equal, with no exceptions.
  results.push(exact('video count', oldVideos.length, newVideos.length))
  if (newVideos.length || blocks.length) {
    results.push(
      newVideos.length === blocks.length
        ? check('video count = Sanity video blocks', SAME, { new: newVideos.length })
        : check('video count = Sanity video blocks', UNEXPECTED, { old: blocks.length, new: newVideos.length, reason: 'old = published video blocks in the page body' }),
    )
  }
  const attributes = (video) =>
    `autoplay=${video.autoplay} muted=${video.muted} loop=${video.loop} playsInline=${video.playsInline} controls=${video.controls}`
  const wrong = newVideos.filter((video) => !(video.autoplay && video.muted && video.loop && video.playsInline && video.controls))
  results.push(
    wrong.length
      ? check('video attributes', UNEXPECTED, { new: wrong.map(attributes) })
      : check('video attributes', SAME, { new: newVideos.length ? 'all autoplay, muted, loop, playsInline, controls' : 'no videos' }),
  )
  const autoplayCount = (videos) => `${videos.filter((video) => video.autoplay).length} of ${videos.length}`
  results.push(exact('video autoplay attribute', autoplayCount(oldVideos), autoplayCount(newVideos)))
  if (!newVideos.length && !oldVideos.length) return results

  const contract = newVideos.map((video, index) => ({ index, problems: videoContractProblems(video, blocks[index], dataset) }))
  const broken = contract.filter((entry) => entry.problems.length)
  results.push(
    broken.length
      ? check('video files (contract v2)', UNEXPECTED, { new: broken })
      : check('video files (contract v2)', SAME, {
          new: `${newVideos.length} ready MP4s (${SETTINGS_VERSION}) from cdn.sanity.io/files/${SANITY_PROJECT_ID}/${dataset}, <source type="${OUTPUT_MIME_TYPE}">`,
        }),
  )

  // Same videos in the same order: the old page's file is the block's kept original.
  const order = oldVideos.map((video, index) => ({ old: urlFileName(video.src), original: blocks[index]?.originalFilename ?? null }))
  const misordered = order.filter((entry) => entry.old !== entry.original)
  results.push(
    misordered.length || oldVideos.length !== blocks.length
      ? check('video order (old file = Sanity original)', UNEXPECTED, { old: order.map((entry) => entry.old), new: order.map((entry) => entry.original) })
      : check('video order (old file = Sanity original)', SAME, { new: order.map((entry) => entry.old) }),
  )

  const hosts = (videos) => [...new Set(videos.map((video) => hostOf(video.src) || video.src.split(':')[0]))]
  results.push(
    exact('video sources', hosts(oldVideos), hosts(newVideos), (oldValue, newValue) =>
      oldValue.every((host) => host === 'storage.googleapis.com') && newValue.every((host) => host === 'cdn.sanity.io') && !broken.length
        ? {
            reason:
              'Videos are MP4 file assets converted with the fixed settings and served by the Sanity CDN, instead of the original uploads in the old GCS bucket (owner decision 2026-11-26, video contract v2).',
          }
        : null,
    ),
  )

  // Rendered boxes: the MP4 keeps the displayed aspect ratio up to even-pixel rounding.
  if (oldVideos.length === newVideos.length) {
    const diffs = []
    const undecodedOld = []
    oldVideos.forEach((oldVideo, index) => {
      const newVideo = newVideos[index]
      if (!oldVideo.readyState || oldVideo.error) {
        undecodedOld.push({ index, old: `${oldVideo.width}x${oldVideo.height}`, readyState: oldVideo.readyState, error: oldVideo.error })
        return
      }
      const dw = Math.abs(oldVideo.width - newVideo.width)
      const dh = Math.abs(oldVideo.height - newVideo.height)
      if (dw || dh) diffs.push({ index, old: `${oldVideo.width}x${oldVideo.height}`, new: `${newVideo.width}x${newVideo.height}`, dw, dh })
    })
    const large = diffs.filter((diff) => diff.dw > VIDEO_BOX_TOLERANCE || diff.dh > VIDEO_BOX_TOLERANCE)
    if (large.length) results.push(check('video sizes', UNEXPECTED, { diffs: large }))
    else if (diffs.length) {
      results.push(
        check('video sizes', EXPECTED, { diffs, reason: `Within ±${VIDEO_BOX_TOLERANCE} px: the MP4's sides are rounded down to even numbers when it is scaled (settings.ts).` }),
      )
    } else results.push(check('video sizes', SAME, {}))
    if (undecodedOld.length) {
      results.push(
        check('old videos not decoded by the test browser', INFO, { old: undecodedOld, reason: 'The old original could not be measured, so its size is not compared.' }),
      )
    }
  }
  const unmeasured = newVideos.filter((video) => !video.readyState || !video.videoWidth)
  if (unmeasured.length) results.push(check('new videos without metadata', UNEXPECTED, { new: unmeasured.map((video) => `${video.src} readyState=${video.readyState}`) }))
  return results
}

/**
 * Requests and HTML of the new site that reach Mux or the old bucket (src/forbidden.mjs), on any
 * route kind and at both widths.
 */
function compareForbidden(newSite) {
  const found = []
  for (const hop of newSite.http?.chain ?? []) {
    for (const item of hop.forbiddenInBody ?? []) found.push(`${hop.url} HTML: ${item.count}x ${item.name} (${item.examples.join(', ')})`)
  }
  let requests = 0
  for (const [viewport, entry] of Object.entries(newSite.browser ?? {})) {
    const log = entry?.log
    if (!log) continue
    requests += Object.values(log.requestHosts ?? {}).reduce((sum, count) => sum + count, 0)
    for (const request of log.forbiddenRequests ?? []) found.push(`${viewport} ${request.type} ${request.url} (${request.reason})`)
  }
  return found.length
    ? check('forbidden hosts (Mux, images-for-cms)', UNEXPECTED, { new: found })
    : check('forbidden hosts (Mux, images-for-cms)', SAME, { new: `0 of ${requests} browser requests; none in the HTML` })
}

/** Compares one desktop page extraction. */
function comparePage(route, oldExtract, newExtract, doc, dataset) {
  const rules = routeRules(route, doc)
  const results = [
    exact('title', oldExtract.title, newExtract.title, rules.title),
    exact('description', oldExtract.description, newExtract.description, rules.description),
    exact('og:image present', Boolean(oldExtract.ogImage), Boolean(newExtract.ogImage)),
    exact('og:image', oldExtract.ogImage, newExtract.ogImage, rules.ogImage),
    exact('canonical', oldExtract.canonical, newExtract.canonical, rules.canonical),
    exact('robots meta', oldExtract.robots, newExtract.robots),
    exact('h1', oldExtract.h1, newExtract.h1),
    exact(
      'headings (tag, id, text)',
      oldExtract.headings.map((heading) => `${heading.tag}#${heading.id ?? ''} ${heading.text}`),
      newExtract.headings.map((heading) => `${heading.tag}#${heading.id ?? ''} ${heading.text}`),
    ),
  ]
  // Every anchor the old page offered (heading ids and in-page #links) must still resolve.
  // (#links that did not resolve on the old page either are content mistakes, listed as info.)
  const oldIds = new Set(oldExtract.allIds)
  const resolves = (ids, id) => ids.has(id) || ids.has(decodeURIComponent(id))
  const oldAnchors = [...new Set([...oldExtract.headings.map((heading) => heading.id), ...oldExtract.anchorLinks].filter(Boolean))]
  const validOld = oldAnchors.filter((id) => resolves(oldIds, id))
  const brokenOnOld = oldAnchors.filter((id) => !resolves(oldIds, id))
  const newIds = new Set(newExtract.allIds)
  const lost = validOld.filter((id) => !resolves(newIds, id))
  results.push(
    lost.length
      ? check('old heading anchors resolve', UNEXPECTED, { old: validOld, missing: lost })
      : check('old heading anchors resolve', SAME, { old: validOld }),
  )
  if (brokenOnOld.length) {
    results.push(
      check('in-page links broken on both sites', INFO, {
        old: brokenOnOld,
        new: brokenOnOld.filter((id) => !resolves(newIds, id)),
        reason: 'Content links whose href starts with "#" but point nowhere; migrated unchanged.',
      }),
    )
  }
  results.push(...compareImages(oldExtract.images, newExtract.images))
  results.push(...compareVideos(oldExtract.videos, newExtract.videos, doc, dataset))
  const iframeKinds = (extract, kind) => extract.iframes.filter((frame) => frame.kind === kind).map((frame) => frame.src.replace(/&?enablejsapi=1/, ''))
  results.push(exact('YouTube iframes', iframeKinds(oldExtract, 'youtube'), iframeKinds(newExtract, 'youtube')))
  results.push(exact('Disqus thread', iframeKinds(oldExtract, 'disqus').length > 0, iframeKinds(newExtract, 'disqus').length > 0))
  results.push(exact('code blocks', oldExtract.codeBlocks.length, newExtract.codeBlocks.length))
  results.push(
    exact(
      'code text',
      oldExtract.codeBlocks.map((block) => block.text),
      newExtract.codeBlocks.map((block) => block.text),
    ),
  )
  results.push(
    exact(
      'code line numbers',
      oldExtract.codeBlocks.map((block) => block.lineNumbers),
      newExtract.codeBlocks.map((block) => block.lineNumbers),
    ),
  )
  results.push(exact('STL canvases', oldExtract.stl.canvases, newExtract.stl.canvases))
  results.push(newExtract.stl.loadErrors ? check('STL load errors', UNEXPECTED, { new: newExtract.stl.loadErrors }) : check('STL load errors', SAME, { new: 0 }))

  const oldLinks = oldExtract.internalLinks
  const newLinks = newExtract.internalLinks
  const removed = missingFrom(oldLinks, newLinks)
  const added = missingFrom(newLinks, oldLinks)
  const oldExternal = oldExtract.externalLinks.map(normalizeExternal)
  const newExternal = newExtract.externalLinks.map(normalizeExternal)
  const externalRemoved = missingFrom(oldExternal, newExternal)
  const externalAdded = missingFrom(newExternal, oldExternal)
  // Review fixes R1-5: links the migration corrects (wagtail-to-sanity/src/content-fixes.ts). An
  // href with a stray leading "#" was an in-page link on the old site and is a real link now. A fix
  // only explains the difference when both halves are seen on this page.
  const appliedFixes = LINK_HREF_FIXES.filter(
    (fix) =>
      fix.from.startsWith('#') &&
      removed.includes(`${route.path}${fix.from}`) &&
      externalAdded.includes(fix.to.replace(/^https?:\/\//, '')),
  )
  const fixReason = appliedFixes.length
    ? `Review fixes R1-5: ${appliedFixes.map((fix) => `"${fix.from}" corrected to ${fix.to}`).join('; ')} (migration content fix).`
    : undefined
  const unexplainedRemoved = removed.filter((link) => !appliedFixes.some((fix) => link === `${route.path}${fix.from}`))
  if (!removed.length && !added.length) {
    results.push(check('internal links', SAME, { count: newLinks.length, order: JSON.stringify(oldLinks) === JSON.stringify(newLinks) ? 'same order' : 'same set, different order' }))
  } else if (!unexplainedRemoved.length && !added.length) {
    results.push(check('internal links', EXPECTED, { removed, added, reason: fixReason }))
  } else {
    results.push(check('internal links', UNEXPECTED, { removed, added }))
  }
  const unexplainedAdded = externalAdded.filter((link) => !appliedFixes.some((fix) => link === fix.to.replace(/^https?:\/\//, '')))
  const footerOnly =
    externalRemoved.every((link) => ['www.djangoproject.com/', 'wagtail.org/'].includes(link)) &&
    unexplainedAdded.every((link) => link === 'www.sanity.io/')
  results.push(
    externalRemoved.length || externalAdded.length
      ? check('external links', footerOnly ? EXPECTED : UNEXPECTED, {
          removed: externalRemoved,
          added: externalAdded,
          reason: footerOnly
            ? ['Footer credit links: Django and Wagtail replaced by Sanity (plan §7.2).', fixReason].filter(Boolean).join(' ')
            : undefined,
        })
      : check('external links', SAME, { count: newExternal.length, note: 'GCS document/image URLs and cdn.sanity.io URLs are compared as "migrated-asset"' }),
  )
  results.push(compareTextField(oldExtract.text, newExtract.text))

  // The first testimonial (shown for 30 s before rotating) must be the same person with the same art.
  if (oldExtract.testimonials.length || newExtract.testimonials.length) {
    results.push(
      exact(
        'testimonials (name, ASCII spans)',
        oldExtract.testimonials.map((testimonial) => `${testimonial.name} (${testimonial.asciiSpans})`),
        newExtract.testimonials.map((testimonial) => `${testimonial.name} (${testimonial.asciiSpans})`),
      ),
    )
    results.push(
      exact(
        'testimonial ASCII characters',
        oldExtract.testimonials.map((testimonial) => testimonial.asciiText),
        newExtract.testimonials.map((testimonial) => testimonial.asciiText),
      ),
    )
  }
  return results
}

/** The resume's Charter stylesheet answered 404 (it did on the old site; review fixes R1-3). */
const charterFontMissing = (log) => (log?.badResponses ?? []).some((response) => /\/charter-font\.css$/.test(response.url))

function compareLayout(oldBrowser, newBrowser) {
  const results = []
  for (const viewport of ['desktop', 'mobile']) {
    const oldEntry = oldBrowser?.[viewport]
    const newEntry = newBrowser?.[viewport]
    if (!oldEntry?.extract || !newEntry?.extract) {
      results.push(check(`${viewport} load`, UNEXPECTED, { old: oldEntry?.error ?? 'ok', new: newEntry?.error ?? 'ok' }))
      continue
    }
    results.push(
      newEntry.extract.horizontalScroll && !oldEntry.extract.horizontalScroll
        ? check(`${viewport} horizontal scroll`, UNEXPECTED, { old: false, new: true })
        : check(`${viewport} horizontal scroll`, SAME, { old: oldEntry.extract.horizontalScroll, new: newEntry.extract.horizontalScroll }),
    )
    const delta = newEntry.extract.pageHeight - oldEntry.extract.pageHeight
    const heights = { old: oldEntry.extract.pageHeight, new: newEntry.extract.pageHeight, delta }
    // Video boxes may differ by a few px each (see VIDEO_BOX_TOLERANCE); with the same number of
    // videos, that part of the difference is explained by them.
    const oldVideos = oldEntry.extract.videos ?? []
    const newVideos = newEntry.extract.videos ?? []
    const videoDelta = newVideos.reduce((sum, video) => sum + video.height, 0) - oldVideos.reduce((sum, video) => sum + video.height, 0)
    const videoBoxesClose =
      oldVideos.length === newVideos.length &&
      oldVideos.every(
        (video, index) => Math.abs(video.height - newVideos[index].height) <= VIDEO_BOX_TOLERANCE && Math.abs(video.width - newVideos[index].width) <= VIDEO_BOX_TOLERANCE,
      )
    if (Math.abs(delta) <= 4) results.push(check(`${viewport} page height`, delta === 0 ? SAME : EXPECTED, { ...heights, reason: delta ? 'Within ±4 px (image rounding).' : undefined }))
    else if (newVideos.length && videoBoxesClose && Math.abs(delta - videoDelta) <= 4) {
      results.push(
        check(`${viewport} page height`, EXPECTED, {
          ...heights,
          videoDelta,
          reason: `The ${newVideos.length} video boxes account for ${videoDelta} px (each within ±${VIDEO_BOX_TOLERANCE} px: MP4 even-size rounding); the rest is within ±4 px.`,
        }),
      )
    }
    else if (charterFontMissing(oldEntry.log) && !charterFontMissing(newEntry.log)) {
      results.push(check(`${viewport} page height`, EXPECTED, { ...heights, reason: 'Review fixes R1-3: the Charter fonts load now (the old site requested a missing stylesheet and fell back to Times), so the text reflows.' }))
    }
    else results.push(check(`${viewport} page height`, UNEXPECTED, heights))
    results.push(
      newEntry.screenshot?.file
        ? check(`${viewport} screenshot`, SAME, { old: oldEntry.screenshot?.file, new: newEntry.screenshot.file })
        : check(`${viewport} screenshot`, UNEXPECTED, { error: newEntry.screenshot?.error }),
    )
    results.push(...compareConsole(oldEntry.log, newEntry.log, { kind: 'page' }).map((result) => ({ ...result, field: `${viewport} ${result.field}` })))
  }
  return results
}

function parseSitemap(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => ({
    loc: (match[1].match(/<loc>([^<]*)<\/loc>/) ?? [])[1] ?? null,
    lastmod: (match[1].match(/<lastmod>([^<]*)<\/lastmod>/) ?? [])[1] ?? null,
  }))
}

function compareSitemap(oldHttp, newHttp, reference) {
  const results = [exact('status', oldHttp.final.status, newHttp.final.status)]
  const oldUrls = parseSitemap(oldHttp.final.body ?? '')
  const newUrls = parseSitemap(newHttp.final.body ?? '')
  const toPath = (loc) => loc.replace(/^https?:\/+(www\.)?cjoshmartin\.com/, '') || '/'
  const oldPaths = oldUrls.map((entry) => toPath(entry.loc)).sort()
  const newPaths = newUrls.map((entry) => toPath(entry.loc)).sort()
  results.push(
    exact('URL base', [...new Set(oldUrls.map((entry) => entry.loc.match(/^https?:\/+[^/]+/)[0]))], [...new Set(newUrls.map((entry) => entry.loc.match(/^https?:\/+[^/]+/)[0]))], (oldValue, newValue) =>
      JSON.stringify(newValue) === JSON.stringify(['https://cjoshmartin.com']) ? { reason: `Plan §7.3 bug 4: the base was ${oldValue.join(', ')}.` } : null,
    ),
  )
  const unlisted = new Set(reference.pages.filter((page) => page.isUnlisted).map((page) => (page._type === 'blogPost' ? `/blog/${page.slug}` : `/projects/${page.slug}`)))
  results.push(
    exact('URL paths', oldPaths, newPaths, (oldValue, newValue) => {
      const removed = missingFrom(oldValue, newValue)
      const added = missingFrom(newValue, oldValue)
      if (!added.length && removed.every((item) => unlisted.has(item))) return { reason: `Plan §7.3 bug 1: unlisted pages removed (${removed.join(', ')}).` }
      return null
    }),
  )
  const flexInNew = newPaths.filter((item) => item.startsWith('/flex/'))
  results.push(flexInNew.length ? check('flex pages excluded', UNEXPECTED, { new: flexInNew }) : check('flex pages excluded', SAME, {}))
  const byPath = new Map(reference.pages.map((page) => [page._type === 'homePage' ? '/' : page._type === 'blogPost' ? `/blog/${page.slug}` : `/projects/${page.slug}`, page]))
  const wrongLastmod = newUrls.filter((entry) => {
    const page = byPath.get(toPath(entry.loc))
    return !page || !entry.lastmod || new Date(entry.lastmod).getTime() !== new Date(page._updatedAt).getTime()
  })
  results.push(
    wrongLastmod.length
      ? check('lastmod = _updatedAt', UNEXPECTED, { new: wrongLastmod })
      : check('lastmod = _updatedAt', EXPECTED, { reason: 'Plan §7.3 bug 4: lastModified is the Sanity _updatedAt (the import time until edited).' }),
  )
  return results
}

/** Where a redirect route ends up: the first off-site hop, else the final on-site URL path. */
function redirectTarget(site) {
  const offSiteHop = site.http.chain.find((hop) => hop.offSite)
  if (offSiteHop) return offSiteHop.url
  const browser = site.browser?.desktop
  if (browser?.firstOffSite) return browser.firstOffSite
  const finalUrl = browser?.finalUrl ?? site.http.final.url
  const url = new URL(finalUrl)
  return url.pathname + url.search
}

/**
 * A Wagtail redirect to a page that was never published: since the round-1 review fixes
 * (docs/sanity-migration/reports/fixes.md, R1-2) the migration keeps it as a draft redirect, so
 * the site serves no redirect and the path is a plain 404, until the page and the redirect are
 * published together.
 */
function isDraftRedirect(route, reference) {
  return (
    route.kind === 'wagtail-redirect' &&
    route.redirectPageId != null &&
    !reference.pages.some((page) => page.wagtailId === route.redirectPageId) &&
    !reference.redirects.some((item) => item.source === route.path)
  )
}

function compareRedirect(route, oldSite, newSite, reference) {
  const oldTarget = redirectTarget(oldSite)
  const newTarget = redirectTarget(newSite)
  const draftRedirect = isDraftRedirect(route, reference)
  const draftRedirectReason = `Review fixes R1-2: the target (Wagtail page ${route.redirectPageId}) was never published, so the redirect is a draft in Sanity and the site serves no redirect; the old frontend ignored Wagtail redirects and showed its crash page.`
  const newHop = `${newSite.http.firstStatus}${newSite.http.firstLocation ? ` → ${newSite.http.firstLocation}` : ''}`
  const oldHop = `${oldSite.http.firstStatus}${oldSite.http.firstLocation ? ` → ${oldSite.http.firstLocation}` : ''}`
  const results = [
    check('first response', oldHop === newHop ? SAME : INFO, { old: oldHop, new: newHop }),
  ]
  const explain = () => {
    if (route.path === '/about' && newSite.http.firstStatus === 308 && newTarget === '/') return { reason: 'Plan §7.1: /about is a 308 config redirect to / (the old page redirected in the browser).' }
    if (route.path === '/admin' && newTarget.startsWith('https://cjoshmartin.sanity.studio')) return { reason: 'Plan §7.1: /admin goes to the Studio instead of the Wagtail admin.' }
    if (route.kind === 'wagtail-redirect') {
      const redirect = reference.redirects.find((item) => item.source === route.path)
      if (redirect && newSite.http.firstStatus === 308 && newSite.http.firstLocation === redirect.destination) {
        return { reason: `The Wagtail redirect is now a Sanity redirect document (308 → ${redirect.destination}); the old frontend ignored Wagtail redirects.` }
      }
    }
    return null
  }
  results.push(exact('redirect target', oldTarget, newTarget, explain))
  if (route.kind === 'wagtail-redirect') {
    const finalStatus = newSite.http.final.status
    if (draftRedirect) {
      results.push(
        finalStatus === 404 && newSite.http.chain.length <= 1 && !newSite.http.firstLocation
          ? check('redirect destination status', EXPECTED, { new: `${newSite.http.final.url} ${finalStatus}`, reason: draftRedirectReason })
          : check('redirect destination status', UNEXPECTED, { new: `${newSite.http.final.url} ${finalStatus}`, reason: 'A draft redirect must not be served: expected a 404 without a redirect.' }),
      )
    } else {
      results.push(
        finalStatus === 200
          ? check('redirect destination status', SAME, { new: `${newSite.http.final.url} ${finalStatus}` })
          : check('redirect destination status', UNEXPECTED, { new: `${newSite.http.final.url} ${finalStatus}` }),
      )
    }
  }
  return results
}

/** The Next.js error boundary page the old site showed when a route crashed. */
const OLD_CRASH_H1 = 'This page couldn\u2019t load'
const crashed = (extract) => Boolean(extract?.h1?.includes(OLD_CRASH_H1))

/**
 * Compares one crawled route. Returns {verdict, checks}.
 * @param records every crawled record by route path, for routes compared against another new route.
 */
export function compareRecord(record, reference, records) {
  const { route } = record
  const oldSite = record.sites.old
  const newSite = record.sites.new
  const doc = reference.byPath.get(route.path.split('?')[0])
  let checks = []
  if (route.kind === 'sitemap') checks = compareSitemap(oldSite.http, newSite.http, reference)
  else if (route.kind === 'robots') {
    checks = [exact('status', oldSite.http.final.status, newSite.http.final.status), exact('body', oldSite.http.final.body, newSite.http.final.body)]
  } else if (route.kind === 'redirect' || route.kind === 'wagtail-redirect') {
    checks = compareRedirect(route, oldSite, newSite, reference)
  } else {
    const oldDesktop = oldSite.browser?.desktop
    const newDesktop = newSite.browser?.desktop
    if (route.kind === 'not-found') {
      const oldCrashed = crashed(oldDesktop?.extract)
      const bug5 = { reason: `Plan §7.3 bug 5: the new site serves its not-found page with a 404; the old site answered ${oldSite.http.final.status} and ${oldCrashed ? 'crashed into the error page' : 'rendered a page'}.` }
      checks.push(exact('HTTP status', oldSite.http.final.status, newSite.http.final.status, (oldValue, newValue) => (oldValue === 200 && newValue === 404 ? bug5 : null)))
      checks.push(exact('h1', oldDesktop?.extract?.h1, newDesktop?.extract?.h1, (_, newValue) => (oldCrashed && newValue?.includes('404') ? bug5 : null)))
      const notFoundText = /404 this page could not be found/i.test(newDesktop?.extract?.text ?? '')
      checks.push(
        notFoundText
          ? check('not-found page text', oldCrashed ? EXPECTED : SAME, { new: '404 This page could not be found.', reason: oldCrashed ? bug5.reason : undefined })
          : check('not-found page text', UNEXPECTED, { new: newDesktop?.extract?.text?.slice(0, 200) }),
      )
      checks.push(...compareConsole(oldDesktop?.log, newDesktop?.log, route))
    } else if (route.compareWithNew) {
      // Plan §7.3 bug 3: a query string on / must render the normal home page. The old site
      // crashed, so the new page is compared with the new home page instead.
      const base = records.get(route.compareWithNew)?.sites.new.browser?.desktop?.extract
      if (!base) throw new Error(`No crawl data for ${route.compareWithNew}, needed by ${route.path}`)
      checks.push(exact('HTTP status', oldSite.http.final.status, newSite.http.final.status))
      checks.push(
        crashed(oldDesktop?.extract)
          ? check('old site behaviour', EXPECTED, { old: OLD_CRASH_H1, new: newDesktop?.extract?.h1, reason: 'Plan §7.3 bug 3: the old site crashed on a query string; the new one renders the home page.' })
          : check('old site behaviour', INFO, { old: oldDesktop?.extract?.h1 }),
      )
      if (newDesktop?.extract) {
        checks.push(
          ...comparePage(route, base, newDesktop.extract, doc, reference.dataset).map((item) => ({
            ...item,
            field: `${item.field} (vs new ${route.compareWithNew})`,
          })),
        )
      }
      checks.push(...compareLayout(records.get(route.compareWithNew).sites.new.browser, newSite.browser).map((item) => ({ ...item, field: `${item.field} (vs new ${route.compareWithNew})` })))
    } else {
      checks.push(exact('HTTP status', oldSite.http.final.status, newSite.http.final.status))
      if (route.oldReferer) {
        const withoutReferer = oldSite.browser?.withoutReferer
        const oldCrashes = Boolean(withoutReferer?.h1?.includes(OLD_CRASH_H1))
        checks.push(
          check('old site without a Referer', oldCrashes ? EXPECTED : INFO, {
            old: oldCrashes ? `crashes (${withoutReferer.pageErrors[0] ?? OLD_CRASH_H1}); compared with Referer ${route.oldReferer}` : withoutReferer,
            new: newDesktop?.extract?.h1,
            reason: oldCrashes ? 'Plan §7.3 bug 6: flex pages no longer build their data URL from the Referer header, so they render without one.' : undefined,
          }),
        )
      }
      if (oldDesktop?.extract && newDesktop?.extract) checks.push(...comparePage(route, oldDesktop.extract, newDesktop.extract, doc, reference.dataset))
      checks.push(...compareLayout(oldSite.browser, newSite.browser))
    }
  }
  checks.push(compareForbidden(newSite))
  const verdict = checks.some((item) => item.verdict === UNEXPECTED) ? UNEXPECTED : checks.some((item) => item.verdict === EXPECTED) ? EXPECTED : SAME
  return { route, verdict, checks }
}
