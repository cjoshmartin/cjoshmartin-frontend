// Live check of the deployed testimonial-ascii-art Sanity Function on the staging dataset:
// swaps a testimonial's photo for another uploaded image, waits for asciiArt/asciiArtSource to be
// regenerated, then restores the original photo and waits for the original art to come back.
// The original image is always put back (finally block), even when a step fails.
//
// Needs SANITY_PROJECT_ID, SANITY_STAGING_DATASET and SANITY_WRITE_TOKEN in the environment.
// Usage: node src/function-check.mjs [--id testimonial-5] [--donor testimonial-7] [--timeout 120] [--out <json>]
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

import { SANITY_API_VERSION } from './config.mjs'

const require = createRequire(import.meta.url)
const { createClient } = require('@sanity/client')

const { values: args } = parseArgs({
  options: {
    id: { type: 'string', default: 'testimonial-5' },
    donor: { type: 'string', default: 'testimonial-7' },
    timeout: { type: 'string', default: '120' },
    out: { type: 'string' },
  },
})

for (const name of ['SANITY_PROJECT_ID', 'SANITY_STAGING_DATASET', 'SANITY_WRITE_TOKEN']) {
  if (!process.env[name]) throw new Error(`Missing environment variable ${name}`)
}
const dataset = process.env.SANITY_STAGING_DATASET
if (dataset !== 'staging') throw new Error(`This check only runs on the staging dataset, not "${dataset}"`)

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset,
  apiVersion: SANITY_API_VERSION,
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  perspective: 'raw',
})

const timeoutMs = Number(args.timeout) * 1000
const log = []
const note = (message, data = {}) => {
  const entry = { at: new Date().toISOString(), message, ...data }
  log.push(entry)
  console.log(`${entry.at} ${message}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`)
}

/** JSON with sorted keys, so key order from the API does not matter. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value)

/** Everything except bookkeeping, for before/after comparison. */
const content = (doc) => canonical(Object.fromEntries(Object.entries(doc).filter(([key]) => !['_rev', '_updatedAt'].includes(key))))

async function waitFor(description, predicate) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await client.getDocument(args.id)
    if (!last) throw new Error(`${args.id} disappeared while waiting for ${description}`)
    if (predicate(last)) {
      const seconds = (Date.now() - started) / 1000
      note(`${description}: done after ${seconds.toFixed(1)} s`)
      return { doc: last, seconds }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error(`${description}: not done within ${args.timeout} s (asciiArtSource is ${last?.asciiArtSource})`)
}

const result = { dataset, documentId: args.id, donorId: args.donor, steps: {}, passed: false }

const [original, donor, draft] = await Promise.all([
  client.getDocument(args.id),
  client.getDocument(args.donor),
  client.getDocument(`drafts.${args.id}`),
])
if (!original) throw new Error(`${args.id} does not exist in ${dataset}`)
if (!donor) throw new Error(`${args.donor} does not exist in ${dataset}`)
if (draft) throw new Error(`drafts.${args.id} exists; refusing to edit a testimonial that has an open draft`)
const originalAsset = original.image?.asset?._ref
const donorAsset = donor.image?.asset?._ref
if (!originalAsset || !donorAsset) throw new Error('Both testimonials need an image asset')
if (originalAsset === donorAsset) throw new Error('The donor testimonial uses the same image')
if (original.asciiArtSource !== originalAsset || !original.asciiArt) throw new Error(`${args.id} art is not up to date before the test`)
if (donor.asciiArtSource !== donorAsset || !donor.asciiArt) throw new Error(`${args.donor} art is not up to date before the test`)
note('before', { image: originalAsset, asciiArtLength: original.asciiArt.length, donorImage: donorAsset })
result.original = { image: originalAsset, asciiArtLength: original.asciiArt.length }

let failure = null
try {
  // 1. Swap the photo for the donor's photo (only the asset reference changes).
  const swapped = await client.patch(args.id).ifRevisionId(original._rev).set({ 'image.asset._ref': donorAsset }).commit()
  note('swapped image', { to: donorAsset, rev: swapped._rev })
  const afterSwap = await waitFor('art regenerated for the new image', (doc) => doc.asciiArtSource === donorAsset && Boolean(doc.asciiArt) && doc.asciiArt !== original.asciiArt)
  result.steps.swap = {
    seconds: afterSwap.seconds,
    asciiArtSource: afterSwap.doc.asciiArtSource,
    // The donor's art was generated from the same asset, so it must be byte-identical.
    identicalToDonorArt: afterSwap.doc.asciiArt === donor.asciiArt,
    asciiArtLength: afterSwap.doc.asciiArt.length,
  }
  if (!result.steps.swap.identicalToDonorArt) throw new Error('The regenerated art differs from the art already stored for the same image')
} catch (error) {
  failure = error
  note('swap step failed', { error: error.message })
} finally {
  // 2. Restore the original image object exactly, and wait for the original art.
  const current = await client.getDocument(args.id)
  const restored = await client.patch(args.id).ifRevisionId(current._rev).set({ image: original.image }).commit()
  note('restored original image', { rev: restored._rev })
  try {
    const afterRestore = await waitFor('art regenerated for the original image', (doc) => doc.asciiArtSource === originalAsset && doc.asciiArt === original.asciiArt)
    result.steps.restore = { seconds: afterRestore.seconds, identicalToOriginalArt: true }
  } catch (error) {
    // The Function did not restore the art: put the original fields back by hand so staging is
    // left as it was, and fail the check.
    const now = await client.getDocument(args.id)
    await client.patch(args.id).ifRevisionId(now._rev).set({ asciiArt: original.asciiArt, asciiArtSource: original.asciiArtSource }).commit()
    note('restore step failed; original art written back by hand', { error: error.message })
    failure ??= error
  }
}

const final = await client.getDocument(args.id)
const unchanged = content(final) === content(original)
result.steps.final = { contentIdenticalToBefore: unchanged, rev: final._rev }
note('final state', { contentIdenticalToBefore: unchanged })
result.passed = !failure && unchanged
result.error = failure?.message ?? (unchanged ? null : 'document content differs from before the test')
result.log = log
if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 1))
console.log(result.passed ? 'PASS' : `FAIL: ${result.error}`)
process.exit(result.passed ? 0 : 1)
