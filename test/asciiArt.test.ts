import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAsciiArt, type AsciiArt } from '../app/components/Testimonial/asciiArt.ts'

/** Serializes parsed art the way the generator writes it, to prove nothing is lost. */
function serialize(art: AsciiArt): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = art.pieces
    .map((piece) => (piece.type === 'char' ? `<span style="color: ${piece.color}">${escape(piece.text)}</span>` : piece.type === 'br' ? '<br/>' : piece.text))
    .join('')
  return `${art.leading}${art.wrapped ? `<span>${body}</span>` : body}${art.trailing}`
}

// The generator's markup (studio/functions/testimonial-ascii-art/generate.ts renderAsciiArtHtml):
// a wrapping span, one element per line indented by two spaces, <br/> between rows.
const GENERATED =
  '<span>\n' +
  '  <span style="color: #373737">:</span>\n' +
  '  <span style="color: #3c3c3e">&gt;</span>\n' +
  '  <br/>\n' +
  '  <span style="color: #dad3dc">&amp;</span>\n' +
  '  <span style="color: #3d3b3d">&lt;</span>\n' +
  '  <span style="color: #39393a">"</span>\n' +
  '</span>\n'

describe('parseAsciiArt', () => {
  it('parses generated art into characters, line breaks and whitespace, losing nothing', () => {
    const result = parseAsciiArt(GENERATED)
    assert.ok(result.ok)
    const { art } = result
    assert.equal(art.wrapped, true)
    assert.equal(art.trailing, '\n')
    assert.deepEqual(
      art.pieces.filter((p) => p.type !== 'space'),
      [
        { type: 'char', color: '#373737', text: ':' },
        { type: 'char', color: '#3c3c3e', text: '>' },
        { type: 'br' },
        { type: 'char', color: '#dad3dc', text: '&' },
        { type: 'char', color: '#3d3b3d', text: '<' },
        { type: 'char', color: '#39393a', text: '"' },
      ],
    )
    assert.equal(serialize(art), GENERATED)
  })

  it('accepts a single character without a wrapper and an empty value', () => {
    const single = parseAsciiArt('<span style="color: #abcdef">Q</span>\n')
    assert.ok(single.ok)
    assert.equal(single.art.wrapped, false)
    assert.equal(serialize(single.art), '<span style="color: #abcdef">Q</span>\n')
    const empty = parseAsciiArt('')
    assert.ok(empty.ok)
    assert.deepEqual(empty.art.pieces, [])
  })

  it('rejects anything that is not generated art markup', () => {
    const attacks = [
      '<span><script>alert(1)</script></span>',
      '<img src=x onerror=alert(1)>',
      '<span style="color: #373737" onmouseover="alert(1)">x</span>',
      '<span style="color: #373737; background: url(https://evil.example/)">x</span>',
      '<span style="color: red">x</span>',
      '<span><span>x</span></span>',
      '<span style="color: #373737"><b>x</b></span>',
      '<span style="color: #373737">&#x3C;script&#x3E;</span>',
      '<span style="color: #373737">x</span><a href="javascript:alert(1)">y</a>',
      '<span style="color: #373737">x',
      'plain text',
      '<br/><iframe src="https://evil.example/"></iframe>',
    ]
    for (const html of attacks) {
      const result = parseAsciiArt(html)
      assert.equal(result.ok, false, html)
      if (!result.ok) assert.match(result.reason, /unexpected markup at character \d+/)
    }
  })
})
