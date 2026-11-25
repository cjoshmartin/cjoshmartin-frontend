/**
 * Real-pipeline comparison of the TypeScript generator against the Django/Python output.
 *
 * For each of the testimonial photos in test/fixtures/python-renders.json it
 *  1. reads the original file and checks its SHA-1 against the Wagtail export's file_hash,
 *  2. uploads it as an image asset to the given dataset (content-addressed, so re-running or
 *     a later migration upload reuses the same asset) and checks the asset's sha1hash,
 *  3. generates the ASCII art through the Sanity image CDN (generateAsciiArtForSanityImage),
 *  4. compares it with the Python HTML: grid size, characters within +-1 ramp step,
 *     mean per-channel color difference, and the resized pixels themselves.
 * For reference it also measures the rejected first approach, where the CDN itself scales the
 * photo to the grid size (`w=<columns>&h=<rows>&fit=scale&fm=png`).
 * It writes a JSON metrics file and a self-contained HTML report with old and new side by side,
 * and exits non-zero if any image misses a threshold with the final pipeline.
 *
 * Usage (from this function's directory, with the Editor token in the environment):
 *   SANITY_PROJECT_ID=... SANITY_WRITE_TOKEN=... npx tsx scripts/compare-with-python.ts \
 *     --dataset staging --originals <dir> --wagtail-export <export.json> \
 *     --metrics <out.json> --report <out.html>
 */
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {parseArgs} from 'node:util'

import {createClient} from '@sanity/client'
import {PNG} from 'pngjs'

import {
  applyBrightnessFloor,
  asciiArtSourceUrl,
  asciiGridSize,
  generateAsciiArtForSanityImage,
  parseImageAssetId,
  renderAsciiArtHtml,
  rgbaToRgb,
} from '../generate'
import {pillowResizeBicubic} from '../pillow-resample'
import {type ArtComparison, compareArt, parseArt} from './art-metrics'

const THRESHOLD_WITHIN_ONE = 0.9
const THRESHOLD_MEAN_COLOR_DIFF = 20

interface PythonRender {
  testimonialId: number
  file: string
  sourceUrl: string
  width: number
  height: number
  columns: number
  rows: number
  resizedRgb: string
  html: string
}

interface ApproachMetrics extends ArtComparison {
  /** Mean absolute difference of the resized, floored pixels vs Pillow's (0-255 units). */
  resizedPixelMae: number
  identicalHtml: boolean
  pass: boolean
}

interface ImageMetrics {
  testimonialId: number
  file: string
  width: number
  height: number
  assetId: string
  sourceUrl: string
  final: ApproachMetrics
  rejectedCdnGrid: ApproachMetrics & {url: string}
}

async function fetchPng(url: string): Promise<PNG> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return PNG.sync.read(Buffer.from(await response.arrayBuffer()))
}

function pixelMae(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length)
    throw new Error(`pixel buffers differ in length: ${a.length} vs ${b.length}`)
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

function judge(comparison: ArtComparison): boolean {
  return (
    comparison.sameGrid &&
    comparison.withinOneStep >= THRESHOLD_WITHIN_ONE &&
    comparison.meanColorDiff < THRESHOLD_MEAN_COLOR_DIFF
  )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const num = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a')

function metricsRow(m: ImageMetrics, a: ApproachMetrics): string {
  return `<tr class="${a.pass ? 'ok' : 'fail'}">
  <td>${m.testimonialId}</td><td><code>${escapeHtml(m.file)}</code></td><td>${m.width}×${m.height}</td>
  <td>${a.oldGrid}</td><td>${a.newGrid}</td>
  <td>${pct(a.exactChars)}</td><td>${pct(a.withinOneStep)}</td>
  <td>${num(a.meanRampDistance)}</td><td>${a.maxRampDistance}</td>
  <td>${num(a.meanColorDiff)}</td><td>${a.maxColorDiff}</td>
  <td>${num(a.resizedPixelMae)}</td><td>${a.identicalHtml ? 'yes' : 'no'}</td>
  <td>${a.pass ? 'pass' : 'FAIL'}</td></tr>`
}

const TABLE_HEAD = `<thead><tr><th>ID</th><th>File</th><th>Source</th><th>Old grid</th><th>New grid</th><th>Exact chars</th><th>Within ±1</th><th>Mean ramp Δ</th><th>Max ramp Δ</th><th>Mean color Δ</th><th>Max color Δ</th><th>Pixel MAE</th><th>Identical HTML</th><th>Result</th></tr></thead>`

function reportHtml(
  metrics: ImageMetrics[],
  art: Map<number, {old: string; final: string; rejected: string}>,
  meta: {dataset: string; generatedAt: string; projectId: string},
): string {
  const allPass = metrics.every((m) => m.final.pass)
  const identical = metrics.filter((m) => m.final.identicalHtml).length
  const cards = metrics
    .map((m) => {
      const a = art.get(m.testimonialId)!
      const {hash, width, height, format} = parseImageAssetId(m.assetId)
      const thumb = `https://cdn.sanity.io/images/${meta.projectId}/${meta.dataset}/${hash}-${width}x${height}.${format}?w=400&h=400&fit=crop&auto=format`
      return `<section class="card">
  <h3>Testimonial ${m.testimonialId} <small><code>${escapeHtml(m.file)}</code> · ${m.width}×${m.height} · ${m.final.identicalHtml ? 'identical HTML' : `within ±1: ${pct(m.final.withinOneStep)}, mean color Δ ${num(m.final.meanColorDiff)}`}</small></h3>
  <div class="row">
    <figure><div class="frame photo"><img src="${thumb}" alt="Original photo for testimonial ${m.testimonialId}" width="196" height="192" loading="lazy"></div><figcaption>Original photo</figcaption></figure>
    <figure><div class="frame art">${a.old}</div><figcaption>Old: Django + ascii-magic (live API)</figcaption></figure>
    <figure><div class="frame art">${a.final}</div><figcaption>New: generate.ts via Sanity CDN</figcaption></figure>
    <figure class="rejected"><div class="frame art">${a.rejected}</div><figcaption>Rejected: CDN scales to grid (±1: ${pct(m.rejectedCdnGrid.withinOneStep)})</figcaption></figure>
  </div>
</section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Testimonial ASCII comparison</title>
<style>
  :root { --bg: #f6f6f4; --fg: #1d1d1b; --muted: #66665f; --line: #d9d9d3; --ok: #1f7a3a; --bad: #b3261e; --card: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --fg: #ececea; --muted: #a3a39c; --line: #34342f; --ok: #5cc27a; --bad: #ff8a80; --card: #1d1d1b; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  p { max-width: 75ch; }
  p.lede { color: var(--muted); margin: 0 0 1.5rem; }
  .verdict { display: inline-block; padding: .2rem .6rem; border-radius: 999px; font-weight: 600; border: 1px solid currentColor; }
  .verdict.ok { color: var(--ok); } .verdict.fail { color: var(--bad); }
  .table-wrap { overflow-x: auto; margin: .5rem 0 1rem; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px; }
  th, td { padding: .4rem .5rem; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  th:nth-child(2), td:nth-child(2) { text-align: left; }
  tr.ok td:last-child { color: var(--ok); font-weight: 600; } tr.fail td:last-child { color: var(--bad); font-weight: 600; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 16px; }
  .card h3 { margin: 0 0 12px; font-size: 1rem; } .card h3 small { color: var(--muted); font-weight: 400; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; }
  figure { margin: 0; } figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; max-width: 208px; }
  .rejected { opacity: .8; }
  /* Same box and type settings as app/components/Testimonial/Testimonial.module.css (.imageWrapper + .image). */
  .frame { width: 208px; height: 200px; border-width: 4px 6px; border-color: black; border-style: solid; background-color: black; overflow: hidden; }
  .art { font-size: 8px; letter-spacing: -2px; text-wrap: nowrap; white-space: nowrap; line-height: normal; color: white; }
  .photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
  code { font-size: .92em; }
  ul.notes { color: var(--muted); max-width: 80ch; }
</style>
</head>
<body>
<main>
<h1>Testimonial ASCII art: Python vs TypeScript</h1>
<p class="lede">Old: the HTML the Django backend serves today (ascii-magic 2.3.0, Pillow bicubic resize, lxml pretty print), from the live API snapshot.
New: <code>studio/functions/testimonial-ascii-art/generate.ts</code> run on the same nine files uploaded to the <code>${escapeHtml(meta.dataset)}</code> dataset, reading pixels from the Sanity image CDN.
Generated ${escapeHtml(meta.generatedAt)}.</p>
<p><span class="verdict ${allPass ? 'ok' : 'fail'}">${allPass ? `All ${metrics.length} pass` : 'Some images fail'}</span>
&nbsp;${identical} of ${metrics.length} byte-identical. Thresholds: same grid, at least ${pct(THRESHOLD_WITHIN_ONE)} of characters within ±1 ramp step, mean per-channel color difference below ${THRESHOLD_MEAN_COLOR_DIFF}.</p>

<h2>Final pipeline</h2>
<p>Lossless full-size PNG from the CDN (<code>?fm=png</code>), brightness floor, exact port of Pillow's bicubic resize, exact port of ascii-magic's HTML and lxml's formatting.</p>
<div class="table-wrap"><table>${TABLE_HEAD}<tbody>
${metrics.map((m) => metricsRow(m, m.final)).join('\n')}
</tbody></table></div>

<h2>Rejected first approach: CDN scales to the grid</h2>
<p>Same renderer, but the CDN resizes straight to the grid (<code>?w=35&amp;h=15&amp;fit=scale&amp;fm=png</code>) and the floor is applied afterwards. The CDN's resampler is not Pillow's bicubic filter (closest to Pillow's Lanczos on the 800 px photos), so on the smaller photos a third of the characters move by more than one step.</p>
<div class="table-wrap"><table>${TABLE_HEAD}<tbody>
${metrics.map((m) => metricsRow(m, m.rejectedCdnGrid)).join('\n')}
</tbody></table></div>
<ul class="notes">
<li>Color Δ is measured on the emitted <code>#rrggbb</code> values (0 to 255 per channel). Ramp Δ is the distance between characters on ascii-magic's 94-character density ramp; the ramp contains <code>)</code> twice, and the closer slot is used.</li>
<li>Pixel MAE compares the scaled pixels after the brightness floor with Pillow's (from <code>test/fixtures/python-renders.json</code>).</li>
</ul>

<h2>Side by side</h2>
${cards}
</main>
</body>
</html>
`
}

async function measureRejectedCdnGrid(
  projectId: string,
  dataset: string,
  assetId: string,
  render: PythonRender,
): Promise<ApproachMetrics & {url: string; html: string}> {
  const {hash, width, height, format} = parseImageAssetId(assetId)
  const {columns, rows} = asciiGridSize(width, height)
  const url = `https://cdn.sanity.io/images/${projectId}/${dataset}/${hash}-${width}x${height}.${format}?w=${columns}&h=${rows}&fit=scale&fm=png`
  const png = await fetchPng(url)
  if (png.width !== columns || png.height !== rows)
    throw new Error(`${url} returned ${png.width}x${png.height}`)
  const resized = applyBrightnessFloor(rgbaToRgb(png.data), 3)
  const html = renderAsciiArtHtml(resized, columns, rows, 3)
  const comparison = compareArt(parseArt(render.html), parseArt(html))
  return {
    ...comparison,
    resizedPixelMae: pixelMae(resized, Buffer.from(render.resizedRgb, 'base64')),
    identicalHtml: html === render.html,
    pass: judge(comparison),
    url,
    html,
  }
}

async function main() {
  const {values} = parseArgs({
    options: {
      dataset: {type: 'string'},
      originals: {type: 'string'},
      'wagtail-export': {type: 'string'},
      metrics: {type: 'string'},
      report: {type: 'string'},
    },
  })
  const projectId = process.env.SANITY_PROJECT_ID
  const token = process.env.SANITY_WRITE_TOKEN
  if (!projectId || !token) throw new Error('SANITY_PROJECT_ID and SANITY_WRITE_TOKEN must be set')
  const {dataset, originals, metrics: metricsPath, report: reportPath} = values
  const exportPath = values['wagtail-export']
  if (!dataset || !originals || !exportPath || !metricsPath || !reportPath) {
    throw new Error('--dataset, --originals, --wagtail-export, --metrics and --report are required')
  }

  const client = createClient({projectId, dataset, token, apiVersion: '2025-02-19', useCdn: false})
  const renders: PythonRender[] = JSON.parse(
    readFileSync(new URL('../test/fixtures/python-renders.json', import.meta.url), 'utf8'),
  )
  const wagtailImages: {file: string; file_hash: string}[] = JSON.parse(
    readFileSync(exportPath, 'utf8'),
  ).images

  const results: ImageMetrics[] = []
  const art = new Map<number, {old: string; final: string; rejected: string}>()
  for (const render of renders) {
    const fileName = `testimonial-${render.testimonialId}-${render.file}`
    const bytes = readFileSync(join(originals, fileName))
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const wagtail = wagtailImages.find((image) => image.file === `original_images/${render.file}`)
    if (!wagtail) throw new Error(`${render.file} is not in the Wagtail export`)
    if (wagtail.file_hash !== sha1)
      throw new Error(`${render.file}: sha1 ${sha1} != Wagtail file_hash ${wagtail.file_hash}`)

    const asset = await client.assets.upload('image', bytes, {filename: render.file})
    if (asset.sha1hash !== sha1)
      throw new Error(`${render.file}: uploaded asset sha1hash ${asset.sha1hash} != ${sha1}`)
    const parsed = parseImageAssetId(asset._id)
    if (parsed.width !== render.width || parsed.height !== render.height) {
      throw new Error(
        `${render.file}: asset is ${parsed.width}x${parsed.height}, Pillow saw ${render.width}x${render.height}`,
      )
    }

    const generated = await generateAsciiArtForSanityImage({projectId, dataset, assetId: asset._id})
    const finalComparison = compareArt(parseArt(render.html), parseArt(generated.html))

    // Recompute the resized pixels of the final pipeline to report the pixel-level difference.
    const {url: sourceUrl} = asciiArtSourceUrl({projectId, dataset, assetId: asset._id})
    const source = await fetchPng(sourceUrl)
    const resized = pillowResizeBicubic(
      applyBrightnessFloor(rgbaToRgb(source.data), 3),
      source.width,
      source.height,
      generated.columns,
      generated.rows,
    )
    if (renderAsciiArtHtml(resized, generated.columns, generated.rows, 3) !== generated.html) {
      throw new Error(
        `${render.file}: recomputed pixels do not reproduce generateAsciiArtForSanityImage's HTML`,
      )
    }

    const rejected = await measureRejectedCdnGrid(projectId, dataset, asset._id, render)
    const {html: rejectedHtml, ...rejectedMetrics} = rejected
    results.push({
      testimonialId: render.testimonialId,
      file: render.file,
      width: render.width,
      height: render.height,
      assetId: asset._id,
      sourceUrl,
      final: {
        ...finalComparison,
        resizedPixelMae: pixelMae(resized, Buffer.from(render.resizedRgb, 'base64')),
        identicalHtml: generated.html === render.html,
        pass: judge(finalComparison),
      },
      rejectedCdnGrid: rejectedMetrics,
    })
    art.set(render.testimonialId, {old: render.html, final: generated.html, rejected: rejectedHtml})
    const m = results[results.length - 1]
    console.log(
      `${m.testimonialId} ${m.file} ${m.assetId}: final grid ${m.final.oldGrid}/${m.final.newGrid} exact ${pct(m.final.exactChars)} ±1 ${pct(m.final.withinOneStep)} colorΔ ${num(m.final.meanColorDiff)} pixelMAE ${num(m.final.resizedPixelMae)} identical ${m.final.identicalHtml} ${m.final.pass ? 'PASS' : 'FAIL'} | rejected CDN-grid ±1 ${pct(m.rejectedCdnGrid.withinOneStep)} ${m.rejectedCdnGrid.pass ? 'pass' : 'fail'}`,
    )
  }

  const generatedAt = new Date().toISOString()
  writeFileSync(
    metricsPath,
    `${JSON.stringify({generatedAt, projectId, dataset, thresholds: {withinOneStep: THRESHOLD_WITHIN_ONE, meanColorDiff: THRESHOLD_MEAN_COLOR_DIFF}, results}, null, 2)}\n`,
  )
  writeFileSync(reportPath, reportHtml(results, art, {dataset, generatedAt, projectId}))
  const failed = results.filter((m) => !m.final.pass)
  if (failed.length > 0) {
    console.error(`${failed.length} image(s) failed the thresholds`)
    process.exitCode = 1
  }
}

await main()
