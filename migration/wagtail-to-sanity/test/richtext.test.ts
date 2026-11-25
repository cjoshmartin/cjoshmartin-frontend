import assert from 'node:assert/strict'
import {before, describe, it} from 'node:test'

import {
  KeyRegistry,
  portableTextPlainText,
  richTextPlainText,
  richTextToBlocks,
  RichTextError,
  sameIgnoringWhitespace,
  type Issue,
  type PTBlock,
  type RichTextContext,
} from '../src/transform/richtext'
import {loadStudioSchema, type StudioSchema} from '../src/transform/schema'

let schema: StudioSchema

before(async () => {
  schema = await loadStudioSchema()
})

function context(issues: Issue[] = []): RichTextContext {
  return {
    record: 'test',
    schema,
    keys: new KeyRegistry('test', issues),
    keyPrefix: '',
    issues,
    image: (id) => ({assetId: `image-${'a'.repeat(40)}-${id}x${id}-jpg`}),
    document: (id) => `file-${'b'.repeat(40)}-stl${id > 0 ? '' : ''}`,
    page: (id) => ({documentId: `blogPost-${id}`, published: id !== 99, type: 'blogPost'}),
  }
}

describe('richTextToBlocks', () => {
  it('keeps Wagtail block keys and derives span and markDef keys from them', () => {
    const out = richTextToBlocks(
      '<h2 data-block-key="0x328">Title <b>bold</b></h2><p data-block-key="abcde">a <a href="https://x.com/?a=1&amp;b=2">link</a></p>',
      context(),
    )
    assert.equal(out.length, 2)
    const [h2, p] = out as PTBlock[]
    assert.equal(h2!._key, '0x328')
    assert.equal(h2!.style, 'h2')
    assert.deepEqual(h2!.children.map((c) => [c._key, c.text, c.marks]), [
      ['0x328s0', 'Title ', []],
      ['0x328s1', 'bold', ['strong']],
    ])
    assert.equal(p!._key, 'abcde')
    assert.deepEqual(p!.markDefs, [{_type: 'link', _key: 'abcdem0', href: 'https://x.com/?a=1&b=2', openInNewTab: false}])
    assert.deepEqual(p!.children[1]!.marks, ['abcdem0'])
  })

  it('turns br into a newline, keeps empty paragraphs and maps lists', () => {
    const out = richTextToBlocks(
      '<p data-block-key="k1">one<br/>two</p><p data-block-key="k2"></p><ol><li data-block-key="l1">a</li><li data-block-key="l2">b<ul><li data-block-key="l3">c</li></ul></li></ol>',
      context(),
    ) as PTBlock[]
    assert.equal(out[0]!.children[0]!.text, 'one\ntwo')
    assert.equal(out[1]!.children[0]!.text, '')
    assert.deepEqual(out.slice(2).map((b) => [b._key, b.listItem, b.level]), [
      ['l1', 'number', 1],
      ['l2', 'number', 1],
      ['l3', 'bullet', 2],
    ])
  })

  it('converts image and media embeds and hr into custom blocks with positional keys', () => {
    const issues: Issue[] = []
    const out = richTextToBlocks(
      '<p data-block-key="k1">x</p><embed embedtype="image" format="left" id="12" alt="Josh&#x27;s printer"/><embed embedtype="media" url="https://www.youtube.com/watch?v=5KB5KAak6tM&amp;ab_channel=SirajRaval"/><hr/><embed embedtype="image" format="fullwidth" id="3" alt=""/>',
      context(issues),
    )
    assert.deepEqual(out[1], {
      _type: 'imageBlock',
      _key: 'n1',
      asset: {_type: 'reference', _ref: `image-${'a'.repeat(40)}-12x12-jpg`},
      alt: "Josh's printer",
      layout: 'left',
    })
    assert.deepEqual(out[2], {_type: 'youtube', _key: 'n2', url: 'https://www.youtube.com/watch?v=5KB5KAak6tM&ab_channel=SirajRaval'})
    assert.deepEqual(out[3], {_type: 'divider', _key: 'n3', style: 'line'})
    assert.equal((out[4] as {alt?: string}).alt, undefined)
    assert.equal(issues.filter((i) => i.code === 'image-without-alt').length, 1)
  })

  it('converts page and document links', () => {
    const out = richTextToBlocks(
      '<p data-block-key="k1"><a linktype="page" id="13">post</a> <a linktype="document" id="2">file</a> <a linktype="page" id="99">draft</a></p>',
      context(),
    ) as PTBlock[]
    assert.deepEqual(out[0]!.markDefs, [
      {_type: 'internalLink', _key: 'k1m0', reference: {_type: 'reference', _ref: 'blogPost-13'}},
      {_type: 'fileLink', _key: 'k1m1', file: {_type: 'file', asset: {_type: 'reference', _ref: `file-${'b'.repeat(40)}-stl`}}},
      {_type: 'internalLink', _key: 'k1m2', reference: {_type: 'reference', _ref: 'blogPost-99', _weak: true, _strengthenOnPublish: {type: 'blogPost'}}},
    ])
  })

  it('maps the other decorators the schema has', () => {
    const out = richTextToBlocks('<p data-block-key="k"><i>i</i><code>c</code><u>u</u><s>s</s><strong><em>se</em></strong></p>', context()) as PTBlock[]
    assert.deepEqual(out[0]!.children.map((c) => c.marks), [['em'], ['code'], ['underline'], ['strike-through'], ['strong', 'em']])
  })

  it('prefixes every block key with the given prefix', () => {
    const ctx = {...context(), keyPrefix: 'dacc8a85-'}
    const out = richTextToBlocks('<p data-block-key="0x328">a</p><hr/>', ctx)
    assert.deepEqual(out.map((b) => b._key), ['dacc8a85-0x328', 'dacc8a85-n1'])
  })

  it('makes keys unique across calls that share a registry', () => {
    const issues: Issue[] = []
    const ctx = context(issues)
    richTextToBlocks('<p data-block-key="same">a</p>', ctx)
    const out = richTextToBlocks('<p data-block-key="same">b</p>', ctx)
    assert.equal(out[0]!._key, 'same-2')
    assert.equal(issues[0]!.code, 'duplicate-key')
  })

  for (const [name, html] of [
    ['unknown element', '<div>x</div>'],
    ['unknown inline element', '<p><span>x</span></p>'],
    ['unknown attribute', '<p class="x">x</p>'],
    ['link with extra attribute', '<p><a href="/x" target="_blank">x</a></p>'],
    ['unknown link type', '<p><a linktype="email" id="1">x</a></p>'],
    ['unknown embed type', '<embed embedtype="video" url="x"/>'],
    ['embed inside a paragraph', '<p><embed embedtype="image" id="1" format="left" alt=""/></p>'],
    ['non-YouTube media embed', '<embed embedtype="media" url="https://vimeo.com/123"/>'],
    ['unknown image format', '<embed embedtype="image" id="1" format="half" alt=""/>'],
    ['text outside a block', 'loose text'],
    ['sup', '<p>x<sup>2</sup></p>'],
    ['list directly in a list', '<ul><li>a</li><ul><li>b</li></ul></ul>'],
  ] as const) {
    it(`fails on ${name}`, () => {
      assert.throws(() => richTextToBlocks(html, context()), RichTextError)
    })
  }
})

describe('plain text', () => {
  it('matches between Wagtail HTML and Portable Text, ignoring whitespace only', () => {
    const html = '<h2 data-block-key="a">Hi  <b>there</b></h2><p data-block-key="b">one<br/>two &amp; &lt;three&gt;</p><ul><li data-block-key="c">x</li></ul><embed embedtype="media" url="https://youtu.be/53LIU9X-8Z0"/>'
    const pt = richTextToBlocks(html, context())
    assert.ok(sameIgnoringWhitespace(richTextPlainText(html), portableTextPlainText(pt)))
    assert.equal(richTextPlainText(html).replace(/\s+/g, ''), 'Hithereonetwo&<three>x')
  })
})
