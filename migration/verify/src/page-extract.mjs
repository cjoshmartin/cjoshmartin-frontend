// Runs inside the page (page.evaluate). It must stay self-contained: no imports, no closures.
// Regions that change on their own (the rotating testimonial, Disqus, third-party ad frames) are
// reported separately and left out of the heading, link and text comparison.

export function extractPage() {
  const DYNAMIC_SELECTOR = [
    '[class*="Testimonial-module"]',
    '[class*="TestimonialProgress-module"]',
    '#disqus_thread',
    'script',
    'style',
    'noscript',
    'template',
  ].join(', ')
  const norm = (text) => (text ?? '').replace(/\s+/g, ' ').trim()
  const isDynamic = (element) => Boolean(element.closest(DYNAMIC_SELECTOR))
  const meta = (selector) => document.querySelector(selector)?.getAttribute('content') ?? null
  const siteHosts = new Set([location.host, 'cjoshmartin.com', 'www.cjoshmartin.com'])

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter((heading) => !isDynamic(heading))
    .map((heading) => ({ tag: heading.tagName.toLowerCase(), id: heading.id || null, text: norm(heading.textContent) }))

  const images = [...document.images].map((image) => ({
    kind: image.closest('[class*="Testimonial-module"]')
      ? 'testimonial'
      : image.classList.contains('richtext-image')
        ? 'richtext'
        : 'other',
    className: typeof image.className === 'string' ? image.className.replace(/__[A-Za-z0-9_-]+/g, '') : '',
    host: (() => {
      try {
        const url = new URL(image.currentSrc || image.src)
        // next/image proxies the real source through /_next/image?url=...
        if (url.pathname === '/_next/image' && url.searchParams.get('url')) return 'next-image:' + new URL(url.searchParams.get('url'), location.href).host
        return url.host
      } catch {
        return 'invalid-src'
      }
    })(),
    width: Math.round(image.getBoundingClientRect().width),
    height: Math.round(image.getBoundingClientRect().height),
    broken: image.complete && image.naturalWidth === 0 && Boolean(image.getAttribute('src')),
    loaded: image.complete && image.naturalWidth > 0,
  }))

  const iframes = [...document.querySelectorAll('iframe')].map((frame) => {
    const src = frame.getAttribute('src') ?? ''
    let host = ''
    try {
      host = src ? new URL(src, location.href).host : ''
    } catch {
      host = 'invalid-src'
    }
    const kind = /(^|\.)youtube(-nocookie)?\.com$/.test(host)
      ? 'youtube'
      : /(^|\.)disqus\.com$/.test(host)
        ? 'disqus'
        : 'third-party'
    return { kind, host, src: kind === 'youtube' ? src : src.slice(0, 120) }
  })

  const videos = [...document.querySelectorAll('video')].map((video) => {
    const box = video.getBoundingClientRect()
    return {
      src: (video.currentSrc || video.getAttribute('src') || video.querySelector('source')?.getAttribute('src') || '').slice(0, 300),
      sources: [...video.querySelectorAll('source')].map((source) => ({ src: source.src, type: source.getAttribute('type') })),
      // Fallback content is only shown by browsers without <video> support (package C decision 3).
      fallbackLinks: [...video.querySelectorAll('a[href]')].map((anchor) => anchor.href),
      autoplay: video.autoplay,
      muted: video.muted,
      loop: video.loop,
      playsInline: video.playsInline,
      controls: video.controls,
      preload: video.getAttribute('preload'),
      width: Math.round(box.width),
      height: Math.round(box.height),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      error: video.error ? `${video.error.code} ${video.error.message}` : null,
    }
  })

  const codeBlocks = [...document.querySelectorAll('pre')]
    .filter((pre) => pre.querySelector('code') && !isDynamic(pre))
    .map((pre) => ({
      lineNumbers: pre.querySelectorAll('.linenumber, .react-syntax-highlighter-line-number').length,
      text: norm(pre.querySelector('code').textContent).slice(0, 4000),
    }))

  const stl = {
    canvases: document.querySelectorAll('.App canvas').length,
    loadErrors: [...document.querySelectorAll('p, div, span')].filter((element) =>
      /the 3D model could not be loaded/.test(element.textContent ?? '') && element.children.length === 0,
    ).length,
  }

  const internalLinks = []
  const externalLinks = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isDynamic(anchor)) continue
    // A <video>'s fallback download link is never shown where video plays; it is checked with the
    // videos instead.
    if (anchor.closest('video')) continue
    const raw = anchor.getAttribute('href')
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue
    let url
    try {
      url = new URL(raw, location.href)
    } catch {
      internalLinks.push('INVALID:' + raw)
      continue
    }
    if (siteHosts.has(url.host)) internalLinks.push(url.pathname + url.search + url.hash)
    else externalLinks.push(url.host + url.pathname)
  }

  const anchorLinks = [...document.querySelectorAll('a[href^="#"]')]
    .filter((anchor) => !isDynamic(anchor))
    .map((anchor) => anchor.getAttribute('href').slice(1))
  const allIds = [...document.querySelectorAll('[id]')].map((element) => element.id)

  // Visible text, in document order, without the dynamic regions.
  const parts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || isDynamic(parent)) continue
    // Fallback content of a <video> (see above) is not rendered.
    if (parent.closest('video')) continue
    if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility({ visibilityProperty: true })) continue
    const text = norm(node.textContent)
    if (text) parts.push(text)
  }

  // CSS-module class names look like "Testimonial-module__IouYXG__container".
  const hasModuleClass = (element, local) =>
    [...element.classList].some((name) => new RegExp(`^Testimonial-module__[A-Za-z0-9_-]+__${local}$`).test(name))
  const testimonialContainers = [...document.querySelectorAll('[class*="Testimonial-module"]')].filter((element) =>
    hasModuleClass(element, 'container'),
  )
  const testimonials = testimonialContainers.map((container) => {
    const art = [...container.querySelectorAll('[class*="Testimonial-module"]')].find((element) => hasModuleClass(element, 'image'))
    return {
      name: norm(container.querySelector('h3')?.textContent),
      asciiSpans: art ? art.querySelectorAll('span[style*="color"]').length : 0,
      asciiText: art ? art.textContent.replace(/\s+/g, '') : '',
    }
  })

  return {
    url: location.href,
    title: document.title,
    description: meta('meta[name="description"]'),
    ogImage: meta('meta[property="og:image"]'),
    ogTitle: meta('meta[property="og:title"]'),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    robots: meta('meta[name="robots"]'),
    h1: headings.filter((heading) => heading.tag === 'h1').map((heading) => heading.text),
    headings,
    images,
    iframes,
    videos,
    codeBlocks,
    stl,
    internalLinks,
    externalLinks,
    anchorLinks,
    allIds,
    text: parts.join(' '),
    testimonials,
    pageHeight: document.documentElement.scrollHeight,
    horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  }
}
