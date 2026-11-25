import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {MIGRATION_ID_PATTERN} from '../src/steps/import'
import {flattenLinkText, pageSitePath, withArrayKeys} from '../src/transform/documents'
import type {WagtailPage} from '../src/wagtail'

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

describe('withArrayKeys', () => {
  it('uses unique ids as keys and indexes otherwise, deterministically', () => {
    const asset = {tracks: [{id: 'a', type: 'video'}, {id: 'b', type: 'audio'}], files: [{name: 'x'}, {name: 'y'}], meta: {n: 1}}
    const keyed = withArrayKeys(asset)
    assert.deepEqual((keyed.tracks as unknown as {_key: string}[]).map((t) => t._key), ['a', 'b'])
    assert.deepEqual((keyed.files as unknown as {_key: string}[]).map((f) => f._key), ['i0', 'i1'])
    assert.deepEqual(withArrayKeys(asset), keyed)
    assert.equal('_key' in asset.tracks[0]!, false, 'input is not modified')
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
