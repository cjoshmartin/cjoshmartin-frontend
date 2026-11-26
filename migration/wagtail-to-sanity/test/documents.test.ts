import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {LINK_HREF_FIXES, linkHrefFix} from '../src/content-fixes'
import {SETTINGS_VERSION} from '../../../studio/functions/video-to-mp4/settings'
import {videoConversionState, videoNeedsConversion} from '../../../studio/schemaTypes/shared/video-conversion'
import {MIGRATION_ID_PATTERN} from '../src/steps/import'
import {flattenLinkText, pageSitePath, videoBlock} from '../src/transform/documents'
import {wagtailTagOrder, type WagtailPage} from '../src/wagtail'

describe('flattenLinkText', () => {
  it('keeps a single plain paragraph without reporting losses', () => {
    assert.deepEqual(flattenLinkText('<p data-block-key="gajfs">Checkout examples</p>', 's'), {
      html: '<p data-block-key="gajfs">Checkout examples</p>',
      text: 'Checkout examples',
      lost: [],
    })
  })

  it('reports every piece of formatting it drops', () => {
    const result = flattenLinkText('<p>See <b>all</b> <a href="/x">work</a><br/>now</p><p>more</p>', 's')
    assert.equal(result.text, 'See all work now more')
    assert.deepEqual(result.lost.sort(), [
      '2 paragraphs joined with a space',
      '<b> formatting removed',
      'line break became a space',
      'link to /x removed',
    ])
  })
})

describe('videoBlock', () => {
  const assets = {
    mediaId: 7,
    original: {assetId: 'file-aaa-mov', sha1: 'aaa', originalFilename: 'IMG_3151.MOV', mimeType: 'video/quicktime'},
    mp4: {assetId: 'file-bbb-mp4', sha1: 'bbb', originalFilename: 'IMG_3151.mp4', mimeType: 'video/mp4', size: 10, origin: 'convert' as const},
    conversion: {settingsVersion: SETTINGS_VERSION, convertedAt: '2026-11-26T14:00:00.000Z'},
  }

  it('writes a contract v2 block that plays the MP4, keeps the original and is ready', () => {
    assert.deepEqual(videoBlock('0f1e2d3c-key', assets), {
      _type: 'video',
      _key: '0f1e2d3c-key',
      file: {_type: 'file', asset: {_type: 'reference', _ref: 'file-bbb-mp4'}},
      original: {_type: 'file', asset: {_type: 'reference', _ref: 'file-aaa-mov'}},
      conversion: {
        status: 'ready',
        sourceAssetId: 'file-aaa-mov',
        outputAssetId: 'file-bbb-mp4',
        settingsVersion: SETTINGS_VERSION,
        updatedAt: '2026-11-26T14:00:00.000Z',
      },
    })
  })

  it('does not need conversion by the Studio rule, so the video-to-mp4 Function leaves it alone', () => {
    const block = videoBlock('k', assets) as Parameters<typeof videoNeedsConversion>[0]
    assert.equal(videoNeedsConversion(block), false)
    assert.deepEqual(videoConversionState(block?.file?.asset?._ref, block?.conversion), {kind: 'ready'})
  })
})

describe('pageSitePath', () => {
  const page = (type: string) => ({id: 1, type}) as WagtailPage
  it('maps Wagtail page types to the Next.js routes', () => {
    assert.equal(pageSitePath(page('blog.BlogPage'), 'x'), '/blog/x')
    assert.equal(pageSitePath(page('blog.ProjectPage'), 'x'), '/projects/x')
    assert.equal(pageSitePath(page('flex.FlexPage'), 'x'), '/flex/x')
    assert.equal(pageSitePath(page('home.HomePage'), 'home'), '/')
    assert.throws(() => pageSitePath(page('wagtailcore.Page'), 'root'))
  })
})

describe('MIGRATION_ID_PATTERN', () => {
  it('matches only ids this migration creates', () => {
    for (const id of ['homePage', 'drafts.blogPost-17', 'project-5', 'medium-3d-printing', 'technology-nextjs', 'redirect-1', 'mux-video-29', 'person-1']) {
      assert.match(id, MIGRATION_ID_PATTERN)
    }
    for (const id of ['secrets.mux', 'image-abc-1x1-jpg', 'testimonial-function-check', '0c6f1e1e-2b1c-4c4f-9a43-1f0e1c2b3d4e', 'drafts.homePage2', 'versions.r1.project-5']) {
      assert.doesNotMatch(id, MIGRATION_ID_PATTERN)
    }
  })
})

describe('wagtailTagOrder', () => {
  it('orders tag names like the old site (database collation, case-insensitive)', () => {
    // Live API, page 43: "cricut" before "Fusion 360"; the export had Python's codepoint order.
    assert.deepEqual(wagtailTagOrder(['Fusion 360', 'cricut']), ['cricut', 'Fusion 360'])
    // Live API, page 6: the through-table order (OpenCV, Python, Django, Raspberry Pi) is not used.
    assert.deepEqual(wagtailTagOrder(['OpenCV', 'Python', 'Django', 'Raspberry Pi']), ['Django', 'OpenCV', 'Python', 'Raspberry Pi'])
    assert.deepEqual(wagtailTagOrder(['React Native', 'Redux Toolkit', 'SWR', 'UI Kitten', 'Web Views'].reverse()), [
      'React Native',
      'Redux Toolkit',
      'SWR',
      'UI Kitten',
      'Web Views',
    ])
    assert.deepEqual(wagtailTagOrder(['web', 'Web']), ['Web', 'web'], 'names equal ignoring case keep codepoint order')
  })
})

describe('LINK_HREF_FIXES', () => {
  it('only corrects the listed link in the listed block', () => {
    const fix = LINK_HREF_FIXES[0]!
    assert.equal(linkHrefFix(fix.pageId, fix.blockId, fix.from), fix)
    assert.equal(linkHrefFix(fix.pageId, fix.blockId, fix.to), undefined)
    assert.equal(linkHrefFix(fix.pageId + 1, fix.blockId, fix.from), undefined)
    assert.equal(linkHrefFix(fix.pageId, 'another-block', fix.from), undefined)
    for (const f of LINK_HREF_FIXES) assert.match(f.to, /^https:\/\//)
  })
})
