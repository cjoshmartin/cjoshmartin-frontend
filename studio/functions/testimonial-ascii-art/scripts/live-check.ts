/**
 * Live check of the deployed testimonial-ascii-art Function on a dataset (staging by default).
 *
 * Uses a scratch document `testimonial-function-check` and the testimonial photos that
 * compare-with-python.ts uploaded (found by original file name), and checks that:
 *  1. creating a published testimonial with a photo gets asciiArt + asciiArtSource, and the art
 *     equals the Django/Python HTML for that photo byte for byte;
 *  2. replacing the photo regenerates the art;
 *  3. removing the photo unsets both fields;
 *  4. a draft with a new photo gets its own art, and publishing it leaves the published
 *     document with matching art;
 *  5. a draft that is published immediately after its photo changes (before the Function can
 *     patch the draft) still ends up with matching art on the published document.
 * The scratch document (published and draft) is deleted at the end, also when a step fails.
 *
 * Usage (from this function's directory):
 *   SANITY_PROJECT_ID=... SANITY_WRITE_TOKEN=... npx tsx scripts/live-check.ts [--dataset staging]
 */
import {readFileSync} from 'node:fs'
import {parseArgs} from 'node:util'

import {createClient, type SanityClient} from '@sanity/client'

const SCRATCH_ID = 'testimonial-function-check'
const DRAFT_ID = `drafts.${SCRATCH_ID}`
const TIMEOUT_MS = 120_000

interface PythonRender {
  file: string
  html: string
}

interface ArtState {
  _rev: string
  imageAssetId: string | null
  asciiArt: string | null
  asciiArtSource: string | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function readState(client: SanityClient, id: string): Promise<ArtState | null> {
  return client.fetch<ArtState | null>(
    '*[_id == $id][0]{_rev, "imageAssetId": image.asset._ref, asciiArt, asciiArtSource}',
    {id},
    {perspective: 'raw'},
  )
}

async function waitFor(
  client: SanityClient,
  id: string,
  description: string,
  done: (state: ArtState | null) => boolean,
): Promise<{state: ArtState | null; ms: number}> {
  const start = Date.now()
  for (;;) {
    const state = await readState(client, id)
    if (done(state)) return {state, ms: Date.now() - start}
    if (Date.now() - start > TIMEOUT_MS) {
      throw new Error(
        `timed out after ${TIMEOUT_MS} ms waiting for ${id}: ${description}; last state ${JSON.stringify(state && {...state, asciiArt: state.asciiArt?.slice(0, 40)})}`,
      )
    }
    await sleep(1000)
  }
}

const image = (assetId: string) => ({_type: 'image', asset: {_type: 'reference', _ref: assetId}})

async function main() {
  const {values} = parseArgs({options: {dataset: {type: 'string', default: 'staging'}}})
  const projectId = process.env.SANITY_PROJECT_ID
  const token = process.env.SANITY_WRITE_TOKEN
  if (!projectId || !token) throw new Error('SANITY_PROJECT_ID and SANITY_WRITE_TOKEN must be set')
  const dataset = values.dataset!
  const client = createClient({projectId, dataset, token, apiVersion: '2025-02-19', useCdn: false})

  const renders: PythonRender[] = JSON.parse(
    readFileSync(new URL('../test/fixtures/python-renders.json', import.meta.url), 'utf8'),
  )
  const assets = await client.fetch<{_id: string; originalFilename: string}[]>(
    '*[_type == "sanity.imageAsset" && originalFilename in $files]{_id, originalFilename} | order(originalFilename asc)',
    {files: renders.map((r) => r.file)},
  )
  const expected = new Map<string, string>()
  for (const asset of assets) {
    const render = renders.find((r) => r.file === asset.originalFilename)
    if (render) expected.set(asset._id, render.html)
  }
  if (expected.size < 4)
    throw new Error(
      `need 4 uploaded testimonial photos in ${dataset}, found ${expected.size}; run compare-with-python.ts first`,
    )
  const [a, b, c, d] = [...expected.keys()]
  const matches = (state: ArtState | null, assetId: string) =>
    state !== null && state.asciiArtSource === assetId && state.asciiArt === expected.get(assetId)

  const existing = await client.fetch<string[]>('*[_id in $ids]._id', {ids: [SCRATCH_ID, DRAFT_ID]})
  if (existing.length > 0)
    throw new Error(`scratch documents already exist: ${existing.join(', ')}; delete them first`)

  const results: string[] = []
  try {
    await client.create({
      _id: SCRATCH_ID,
      _type: 'testimonial',
      firstName: 'Function',
      lastName: 'Check',
      image: image(a),
    })
    let r = await waitFor(client, SCRATCH_ID, `art from ${a}`, (s) => matches(s, a))
    results.push(
      `1. create with ${a}: asciiArt + asciiArtSource set after ${r.ms} ms, byte-identical to the Python HTML`,
    )

    await client
      .patch(SCRATCH_ID)
      .set({image: image(b)})
      .commit()
    r = await waitFor(client, SCRATCH_ID, `art from ${b}`, (s) => matches(s, b))
    results.push(
      `2. image changed to ${b}: art regenerated after ${r.ms} ms, byte-identical, differs from step 1: ${expected.get(a) !== expected.get(b)}`,
    )

    await client.patch(SCRATCH_ID).unset(['image']).commit()
    r = await waitFor(
      client,
      SCRATCH_ID,
      'both fields unset',
      (s) => s !== null && s.asciiArt === null && s.asciiArtSource === null,
    )
    results.push(`3. image removed: asciiArt and asciiArtSource unset after ${r.ms} ms`)

    const published = await client.getDocument(SCRATCH_ID)
    if (!published) throw new Error('published scratch document disappeared')
    const {_rev: _publishedRev, _createdAt: _c, _updatedAt: _u, ...publishedFields} = published
    await client.create({...publishedFields, _id: DRAFT_ID, image: image(c)})
    r = await waitFor(client, DRAFT_ID, `draft art from ${c}`, (s) => matches(s, c))
    const publishedBefore = await readState(client, SCRATCH_ID)
    results.push(
      `4a. draft with ${c}: draft art set after ${r.ms} ms; published document untouched (asciiArt ${publishedBefore?.asciiArt === null ? 'still unset' : 'SET'})`,
    )
    await client.action({
      actionType: 'sanity.action.document.publish',
      draftId: DRAFT_ID,
      publishedId: SCRATCH_ID,
    })
    r = await waitFor(client, SCRATCH_ID, `published art from ${c}`, (s) => matches(s, c))
    const draftAfter = await readState(client, DRAFT_ID)
    results.push(
      `4b. draft published: published art matches ${c} after ${r.ms} ms; draft ${draftAfter === null ? 'gone' : 'STILL PRESENT'}`,
    )

    await client.createOrReplace({
      ...publishedFields,
      _id: DRAFT_ID,
      image: image(d),
      asciiArt: expected.get(c),
      asciiArtSource: c,
    })
    await client.action({
      actionType: 'sanity.action.document.publish',
      draftId: DRAFT_ID,
      publishedId: SCRATCH_ID,
    })
    const right = await readState(client, SCRATCH_ID)
    r = await waitFor(client, SCRATCH_ID, `published art from ${d}`, (s) => matches(s, d))
    results.push(
      `5. draft with ${d} published immediately (published copy had art from ${right?.asciiArtSource === c ? c : right?.asciiArtSource}): published art matches ${d} after ${r.ms} ms`,
    )
  } finally {
    const cleanup = await client.fetch<string[]>('*[_id in $ids]._id', {
      ids: [SCRATCH_ID, DRAFT_ID],
    })
    if (cleanup.length > 0) {
      await cleanup.reduce((tx, id) => tx.delete(id), client.transaction()).commit()
    }
    const left = await client.fetch<string[]>('*[_id in $ids]._id', {ids: [SCRATCH_ID, DRAFT_ID]})
    results.push(
      `cleanup: deleted ${cleanup.join(', ') || 'nothing'}; remaining: ${left.join(', ') || 'none'}`,
    )
    for (const line of results) console.log(line)
  }
}

await main()
