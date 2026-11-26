/**
 * Probes the public asset CDN for assets that were deleted from the datasets (privacy review
 * round 2, finding 1). Deleting a Sanity asset does not purge the CDN: a file stays cached for up
 * to 30 days (`cache-control: public, max-age=31536000, s-maxage=2592000`), per edge node. Until
 * Sanity purges the paths, or 30 days after the last deletion (2026-12-26), the unstripped uploads
 * the privacy work deleted may still be downloadable there.
 *
 * The list of deleted ids is private (it names where the unstripped bytes were), so it is not in
 * the repository: pass the JSON file the privacy work keeps outside it, shaped
 * {"<dataset>": ["file-<sha1>-<ext>", "image-<sha1>-<w>x<h>-<ext>", ...], ...}, and optionally a
 * second one with the ids whose bytes held a location (reported separately).
 *
 * For each id it requests the plain public URL (and `?dl=` for files) anonymously, `--rounds`
 * times, and prints how many answered 200, with the id shortened to its first 8 sha1 digits. It
 * reads only the status and the `age` header and discards the body. A probe cannot put a deleted
 * asset back into a cache (the origin answers 404), it only sees what an edge still holds. Exit
 * code 1 when any location-bearing URL still answers 200.
 *
 * Usage:
 *   node src/deleted-asset-cdn-probe.mjs --ids ~/cjoshmartin-migration/privacy/recheck2/deleted-ids.json \
 *     [--location ~/cjoshmartin-migration/privacy/recheck1/location-ids.json] [--rounds 3] [--json out.json]
 */
import {readFile, writeFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'

const PROJECT_ID = 'j3vdh6ti'
const ID = /^(image|file)-([0-9a-f]{40})(?:-(\d+x\d+))?-([A-Za-z0-9]+)$/

/** The public CDN URL of an asset id. */
export function assetCdnUrl(dataset, id) {
  const match = ID.exec(id)
  if (!match) throw new Error(`not an asset id: ${id.slice(0, 20)}...`)
  const [, kind, sha1, size, extension] = match
  return kind === 'image'
    ? `https://cdn.sanity.io/images/${PROJECT_ID}/${dataset}/${sha1}-${size}.${extension}`
    : `https://cdn.sanity.io/files/${PROJECT_ID}/${dataset}/${sha1}.${extension}`
}

async function status(url) {
  const response = await fetch(url, {headers: {'user-agent': 'cjoshmartin-privacy-probe'}, redirect: 'manual'})
  await response.body?.cancel()
  return {status: response.status, age: response.headers.get('age')}
}

async function main() {
  const {values} = parseArgs({
    options: {
      ids: {type: 'string'},
      location: {type: 'string'},
      rounds: {type: 'string', default: '3'},
      json: {type: 'string'},
    },
  })
  if (!values.ids) throw new Error('--ids <deleted ids JSON> is required')
  const deleted = JSON.parse(await readFile(values.ids, 'utf8'))
  const locationIds = values.location ? JSON.parse(await readFile(values.location, 'utf8')) : {}
  const rounds = Number(values.rounds)
  const results = []
  for (const [dataset, ids] of Object.entries(deleted)) {
    const withLocation = new Set(locationIds[dataset] ?? [])
    for (const id of ids) {
      const url = assetCdnUrl(dataset, id)
      const variants = id.startsWith('file-') ? [url, `${url}?dl=`] : [url]
      const served = []
      for (let round = 0; round < rounds; round++) {
        for (const variant of variants) {
          const {status: code, age} = await status(variant)
          if (code === 200) served.push({variant: variant === url ? 'plain' : 'dl', age})
        }
      }
      results.push({dataset, id: `${id.split('-')[0]}-${ID.exec(id)[2].slice(0, 8)}`, location: withLocation.has(id), requests: rounds * variants.length, served})
    }
  }
  const stillServed = results.filter((r) => r.served.length > 0)
  const locationServed = stillServed.filter((r) => r.location)
  console.log(`${results.length} deleted assets probed (${rounds} rounds): ${stillServed.length} still served at least once; ${locationServed.length} of them held a location`)
  for (const r of stillServed) {
    console.log(`  ${r.dataset} ${r.id}${r.location ? ' LOCATION' : ''}: ${r.served.length}/${r.requests} answered 200 (age ${[...new Set(r.served.map((s) => s.age))].join(', ')} s)`)
  }
  if (values.json) await writeFile(values.json, `${JSON.stringify({probedAt: new Date().toISOString(), results}, null, 1)}\n`)
  if (locationServed.length > 0) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
