/**
 * Parity tests for the ascii-magic 2.3.0 / Pillow / lxml port. Every expected value comes from
 * the real Python libraries (test/fixtures/make_fixtures.py), not from this code.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, it} from 'node:test'

import {PNG} from 'pngjs'

import {
  applyBrightnessFloor,
  asciiArtFromRgb,
  asciiArtSourceUrl,
  asciiGridSize,
  brightnessFloor,
  CHARS_BY_DENSITY,
  charIndexForLuma,
  generateAsciiArtForSanityImage,
  hexComponent,
  MAX_SOURCE_EDGE,
  parseImageAssetId,
  pillowLuma,
  renderAsciiArtHtml,
  rgbaToRgb,
  UnsupportedImageError,
} from '../generate'
import {pillowResizeBicubic} from '../pillow-resample'

interface Tables {
  chars: string
  hexComponent: number[]
  charIndexByLuma: number[]
  floor: number[]
  luma: [number, number, number, number][]
  grids: [number, number, number, number, number, number][]
  synthetic: {columns: number; rows: number; rgb: string; html: string}[]
  zeroRows: {width: number; height: number; grid: [number, number]; html: string}
  resample: {
    width: number
    height: number
    outWidth: number
    outHeight: number
    kind: string
    rgb: string
    expected: string
  }[]
  endToEnd: {assetId: string; png: string; html: string}
}

interface PythonRender {
  testimonialId: number
  file: string
  width: number
  height: number
  columns: number
  rows: number
  resizedRgb: string
  html: string
}

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T
const tables = fixture<Tables>('python-tables.json')
const renders = fixture<PythonRender[]>('python-renders.json')
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))

describe('character ramp', () => {
  it('is ascii_magic.CHARS_BY_DENSITY', () => {
    assert.equal(CHARS_BY_DENSITY, tables.chars)
    assert.equal(CHARS_BY_DENSITY.length, 94)
  })

  it('maps every luma value to the same ramp index as Python', () => {
    for (let l = 0; l < 256; l++)
      assert.equal(charIndexForLuma(l), tables.charIndexByLuma[l], `luma ${l}`)
    assert.equal(CHARS_BY_DENSITY[charIndexForLuma(0)], ' ')
    assert.equal(CHARS_BY_DENSITY[charIndexForLuma(255)], 'Q')
    // The darkest value after the brightness floor (8, 8, 8) is a backtick, never a blank.
    assert.equal(CHARS_BY_DENSITY[charIndexForLuma(pillowLuma(8, 8, 8))], '`')
  })

  it("uses Pillow's RGB -> L conversion", () => {
    for (const [r, g, b, l] of tables.luma)
      assert.equal(pillowLuma(r, g, b), l, `rgb(${r}, ${g}, ${b})`)
  })
})

describe('colors and brightness floor', () => {
  it('formats every channel value like int(((v / 255) ** 2.2) * 200 + 55)', () => {
    for (let v = 0; v < 256; v++)
      assert.equal(hexComponent(v), tables.hexComponent[v], `value ${v}`)
  })

  it('floors like lambda p: 8 + p * 247 // 255', () => {
    for (let v = 0; v < 256; v++) assert.equal(brightnessFloor(v), tables.floor[v], `value ${v}`)
    const f = tables.floor
    const rgba = new Uint8Array([0, 128, 255, 0, 255, 0, 3, 77])
    // Alpha (every 4th value) is left untouched.
    assert.deepEqual(
      [...applyBrightnessFloor(rgba, 4)],
      [f[0], f[128], f[255], 0, f[255], f[0], f[3], 77],
    )
    assert.deepEqual([...applyBrightnessFloor([0, 1, 2], 3)], [f[0], f[1], f[2]])
  })
})

describe('grid size', () => {
  it('matches the Python formula for every fixture case', () => {
    const columnsSeen = new Set<string>()
    for (const [w, h, columns, ratio, expectedColumns, expectedRows] of tables.grids) {
      const grid = asciiGridSize(w, h, columns, ratio)
      assert.deepEqual(
        grid,
        {columns: expectedColumns, rows: expectedRows},
        `${w}x${h} columns=${columns} ratio=${ratio}`,
      )
      columnsSeen.add(`${columns}->${expectedColumns}`)
    }
    // The fixture includes widths where float rounding drops a column; make sure they are covered.
    assert.ok(columnsSeen.has('35->34'), 'fixture covers a 34-column result')
    assert.ok(columnsSeen.has('120->119'), 'fixture covers a 119-column result')
  })

  it('gives 35x15 for the square testimonial photos', () => {
    for (const size of [259, 347, 389, 400, 500, 800])
      assert.deepEqual(asciiGridSize(size, size), {columns: 35, rows: 15})
  })

  it('returns zero rows for very wide images, which Python rendered as an empty string', () => {
    const {width, height, grid, html} = tables.zeroRows
    assert.deepEqual(asciiGridSize(width, height), {columns: grid[0], rows: grid[1]})
    assert.equal(grid[1], 0)
    assert.equal(html, '')
    assert.equal(renderAsciiArtHtml([], grid[0], 0, 3), '')
  })

  it('rejects invalid sizes', () => {
    assert.throws(() => asciiGridSize(0, 10), RangeError)
    assert.throws(() => asciiGridSize(10.5, 10), RangeError)
  })
})

describe('Pillow bicubic resize', () => {
  for (const c of tables.resample) {
    it(`${c.kind} ${c.width}x${c.height} -> ${c.outWidth}x${c.outHeight} is byte-identical`, () => {
      const out = pillowResizeBicubic(bytes(c.rgb), c.width, c.height, c.outWidth, c.outHeight)
      assert.deepEqual(Buffer.from(out), Buffer.from(c.expected, 'base64'))
    })
  }

  it('returns a copy when the size does not change', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6])
    const out = pillowResizeBicubic(input, 2, 1, 2, 1)
    assert.deepEqual(out, input)
    assert.notEqual(out, input)
  })
})

describe('HTML markup', () => {
  for (const r of renders) {
    it(`reproduces the live Django HTML for testimonial ${r.testimonialId} (${r.file}) from the same pixels`, () => {
      assert.equal(renderAsciiArtHtml(bytes(r.resizedRgb), r.columns, r.rows, 3), r.html)
    })
  }

  for (const s of tables.synthetic) {
    it(`matches ascii-magic + lxml for a synthetic ${s.columns}x${s.rows} grid`, () => {
      assert.equal(renderAsciiArtHtml(bytes(s.rgb), s.columns, s.rows, 3), s.html)
    })
  }

  it('has the lxml pretty-print structure', () => {
    const html = renders[0].html
    const lines = html.split('\n')
    assert.equal(lines[0], '<span>')
    assert.equal(lines.at(-2), '</span>')
    assert.equal(lines.at(-1), '')
    const body = lines.slice(1, -2)
    assert.equal(body.filter((line) => line === '  <br/>').length, 14)
    const cells = body.filter((line) => line !== '  <br/>')
    assert.equal(cells.length, 35 * 15)
    for (const line of cells)
      assert.match(line, /^ {2}<span style="color: #[0-9a-f]{6}">([^<>&]|&amp;|&lt;|&gt;)<\/span>$/)
  })

  it('escapes &, < and > like lxml and leaves quotes and backslashes alone', () => {
    // Choose gray levels whose ramp characters are & < > " ' and \.
    const want = ['&', '<', '>', '"', "'", '\\']
    const pixels: number[] = []
    for (const char of want) {
      const luma = [...Array(256).keys()].find(
        (l) => CHARS_BY_DENSITY[charIndexForLuma(l)] === char,
      )
      assert.notEqual(luma, undefined, `a gray level maps to ${char}`)
      pixels.push(luma!, luma!, luma!)
    }
    const html = renderAsciiArtHtml(pixels, want.length, 1, 3)
    const texts = [...html.matchAll(/">(.*?)<\/span>/g)].map((m) => m[1])
    assert.deepEqual(texts, ['&amp;', '&lt;', '&gt;', '"', "'", '\\'])
  })

  it('returns the single element for a 1x1 grid, like lxml.html.fromstring', () => {
    assert.equal(
      renderAsciiArtHtml([255, 255, 255], 1, 1, 3),
      '<span style="color: #ffffff">Q</span>\n',
    )
  })

  it('ignores alpha', () => {
    const rgb = bytes(renders[0].resizedRgb)
    const rgba = new Uint8Array((rgb.length / 3) * 4)
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4)
      rgba.set([rgb[i], rgb[i + 1], rgb[i + 2], (i * 7) % 256], j)
    assert.equal(renderAsciiArtHtml(rgba, 35, 15, 4), renders[0].html)
    assert.deepEqual(rgbaToRgb(rgba), rgb)
  })

  it('rejects a pixel buffer of the wrong size', () => {
    assert.throws(() => renderAsciiArtHtml([0, 0, 0], 2, 1, 3), RangeError)
  })
})

describe('Sanity asset helpers', () => {
  it('parses image asset ids', () => {
    assert.deepEqual(
      parseImageAssetId('image-d714fbd6a17489c669e8612ce051b011ea1145f6-800x800-jpg'),
      {
        hash: 'd714fbd6a17489c669e8612ce051b011ea1145f6',
        width: 800,
        height: 800,
        format: 'jpg',
      },
    )
    assert.throws(() => parseImageAssetId('file-abc-pdf'))
    assert.throws(() => parseImageAssetId('image-abc-800-jpg'))
  })

  it('requests the full-size PNG up to MAX_SOURCE_EDGE and a CDN-scaled one above it', () => {
    const base = {projectId: 'j3vdh6ti', dataset: 'staging'}
    assert.deepEqual(
      asciiArtSourceUrl({...base, assetId: `image-abc123-${MAX_SOURCE_EDGE}x10-jpg`}),
      {
        url: `https://cdn.sanity.io/images/j3vdh6ti/staging/abc123-${MAX_SOURCE_EDGE}x10.jpg?fm=png`,
        fullSize: true,
      },
    )
    assert.deepEqual(asciiArtSourceUrl({...base, assetId: 'image-abc123-4032x3024-jpg'}), {
      url: `https://cdn.sanity.io/images/j3vdh6ti/staging/abc123-4032x3024.jpg?w=${MAX_SOURCE_EDGE}&fit=max&fm=png`,
      fullSize: false,
    })
    assert.deepEqual(asciiArtSourceUrl({...base, assetId: 'image-abc123-3024x4032-jpg'}), {
      url: `https://cdn.sanity.io/images/j3vdh6ti/staging/abc123-3024x4032.jpg?h=${MAX_SOURCE_EDGE}&fit=max&fm=png`,
      fullSize: false,
    })
    assert.throws(() =>
      asciiArtSourceUrl({projectId: 'bad/id', dataset: 'staging', assetId: 'image-abc-1x1-png'}),
    )
  })

  it('runs the Django pipeline on full-resolution pixels (floor, Pillow resize, render)', () => {
    const png = PNG.sync.read(Buffer.from(tables.endToEnd.png, 'base64'))
    const html = asciiArtFromRgb(
      rgbaToRgb(png.data),
      png.width,
      png.height,
      asciiGridSize(png.width, png.height),
    )
    assert.equal(html, tables.endToEnd.html)
  })
})

describe('generateAsciiArtForSanityImage', () => {
  const pngBody = Buffer.from(tables.endToEnd.png, 'base64')
  const options = {projectId: 'j3vdh6ti', dataset: 'staging', assetId: tables.endToEnd.assetId}

  function stubFetch(responses: (() => Response)[]) {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      const next = responses.shift()
      if (!next) throw new Error('unexpected extra fetch')
      return next()
    }) as typeof fetch
    return {fetchImpl, calls}
  }
  const png = () => new Response(pngBody, {status: 200, headers: {'content-type': 'image/png'}})

  it('produces the Django HTML end to end from a CDN PNG', async () => {
    const {fetchImpl, calls} = stubFetch([png])
    const result = await generateAsciiArtForSanityImage({...options, fetch: fetchImpl})
    assert.equal(result.html, tables.endToEnd.html)
    assert.deepEqual(calls, [
      `https://cdn.sanity.io/images/j3vdh6ti/staging/${'0'.repeat(40)}-120x120.png?fm=png`,
    ])
    assert.equal(result.fullSize, true)
    assert.deepEqual([result.columns, result.rows], [35, 15])
  })

  it('retries transient CDN failures', async () => {
    const {fetchImpl, calls} = stubFetch([() => new Response('busy', {status: 503}), png])
    const result = await generateAsciiArtForSanityImage({...options, fetch: fetchImpl})
    assert.equal(result.html, tables.endToEnd.html)
    assert.equal(calls.length, 2)
  })

  it('gives up after the configured attempts', async () => {
    const {fetchImpl} = stubFetch([
      () => new Response('', {status: 502}),
      () => new Response('', {status: 502}),
    ])
    await assert.rejects(
      generateAsciiArtForSanityImage({...options, fetch: fetchImpl, attempts: 2}),
      (error: Error) => {
        assert.ok(!(error instanceof UnsupportedImageError))
        assert.match(error.message, /after 2 attempts/)
        return true
      },
    )
  })

  it('reports a non-PNG answer as an unsupported image', async () => {
    const {fetchImpl} = stubFetch([
      () => new Response('<svg/>', {status: 200, headers: {'content-type': 'image/svg+xml'}}),
    ])
    await assert.rejects(
      generateAsciiArtForSanityImage({...options, fetch: fetchImpl}),
      UnsupportedImageError,
    )
  })

  it('treats a missing asset as an error, not as an unsupported image', async () => {
    const {fetchImpl} = stubFetch([() => new Response('not found', {status: 404})])
    await assert.rejects(
      generateAsciiArtForSanityImage({...options, fetch: fetchImpl}),
      (error: Error) => {
        assert.ok(!(error instanceof UnsupportedImageError))
        assert.match(error.message, /HTTP 404/)
        return true
      },
    )
  })

  it('refuses a full-size answer with unexpected dimensions', async () => {
    const {fetchImpl} = stubFetch([png])
    await assert.rejects(
      generateAsciiArtForSanityImage({
        ...options,
        assetId: `image-${'0'.repeat(40)}-240x240-png`,
        fetch: fetchImpl,
      }),
      /expected the original 240x240/,
    )
  })

  it('returns "" without fetching for a zero-row grid', async () => {
    const {fetchImpl, calls} = stubFetch([])
    const result = await generateAsciiArtForSanityImage({
      ...options,
      assetId: 'image-abc-2000x10-jpg',
      fetch: fetchImpl,
    })
    assert.deepEqual(result, {html: '', columns: 35, rows: 0, url: null, fullSize: true})
    assert.equal(calls.length, 0)
  })
})
