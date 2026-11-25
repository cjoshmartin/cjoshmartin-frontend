// Builds the parity report from the crawl: parity-results.json, summary.md and index.html
// (old and new screenshots side by side) in the parity directory.
//
// Usage: node src/report.mjs [--dir <parity dir>] [--dataset production]
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { compareRecord, EXPECTED, INFO, SAME, UNEXPECTED } from './compare.mjs'
import { PARITY_DIR, readJson, routeFileName } from './config.mjs'
import { fetchReference } from './sanity-reference.mjs'

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: PARITY_DIR },
    dataset: { type: 'string', default: 'production' },
  },
})

const routesFile = readJson(path.join(args.dir, 'routes.json'))
const reference = await fetchReference(args.dataset)
const records = new Map(
  routesFile.routes.map((route) => {
    const file = path.join(args.dir, 'raw', `${routeFileName(route.path)}.json`)
    if (!fs.existsSync(file)) throw new Error(`No crawl data for ${route.path} (${file}); run src/crawl.mjs first`)
    return [route.path, readJson(file)]
  }),
)
const results = routesFile.routes.map((route) => compareRecord(records.get(route.path), reference, records))

const totals = { [SAME]: 0, [EXPECTED]: 0, [UNEXPECTED]: 0 }
for (const result of results) totals[result.verdict]++
const generatedAt = new Date().toISOString()
fs.writeFileSync(
  path.join(args.dir, 'parity-results.json'),
  JSON.stringify({ generatedAt, old: routesFile.old, new: routesFile.new, dataset: args.dataset, filters: routesFile.filters, totals, results }, null, 1),
)

// ---------- Markdown summary ----------
const short = (value) => {
  if (value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 220 ? text.slice(0, 217) + '...' : text
}
const md = [
  `# Parity crawl: old (${routesFile.old}) vs new (${routesFile.new}, dataset ${args.dataset})`,
  '',
  `Generated ${generatedAt}. ${results.length} routes: ${totals[SAME]} same, ${totals[EXPECTED]} with expected differences only, ${totals[UNEXPECTED]} with unexpected differences.`,
  '',
  '| Route | Kind | Verdict | Unexpected | Expected | Text similarity |',
  '|---|---|---|---|---|---|',
  ...results.map((result) => {
    const text = result.checks.find((item) => item.field === 'visible text')
    const count = (verdict) => result.checks.filter((item) => item.verdict === verdict).map((item) => item.field)
    return `| \`${result.route.path}\` | ${result.route.kind} | ${result.verdict.toUpperCase()} | ${count(UNEXPECTED).join(', ')} | ${count(EXPECTED).join(', ')} | ${text?.ratio ?? ''} |`
  }),
  '',
  '## Differences',
  '',
  ...results.flatMap((result) => {
    const interesting = result.checks.filter((item) => item.verdict === UNEXPECTED || item.verdict === EXPECTED)
    if (!interesting.length) return []
    return [
      `### \`${result.route.path}\``,
      '',
      ...interesting.map((item) => {
        const rest = Object.fromEntries(Object.entries(item).filter(([key]) => !['field', 'verdict', 'reason'].includes(key)))
        return `- **${item.verdict.toUpperCase()}** ${item.field}${item.reason ? `: ${item.reason}` : ''} ${short(rest)}`
      }),
      '',
    ]
  }),
].join('\n')
fs.writeFileSync(path.join(args.dir, 'summary.md'), md)

// ---------- HTML report ----------
const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
const render = (value) => {
  if (value === undefined || value === null || value === '') return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  if (text.length <= 160) return `<code>${escape(text)}</code>`
  return `<details><summary><code>${escape(text.slice(0, 120))}…</code></summary><pre>${escape(text)}</pre></details>`
}
const anchor = (route) => 'r-' + routeFileName(route.path)
const shot = (record, site, viewport) => {
  const file = `shots/${routeFileName(record.route.path)}.${site}.${viewport}.jpg`
  return fs.existsSync(path.join(args.dir, file)) ? file : null
}

const sections = results
  .map((result) => {
    const rows = result.checks
      .map((item) => {
        const { field, verdict, reason, old, new: newValue, ...rest } = item
        const extra = Object.keys(rest).length ? render(rest) : ''
        return `<tr class="v-${verdict}"><td>${escape(field)}</td><td><span class="badge b-${verdict}">${verdict}</span></td><td>${render(old)}</td><td>${render(newValue)}</td><td>${escape(reason ?? '')}${extra}</td></tr>`
      })
      .join('\n')
    const pairs = ['desktop', 'mobile']
      .map((viewport) => {
        const oldShot = shot(result, 'old', viewport)
        const newShot = shot(result, 'new', viewport)
        if (!oldShot && !newShot) return ''
        const pane = (label, file) =>
          `<figure><figcaption>${label}</figcaption><div class="pane">${file ? `<a href="${file}"><img loading="lazy" src="${file}" alt="${escape(label)} screenshot"></a>` : '<p class="muted">no screenshot</p>'}</div></figure>`
        return `<div class="pair ${viewport}"><h4>${viewport === 'desktop' ? '1440 px' : '390 px'}</h4><div class="panes">${pane('Old (Wagtail)', oldShot)}${pane('New (Sanity)', newShot)}</div></div>`
      })
      .join('\n')
    return `<section id="${anchor(result.route)}">
<h2><span class="badge b-${result.verdict}">${result.verdict}</span> <code>${escape(result.route.path)}</code> <small>${escape(result.route.kind)}</small></h2>
<table class="checks"><thead><tr><th>Check</th><th>Verdict</th><th>Old</th><th>New</th><th>Reason / details</th></tr></thead><tbody>${rows}</tbody></table>
${pairs}
</section>`
  })
  .join('\n')

const index = results
  .map((result) => {
    const count = (verdict) => result.checks.filter((item) => item.verdict === verdict).length
    const text = result.checks.find((item) => item.field === 'visible text')
    return `<tr class="v-${result.verdict}"><td><a href="#${anchor(result.route)}"><code>${escape(result.route.path)}</code></a></td><td>${escape(result.route.kind)}</td><td><span class="badge b-${result.verdict}">${result.verdict}</span></td><td>${count(UNEXPECTED)}</td><td>${count(EXPECTED)}</td><td>${text?.ratio ?? ''}</td></tr>`
  })
  .join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parity Report</title>
<style>
:root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #deded8; --panel: #ffffff;
  --same: #2f7d4f; --expected: #8a6a12; --unexpected: #b3261e; --info: #3b5f9a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #161615; --fg: #ececea; --muted: #a2a29c; --line: #34342f; --panel: #1e1e1c;
  --same: #6cc28f; --expected: #e0b84f; --unexpected: #f2847b; --info: #8fb0e6; } }
:root[data-theme="dark"] { --bg: #161615; --fg: #ececea; --muted: #a2a29c; --line: #34342f; --panel: #1e1e1c;
  --same: #6cc28f; --expected: #e0b84f; --unexpected: #f2847b; --info: #8fb0e6; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
main { max-width: 1600px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 40px 0 8px; } h4 { margin: 16px 0 6px; font-size: 13px; color: var(--muted); }
small, .muted { color: var(--muted); }
code { font: 12px/1.4 ui-monospace, Menlo, monospace; word-break: break-word; }
pre { white-space: pre-wrap; max-height: 320px; overflow: auto; font-size: 11px; }
table { border-collapse: collapse; width: 100%; background: var(--panel); }
th, td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; }
.checks td:nth-child(3), .checks td:nth-child(4) { max-width: 360px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; font-weight: 600; text-transform: uppercase; border: 1px solid currentColor; }
.b-same { color: var(--same); } .b-expected { color: var(--expected); } .b-unexpected { color: var(--unexpected); } .b-info { color: var(--info); }
.checks tr.v-same { opacity: .7; }
.panes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.mobile .panes { max-width: 820px; }
figure { margin: 0; } figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.pane { height: 720px; overflow: auto; border: 1px solid var(--line); background: #000; }
.pane img { display: block; width: 100%; height: auto; }
.wrap { overflow-x: auto; }
@media (max-width: 700px) { .panes { grid-template-columns: 1fr; } .pane { height: 480px; } }
</style>
</head>
<body>
<main>
<h1>Parity report: Wagtail site vs Sanity build</h1>
<p class="muted">Old: <code>${escape(routesFile.old)}</code> · New: <code>${escape(routesFile.new)}</code> (dataset <code>${escape(args.dataset)}</code>) · generated ${escape(generatedAt)} · filters medium=<code>${escape(routesFile.filters.medium)}</code>, technologies=<code>${escape(routesFile.filters.technology)}</code></p>
<p>${results.length} routes: <span class="badge b-same">${totals[SAME]} same</span> <span class="badge b-expected">${totals[EXPECTED]} expected only</span> <span class="badge b-unexpected">${totals[UNEXPECTED]} unexpected</span>. Checks marked <span class="badge b-info">info</span> are third-party noise or behaviour shared with the old site.</p>
<div class="wrap"><table><thead><tr><th>Route</th><th>Kind</th><th>Verdict</th><th>Unexpected</th><th>Expected</th><th>Text similarity</th></tr></thead><tbody>${index}</tbody></table></div>
${sections}
</main>
<script>
// Scroll the old and new panes of a pair together.
for (const pair of document.querySelectorAll('.panes')) {
  const panes = pair.querySelectorAll('.pane')
  if (panes.length !== 2) continue
  let syncing = false
  for (const [a, b] of [[panes[0], panes[1]], [panes[1], panes[0]]]) {
    a.addEventListener('scroll', () => {
      if (syncing) { syncing = false; return }
      syncing = true
      b.scrollTop = a.scrollTop
    })
  }
}
</script>
</body>
</html>
`
fs.writeFileSync(path.join(args.dir, 'index.html'), html)
console.log(`${results.length} routes: ${totals[SAME]} same, ${totals[EXPECTED]} expected only, ${totals[UNEXPECTED]} unexpected`)
for (const result of results) {
  const unexpected = result.checks.filter((item) => item.verdict === UNEXPECTED).map((item) => item.field)
  console.log(`${result.verdict.padEnd(10)} ${result.route.path}${unexpected.length ? '  [' + unexpected.join('; ') + ']' : ''}`)
}
