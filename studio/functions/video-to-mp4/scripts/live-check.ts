/**
 * Live check of the deployed video-to-mp4 Function on a dataset (staging by default).
 *
 * Uses the scratch document `blogPost-video-function-check` and checks that:
 *  1. a draft with a video block pointing at a fresh HEVC .mov upload goes processing -> ready;
 *     `file` becomes an H.264 MP4 within the settings, `original` is the .mov, and the MP4 from
 *     the CDN passes ffprobe checks and decodes completely;
 *  2. saving the draft again does not convert again;
 *  3. publishing it gives a correct published document, without converting again;
 *  4. replacing the file with another upload converts again, and publishing while that
 *     conversion runs still ends with a converted published document, converted once;
 *  5. a file that is not a video (random bytes named .mov) ends as `failed` with a message, and
 *     saving again does not retry it;
 *  6. a fresh `processing` mark does not start a run, and once it is older than the stale limit
 *     (timeout + 5 min) the next save retries the conversion (the filter's now() arithmetic in
 *     the deployed event filter).
 * The scratch documents and every asset the check uploaded or the Function made from them are
 * deleted at the end, also when a step fails (an asset only if nothing references it).
 *
 * Uploads are copies of the originals with an ISO BMFF `free` box appended. That changes their
 * bytes, and so their content-addressed asset ids, without touching any media data, so the check
 * never shares (or deletes) an asset with the migration's own upload of the same original.
 *
 * Usage (from this function's directory; needs ffmpeg and ffprobe on PATH):
 *   SANITY_PROJECT_ID=... SANITY_WRITE_TOKEN=... npx tsx scripts/live-check.ts \
 *     --first <hevc.mov> --second <video> [--dataset staging] [--json <result.json>]
 */
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {parseArgs, promisify} from 'node:util'

import {createClient, type SanityClient} from '@sanity/client'

import {sha1File} from '../ffmpeg'
import {inspectMp4} from '../mp4'
import {LEASE_FIELD} from '../patches'
import {
  CONVERTED_ASSET_SOURCE_NAME,
  convertedFilename,
  expectedOutputSize,
  SETTINGS_VERSION,
} from '../settings'
import {STALE_PROCESSING_SECONDS, type VideoBlock} from '../trigger'

const run = promisify(execFile)
const SCRATCH_ID = 'blogPost-video-function-check'
const DRAFT_ID = `drafts.${SCRATCH_ID}`
const API_VERSION = '2025-02-19'
const TIMEOUT_MS = 12 * 60_000
const QUIET_MS = 45_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const key = () => randomBytes(6).toString('hex')
const fileRef = (ref: string) => ({_type: 'file', asset: {_type: 'reference', _ref: ref}})

interface Timeline {
  at: string
  ms: number
  id: string
  status: string | null
  file: string | null
}

const results: string[] = []
const timeline: Timeline[] = []
const created = {documents: [SCRATCH_ID, DRAFT_ID], uploads: [] as string[]}

function note(line: string) {
  results.push(line)
  console.log(line)
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`)
}

async function videoBlock(
  client: SanityClient,
  id: string,
): Promise<(VideoBlock & {_rev: string}) | null> {
  return client.fetch(
    '*[_id == $id][0]{_rev, ...body[_type == "video"][0]}',
    {id},
    {perspective: 'raw', useCdn: false},
  )
}

/** Polls the document's first video block until `done`, recording status changes. */
async function waitFor(
  client: SanityClient,
  id: string,
  description: string,
  done: (block: VideoBlock | null) => boolean,
  start = Date.now(),
): Promise<{block: VideoBlock | null; ms: number}> {
  let last = ''
  for (;;) {
    const block = await videoBlock(client, id)
    const state = `${block?.conversion?.status ?? null}|${block?.file?.asset?._ref ?? null}`
    if (state !== last) {
      timeline.push({
        at: new Date().toISOString(),
        ms: Date.now() - start,
        id,
        status: block?.conversion?.status ?? null,
        file: block?.file?.asset?._ref ?? null,
      })
      last = state
    }
    if (done(block)) return {block, ms: Date.now() - start}
    if (Date.now() - start > TIMEOUT_MS) {
      throw new Error(
        `timed out after ${TIMEOUT_MS} ms waiting for ${id}: ${description}; last ${JSON.stringify(block)}`,
      )
    }
    await sleep(1000)
  }
}

/** A copy of `file` with a top-level `free` box appended (new bytes, same media). */
async function uniqueCopy(file: string, dir: string, label: string): Promise<string> {
  const payload = Buffer.from(
    `video-to-mp4 live check ${label} ${new Date().toISOString()} ${key()}`,
  )
  const box = Buffer.alloc(8 + payload.length)
  box.writeUInt32BE(box.length, 0)
  box.write('free', 4, 'latin1')
  payload.copy(box, 8)
  const copy = path.join(dir, label, path.basename(file))
  await mkdir(path.dirname(copy), {recursive: true})
  await writeFile(copy, Buffer.concat([await readFile(file), box]))
  return copy
}

async function upload(client: SanityClient, file: string, contentType: string): Promise<string> {
  const asset = await client.assets.upload('file', await readFile(file), {
    filename: path.basename(file),
    contentType,
  })
  created.uploads.push(asset._id)
  const expectedId = `file-${await sha1File(file)}-${path.extname(file).slice(1)}`
  check(
    asset._id.toLowerCase() === expectedId.toLowerCase(),
    `upload id ${asset._id}, expected ${expectedId}`,
  )
  return asset._id
}

async function convertedAssets(client: SanityClient, sourceId: string) {
  return client.fetch<
    {
      _id: string
      url: string
      mimeType: string
      originalFilename: string
      size: number
      source: {name: string; id: string}
    }[]
  >(
    '*[_type == "sanity.fileAsset" && source.name == $name && source.id == $id]{_id, url, mimeType, originalFilename, size, source}',
    {name: CONVERTED_ASSET_SOURCE_NAME, id: sourceId},
    {perspective: 'raw', useCdn: false},
  )
}

interface ProbeStream {
  codec_type: string
  codec_name: string
  profile?: string
  pix_fmt?: string
  width?: number
  height?: number
  channels?: number
  side_data_list?: {rotation?: number}[]
}

/** Downloads the MP4 from the CDN and checks it with ffprobe, the MP4 reader and a full decode. */
async function checkMp4(
  url: string,
  assetId: string,
  dir: string,
  expected: {width: number; height: number; audio: boolean; duration: number},
): Promise<string> {
  const response = await fetch(url)
  check(response.ok, `GET ${url}: HTTP ${response.status}`)
  check(
    response.headers.get('content-type') === 'video/mp4',
    `content-type ${response.headers.get('content-type')}`,
  )
  const file = path.join(dir, `${assetId}.mp4`)
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
  check(`file-${await sha1File(file)}-mp4` === assetId, 'sha1 of the CDN file matches the asset id')
  const {stdout} = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ])
  const probe = JSON.parse(stdout) as {
    streams: ProbeStream[]
    format: {duration: string; tags?: Record<string, string>}
  }
  const video = probe.streams.filter((s) => s.codec_type === 'video')
  const audio = probe.streams.filter((s) => s.codec_type === 'audio')
  check(video.length === 1, `${video.length} video streams`)
  check(
    video[0].codec_name === 'h264' && video[0].profile === 'High',
    `video ${video[0].codec_name} ${video[0].profile}`,
  )
  check(video[0].pix_fmt === 'yuv420p', `pix_fmt ${video[0].pix_fmt}`)
  check(
    video[0].width === expected.width && video[0].height === expected.height,
    `size ${video[0].width}x${video[0].height}`,
  )
  check(!video[0].side_data_list, 'no display matrix in the output')
  if (expected.audio)
    check(
      audio.length === 1 && audio[0].codec_name === 'aac' && audio[0].channels === 2,
      'one AAC stereo track',
    )
  else check(audio.length === 0, 'no audio track')
  const duration = Number(probe.format.duration)
  check(
    Math.abs(duration - expected.duration) < 0.25,
    `duration ${duration} vs ${expected.duration}`,
  )
  check(
    !probe.format.tags?.location && !probe.format.tags?.['com.apple.quicktime.location.ISO6709'],
    'no location metadata',
  )
  const boxes = (await inspectMp4(file)).topLevel.map((b) => b.type)
  check(boxes.indexOf('moov') < boxes.indexOf('mdat'), `faststart (${boxes.join(', ')})`)
  const decode = await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-xerror',
    '-i',
    file,
    '-map',
    '0',
    '-f',
    'null',
    '-',
  ])
  check(decode.stderr.trim() === '', `decode errors: ${decode.stderr}`)
  return `${video[0].codec_name} ${video[0].profile} ${video[0].pix_fmt} ${video[0].width}x${video[0].height}, ${expected.audio ? 'AAC stereo' : 'no audio'}, ${duration.toFixed(2)} s, ${boxes.join('/')}, decodes without errors`
}

async function describeSource(file: string) {
  const {stdout} = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ])
  const probe = JSON.parse(stdout) as {streams: ProbeStream[]; format: {duration: string}}
  const v = probe.streams.find((s) => s.codec_type === 'video')!
  const rotation = v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0
  const swap = Math.abs(rotation) % 180 === 90
  const size = expectedOutputSize({
    width: swap ? v.height! : v.width!,
    height: swap ? v.width! : v.height!,
  })
  return {
    ...size,
    audio: probe.streams.some((s) => s.codec_type === 'audio'),
    duration: Number(probe.format.duration),
    codec: v.codec_name,
  }
}

async function quietPeriod(
  client: SanityClient,
  id: string,
  sourceId: string,
  before: VideoBlock | null,
  what: string,
) {
  await sleep(QUIET_MS)
  const after = await videoBlock(client, id)
  check(
    after?.conversion?.updatedAt === before?.conversion?.updatedAt,
    `${what}: conversion untouched (${before?.conversion?.updatedAt} -> ${after?.conversion?.updatedAt})`,
  )
  check(
    (await convertedAssets(client, sourceId)).length <= 1,
    `${what}: still at most one MP4 for ${sourceId}`,
  )
}

async function cleanup(client: SanityClient) {
  const docs = await client.fetch<string[]>(
    '*[_id in $ids]._id',
    {ids: created.documents},
    {perspective: 'raw'},
  )
  if (docs.length > 0) await docs.reduce((tx, id) => tx.delete(id), client.transaction()).commit()
  const outputs = await client.fetch<string[]>(
    '*[_type == "sanity.fileAsset" && source.name == $name && source.id in $ids]._id',
    {name: CONVERTED_ASSET_SOURCE_NAME, ids: created.uploads},
    {perspective: 'raw'},
  )
  const deleted: string[] = []
  const kept: string[] = []
  for (const id of [...outputs, ...created.uploads]) {
    const refs = await client.fetch<number>('count(*[references($id)])', {id}, {perspective: 'raw'})
    if (refs > 0) {
      kept.push(`${id} (${refs} references)`)
      continue
    }
    const exists = await client.fetch<string | null>(
      '*[_id == $id][0]._id',
      {id},
      {perspective: 'raw'},
    )
    if (exists) {
      await client.delete(id)
      deleted.push(id)
    }
  }
  const left = await client.fetch<string[]>(
    '*[_id in $ids]._id',
    {ids: [...created.documents, ...outputs, ...created.uploads]},
    {perspective: 'raw'},
  )
  note(
    `cleanup: deleted documents ${docs.join(', ') || 'none'}; deleted assets ${deleted.join(', ') || 'none'}; kept ${kept.join(', ') || 'none'}; remaining ${left.join(', ') || 'none'}`,
  )
}

async function main() {
  const {values} = parseArgs({
    options: {
      dataset: {type: 'string', default: 'staging'},
      first: {type: 'string'},
      second: {type: 'string'},
      json: {type: 'string'},
    },
  })
  const projectId = process.env.SANITY_PROJECT_ID
  const token = process.env.SANITY_WRITE_TOKEN
  if (!projectId || !token) throw new Error('SANITY_PROJECT_ID and SANITY_WRITE_TOKEN must be set')
  if (!values.first || !values.second)
    throw new Error('--first <hevc.mov> and --second <video> are required')
  const dataset = values.dataset!
  if (dataset === 'production') throw new Error('this check writes scratch data; run it on staging')
  const client = createClient({projectId, dataset, token, apiVersion: API_VERSION, useCdn: false})

  const existing = await client.fetch<string[]>(
    '*[_id in $ids]._id',
    {ids: created.documents},
    {perspective: 'raw'},
  )
  if (existing.length > 0)
    throw new Error(`scratch documents already exist: ${existing.join(', ')}; delete them first`)

  const work = await mkdtemp(path.join(tmpdir(), 'video-to-mp4-live-'))
  try {
    // 1. Draft with a fresh HEVC .mov upload.
    const firstFile = await uniqueCopy(values.first, work, 'first')
    const firstInfo = await describeSource(firstFile)
    const mov = await upload(client, firstFile, 'video/quicktime')
    note(`uploaded ${path.basename(firstFile)} (${firstInfo.codec}) as ${mov}`)
    const videoKey = key()
    const t0 = Date.now()
    await client.create({
      _id: DRAFT_ID,
      _type: 'blogPost',
      title: 'Video Function check (scratch)',
      body: [
        {
          _type: 'block',
          _key: key(),
          style: 'normal',
          markDefs: [],
          children: [
            {
              _type: 'span',
              _key: key(),
              text: 'Scratch document for the video-to-mp4 live check.',
              marks: [],
            },
          ],
        },
        {_type: 'video', _key: videoKey, file: fileRef(mov)},
      ],
    })
    const processing = await waitFor(
      client,
      DRAFT_ID,
      'processing',
      (b) => b?.conversion?.status === 'processing' || b?.conversion?.status === 'ready',
      t0,
    )
    const ready = await waitFor(
      client,
      DRAFT_ID,
      'ready',
      (b) => b?.conversion?.status === 'ready' || b?.conversion?.status === 'failed',
      t0,
    )
    const block = ready.block!
    check(
      block.conversion?.status === 'ready',
      `status ${block.conversion?.status}: ${block.conversion?.message}`,
    )
    const mp4 = block.file!.asset!._ref!
    check(block.conversion?.outputAssetId === mp4, 'outputAssetId = file')
    check(block.conversion?.sourceAssetId === mov, 'sourceAssetId = upload')
    check(block.conversion?.settingsVersion === SETTINGS_VERSION, 'settingsVersion')
    check(block.original?.asset?._ref === mov, 'original = the .mov upload')
    const outputs = await convertedAssets(client, mov)
    check(
      outputs.length === 1 && outputs[0]._id === mp4,
      `one MP4 for the upload (${outputs.map((o) => o._id).join(', ')})`,
    )
    check(outputs[0].mimeType === 'video/mp4', `mimeType ${outputs[0].mimeType}`)
    check(
      outputs[0].originalFilename === convertedFilename(path.basename(firstFile), mov),
      `originalFilename ${outputs[0].originalFilename}`,
    )
    const probe1 = await checkMp4(outputs[0].url, mp4, work, firstInfo)
    note(
      `1. draft: processing seen after ${processing.ms} ms, ready after ${ready.ms} ms; file ${mp4} (${outputs[0].originalFilename}, ${(outputs[0].size / 1e6).toFixed(2)} MB): ${probe1}; original ${mov}; message "${block.conversion?.message}"`,
    )

    // 2. Save again.
    await client
      .patch(DRAFT_ID)
      .set({title: 'Video Function check (scratch, saved again)'})
      .commit()
    await quietPeriod(client, DRAFT_ID, mov, block, 're-save')
    note(
      `2. draft saved again: no new conversion in ${QUIET_MS / 1000} s (conversion.updatedAt unchanged, still one MP4)`,
    )

    // 3. Publish.
    await client.action({
      actionType: 'sanity.action.document.publish',
      draftId: DRAFT_ID,
      publishedId: SCRATCH_ID,
    })
    const published = await waitFor(client, SCRATCH_ID, 'published', (b) => b !== null)
    const pub = published.block!
    check(
      pub.file?.asset?._ref === mp4 &&
        pub.original?.asset?._ref === mov &&
        pub.conversion?.status === 'ready',
      'published block converted',
    )
    check((await videoBlock(client, DRAFT_ID)) === null, 'draft gone after publish')
    await quietPeriod(client, SCRATCH_ID, mov, pub, 'publish')
    note(
      `3. published: file ${mp4}, original ${mov}, ready; no new conversion in ${QUIET_MS / 1000} s`,
    )

    // 4. Replace the file in a new draft, publish while it converts.
    const secondFile = await uniqueCopy(values.second, work, 'second')
    const secondInfo = await describeSource(secondFile)
    const replacement = await upload(
      client,
      secondFile,
      path.extname(secondFile).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4',
    )
    const current = await client.getDocument(SCRATCH_ID)
    check(current, 'published document exists')
    const {_rev: _r, _createdAt: _c, _updatedAt: _u, ...fields} = current
    const body = (fields.body as {_type: string; _key: string}[]).map((b) =>
      b._type === 'video' ? {...b, file: fileRef(replacement)} : b,
    )
    const t4 = Date.now()
    await client.create({...fields, _id: DRAFT_ID, body})
    const replacing = await waitFor(
      client,
      DRAFT_ID,
      'processing of the replacement',
      (b) =>
        b?.conversion?.sourceAssetId === replacement &&
        (b.conversion.status === 'processing' ||
          b.conversion.status === 'ready' ||
          b.conversion.status === 'failed'),
      t4,
    )
    const publishedMidConversion = replacing.block?.conversion?.status === 'processing'
    await client.action({
      actionType: 'sanity.action.document.publish',
      draftId: DRAFT_ID,
      publishedId: SCRATCH_ID,
    })
    const republished = await waitFor(
      client,
      SCRATCH_ID,
      'published replacement ready',
      (b) =>
        b?.conversion?.sourceAssetId === replacement &&
        (b.conversion.status === 'ready' || b.conversion.status === 'failed'),
      t4,
    )
    const rb = republished.block!
    check(
      rb.conversion?.status === 'ready',
      `replacement status ${rb.conversion?.status}: ${rb.conversion?.message}`,
    )
    const mp4b = rb.file!.asset!._ref!
    check(
      mp4b !== mp4 &&
        rb.conversion?.outputAssetId === mp4b &&
        rb.original?.asset?._ref === replacement,
      'reconverted',
    )
    const outputs2 = await convertedAssets(client, replacement)
    check(
      outputs2.length === 1 && outputs2[0]._id === mp4b,
      `one MP4 for the replacement (${outputs2.map((o) => o._id).join(', ')})`,
    )
    const probe2 = await checkMp4(outputs2[0].url, mp4b, work, secondInfo)
    check((await videoBlock(client, DRAFT_ID)) === null, 'draft gone after publish')
    await quietPeriod(client, SCRATCH_ID, replacement, rb, 'publish mid-conversion')
    check(
      publishedMidConversion,
      'the draft was published while its conversion was still processing',
    )
    note(
      `4. replaced with ${replacement} (${secondInfo.codec}); processing seen after ${replacing.ms} ms, published mid-conversion, published document ready after ${republished.ms} ms with ${mp4b}: ${probe2}; converted once`,
    )

    // 5. Not a video.
    const fake = path.join(work, 'not-a-video.mov')
    await writeFile(fake, randomBytes(256 * 1024))
    const fakeId = await upload(client, fake, 'video/quicktime')
    const t5 = Date.now()
    await client.create({
      _id: DRAFT_ID,
      _type: 'blogPost',
      title: 'Video Function check (scratch, failure)',
      body: [{_type: 'video', _key: key(), file: fileRef(fakeId)}],
    })
    const failed = await waitFor(
      client,
      DRAFT_ID,
      'failed',
      (b) => b?.conversion?.status === 'failed' || b?.conversion?.status === 'ready',
      t5,
    )
    const fb = failed.block!
    check(fb.conversion?.status === 'failed', `status ${fb.conversion?.status}`)
    check(
      fb.file?.asset?._ref === fakeId && !fb.original && fb.conversion?.sourceAssetId === fakeId,
      'file left on the upload',
    )
    check((await convertedAssets(client, fakeId)).length === 0, 'no MP4 for the fake file')
    await client
      .patch(DRAFT_ID)
      .set({title: 'Video Function check (scratch, failure, saved again)'})
      .commit()
    await quietPeriod(client, DRAFT_ID, fakeId, fb, 'failed re-save')
    note(
      `5. not a video (${fakeId}): failed after ${failed.ms} ms with "${fb.conversion?.message}"; saving again did not retry`,
    )

    // 6. Fresh and stale processing marks, written as a dead run would have left them.
    const staleFile = await uniqueCopy(values.second, work, 'stale')
    const staleInfo = await describeSource(staleFile)
    const staleUpload = await upload(
      client,
      staleFile,
      path.extname(staleFile).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4',
    )
    const staleKey = key()
    const mark = (updatedAt: string) => ({
      status: 'processing',
      message: 'Converting to MP4.',
      sourceAssetId: staleUpload,
      settingsVersion: SETTINGS_VERSION,
      updatedAt,
    })
    await client.createOrReplace({
      _id: DRAFT_ID,
      _type: 'blogPost',
      title: 'Video Function check (scratch, processing marks)',
      body: [
        {
          _type: 'video',
          _key: staleKey,
          file: fileRef(staleUpload),
          conversion: mark(new Date().toISOString()),
        },
      ],
    })
    const fresh = await videoBlock(client, DRAFT_ID)
    await quietPeriod(client, DRAFT_ID, staleUpload, fresh, 'fresh processing mark')
    check(
      (await convertedAssets(client, staleUpload)).length === 0,
      'fresh mark: nothing converted',
    )
    const staleAt = new Date(Date.now() - (STALE_PROCESSING_SECONDS + 60) * 1000).toISOString()
    const t6 = Date.now()
    await client
      .patch(DRAFT_ID)
      .set({[`body[_key=="${staleKey}"].conversion`]: mark(staleAt)})
      .commit()
    const retried = await waitFor(
      client,
      DRAFT_ID,
      'stale mark retried',
      (b) => b?.conversion?.status === 'ready' || b?.conversion?.status === 'failed',
      t6,
    )
    check(
      retried.block?.conversion?.status === 'ready',
      `stale retry ${retried.block?.conversion?.status}`,
    )
    const staleOutputs = await convertedAssets(client, staleUpload)
    check(
      staleOutputs.length === 1 && retried.block?.file?.asset?._ref === staleOutputs[0]._id,
      'stale retry converted once',
    )
    await checkMp4(staleOutputs[0].url, staleOutputs[0]._id, work, staleInfo)
    note(
      `6. fresh processing mark: no run in ${QUIET_MS / 1000} s; mark aged past ${STALE_PROCESSING_SECONDS} s: retried and ready after ${retried.ms} ms (${staleOutputs[0]._id})`,
    )

    const leases = await client.fetch<string[]>(
      `*[_type == "sanity.fileAsset" && defined(${LEASE_FIELD})]._id`,
      {},
      {perspective: 'raw'},
    )
    check(leases.length === 0, `leases left: ${leases.join(', ')}`)
    note('no conversion lease left on any asset')
  } finally {
    await cleanup(client)
    await rm(work, {recursive: true, force: true})
    if (values.json) {
      await writeFile(
        values.json,
        `${JSON.stringify({dataset, results, timeline, created}, null, 2)}\n`,
      )
    }
  }
}

await main()
