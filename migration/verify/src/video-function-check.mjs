// Live check of the deployed video-to-mp4 Function (studio/functions/video-to-mp4) on staging,
// independent of the Function's own scripts/live-check.ts:
//
//  1. uploads a copy of --input with an ISO BMFF `free` box appended (new bytes, so a new asset id
//     the migration never used, same media), into a video block of a scratch draft blog post;
//  2. waits for the Function to set conversion.status to ready (or failed);
//  3. checks the block against video contract v2 (docs/sanity-migration/schema-contract.md) and the
//     MP4 asset (name, MIME type, source, one conversion only);
//  4. downloads the MP4 from the CDN and checks it against the settings in
//     studio/functions/video-to-mp4/settings.ts with ffprobe: H.264 High, yuv420p, the exact
//     expected size, no rotation left, audio exactly when the input has it, no other streams, no
//     metadata beyond the muxer's own, faststart, CRF 23 and the preset's options in the x264 SEI,
//     every input frame kept at its own time (frame timestamps compared, not only counted: a
//     constant-frame-rate resample can keep the count but drop and duplicate frames), the same
//     duration, and a full decode without errors; with --reference it also compares against a
//     local conversion of the same original;
//  5. deletes the scratch document and every asset the check uploaded or the Function made from
//     them (an asset only when nothing references it), also when a step fails, and checks that
//     nothing is left.
//
// Usage: node src/video-function-check.mjs --input <video> [--reference <local mp4 of the same
//        original>] [--dataset staging] [--json <result.json>] [--keep-mp4 <path>]
// --keep-mp4 saves a local copy of the Function's MP4 before the cleanup deletes the asset.
// Needs SANITY_PROJECT_ID and SANITY_WRITE_TOKEN, and ffmpeg and ffprobe on the PATH.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs, promisify } from 'node:util'

import {
  CONVERTED_ASSET_SETTINGS_FIELD,
  CONVERTED_ASSET_SOURCE_NAME,
  CRF,
  OUTPUT_EXTENSION,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
  convertedFilename,
  expectedOutputSize,
} from '../../../studio/functions/video-to-mp4/settings.ts'
import { videoNeedsConversion } from '../../../studio/schemaTypes/shared/video-conversion.ts'
import { SANITY_API_VERSION } from './config.mjs'

const require = createRequire(import.meta.url)
const { createClient } = require('@sanity/client')
const run = promisify(execFile)

const SCRATCH_ID = 'blogPost-video-verification-check'
const DRAFT_ID = `drafts.${SCRATCH_ID}`
const LEASE_FIELD = 'videoToMp4Lease'
const TIMEOUT_MS = 15 * 60_000
/** Muxer and handler tags ffmpeg writes itself; anything else would be copied input metadata. */
const ALLOWED_FORMAT_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder'])
const ALLOWED_STREAM_TAGS = new Set(['language', 'handler_name', 'vendor_id', 'encoder'])
/** x264 options that a preset decides (the CRF is checked on its own). */
const PRESET_OPTIONS = ['ref', 'subme', 'me', 'me_range', 'trellis', 'rc_lookahead', 'bframes', 'b_adapt', 'direct', 'weightp', 'mixed_ref', '8x8dct', 'analyse']
/** Contract v2 rich-text fields the Function watches (see a2-video-function.md). */
const PENDING_VIDEOS_QUERY = `count(*[_type in ["blogPost", "project", "flexPage", "testimonial", "homePage", "person", "service"] && count((coalesce(body, []) + coalesce(bio, []) + coalesce(description, []))[_type == "video" && defined(file.asset._ref) && file.asset._ref != conversion.outputAssetId]) > 0])`

const { values: args } = parseArgs({
  options: {
    input: { type: 'string' },
    reference: { type: 'string' },
    dataset: { type: 'string', default: 'staging' },
    json: { type: 'string' },
    'keep-mp4': { type: 'string' },
  },
})

const results = []
const timeline = []
const created = { documents: [SCRATCH_ID, DRAFT_ID], uploads: [] }
const note = (line) => {
  results.push(line)
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const key = () => randomBytes(6).toString('hex')
const fileRef = (ref) => ({ _type: 'file', asset: { _type: 'reference', _ref: ref } })

function check(condition, message) {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`)
}

/** Checks that are recorded and reported together at the end, so one does not hide the others. */
const deviations = []
function expectTo(condition, message) {
  if (!condition) {
    deviations.push(message)
    console.log(`DEVIATION: ${message}`)
  }
}

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')

async function ffprobe(file, extra = []) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', ...extra, file], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/** Decodes the first video stream completely and returns the number of frames. */
async function countFrames(file) {
  const probe = await ffprobe(file, ['-select_streams', 'V:0', '-count_frames', '-show_entries', 'stream=nb_read_frames'])
  return Number(probe.streams[0].nb_read_frames)
}

/** Presentation times (s) of the decoded frames of the first video stream, in order. */
async function frameTimes(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'V:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
    .split('\n')
    .map((line) => line.replace(/,$/, '').trim())
    .filter(Boolean)
    .map(Number)
}

/** Frame times shared within 2 ms: input frames missing from the output, output frames at new times. */
function compareFrameTimes(input, output) {
  const near = (list, time) => {
    let low = 0
    let high = list.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (Math.abs(list[middle] - time) <= 0.002) return true
      if (list[middle] < time) low = middle + 1
      else high = middle - 1
    }
    return false
  }
  const sorted = (list) => [...list].sort((a, b) => a - b)
  const inputSorted = sorted(input)
  const outputSorted = sorted(output)
  const missing = input.filter((time) => !near(outputSorted, time))
  const added = output.filter((time) => !near(inputSorted, time))
  return { missing: missing.length, added: added.length, firstMissing: missing.slice(0, 5), firstAdded: added.slice(0, 5) }
}

/** Rotation in degrees from the display matrix (ffprobe side data) or the legacy rotate tag. */
function rotationOf(stream) {
  const matrix = stream.side_data_list?.find((item) => item.rotation !== undefined)
  if (matrix) return Number(matrix.rotation)
  return Number(stream.tags?.rotate ?? 0)
}

/** The source as the Function sees it: displayed size, audio, duration, frames. */
async function describeSource(file) {
  const probe = await ffprobe(file, ['-show_streams', '-show_format'])
  const video = probe.streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  check(video, 'the input has a video stream')
  const rotation = rotationOf(video)
  const swap = Math.abs(rotation) % 180 === 90
  const displayed = { width: swap ? video.height : video.width, height: swap ? video.width : video.height }
  return {
    codec: video.codec_name,
    size: `${video.width}x${video.height}`,
    rotation,
    displayed,
    expected: expectedOutputSize(displayed),
    audio: probe.streams.some((stream) => stream.codec_type === 'audio'),
    duration: Number(probe.format.duration),
    videoDuration: Number(video.duration ?? probe.format.duration),
    frames: await countFrames(file),
    times: await frameTimes(file),
  }
}

/** Top-level ISO BMFF boxes of a file: [{type, size}]. */
function topLevelBoxes(buffer) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (size === 1) size = Number(buffer.readBigUInt64BE(offset + 8))
    else if (size === 0) size = buffer.length - offset
    if (size < 8) throw new Error(`invalid box size ${size} at ${offset}`)
    boxes.push({ type, size })
    offset += size
  }
  check(offset === buffer.length, `boxes end at ${offset}, file is ${buffer.length} bytes`)
  return boxes
}

/** The libx264 settings string from the SEI user data in the H.264 stream, as a map. */
function x264Options(buffer) {
  const start = buffer.indexOf('x264 - core ')
  if (start < 0) return null
  const end = buffer.indexOf(0, start)
  const text = buffer.toString('latin1', start, end)
  const options = {}
  for (const item of (text.split(' options: ')[1] ?? '').split(' ')) {
    const [name, value] = item.split('=')
    if (name) options[name] = value
  }
  return { core: text.match(/core (\d+)/)?.[1] ?? null, options }
}

/** A copy of `file` with a top-level `free` box appended: new bytes and asset id, same media. */
function uniqueCopy(file, dir) {
  const payload = Buffer.from(`video verification check ${new Date().toISOString()} ${key()}`)
  const box = Buffer.alloc(8 + payload.length)
  box.writeUInt32BE(box.length, 0)
  box.write('free', 4, 'latin1')
  payload.copy(box, 8)
  const copy = path.join(dir, path.basename(file))
  fs.writeFileSync(copy, Buffer.concat([fs.readFileSync(file), box]))
  return copy
}

async function videoBlock(client, id) {
  return client.fetch('*[_id == $id][0]{_rev, ...body[_type == "video"][0]}', { id }, { perspective: 'raw' })
}

async function convertedAssets(client, sourceId) {
  return client.fetch(
    `*[_type == "sanity.fileAsset" && source.name == $name && source.id == $id] | order(_createdAt asc){_id, _createdAt, url, mimeType, extension, originalFilename, size, sha1hash, source, "settingsVersion": ${CONVERTED_ASSET_SETTINGS_FIELD}}`,
    { name: CONVERTED_ASSET_SOURCE_NAME, id: sourceId },
    { perspective: 'raw' },
  )
}

/** Polls the draft's video block until `done`, recording each status change. */
async function waitFor(client, description, done, start) {
  let last = ''
  for (;;) {
    const block = await videoBlock(client, DRAFT_ID)
    const state = `${block?.conversion?.status ?? null}|${block?.file?.asset?._ref ?? null}`
    if (state !== last) {
      timeline.push({ at: new Date().toISOString(), ms: Date.now() - start, status: block?.conversion?.status ?? null, file: block?.file?.asset?._ref ?? null, message: block?.conversion?.message ?? null })
      last = state
    }
    if (done(block)) return { block, ms: Date.now() - start }
    if (Date.now() - start > TIMEOUT_MS) throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${description}; last ${JSON.stringify(block)}`)
    await sleep(1000)
  }
}

/** Checks the MP4 from the CDN against the settings; returns its measurements. */
async function checkMp4(asset, source, dir) {
  const response = await fetch(asset.url)
  check(response.ok, `GET ${asset.url}: HTTP ${response.status}`)
  check(response.headers.get('content-type') === OUTPUT_MIME_TYPE, `CDN content-type ${response.headers.get('content-type')}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const file = path.join(dir, `${asset._id}.${OUTPUT_EXTENSION}`)
  fs.writeFileSync(file, buffer)
  check(buffer.length === asset.size, `downloaded ${buffer.length} bytes, asset size ${asset.size}`)
  check(`file-${sha1(buffer)}-${OUTPUT_EXTENSION}` === asset._id && sha1(buffer) === asset.sha1hash, 'sha1 of the CDN file matches the asset id and sha1hash')

  const probe = await ffprobe(file, ['-show_streams', '-show_format'])
  const video = probe.streams.filter((stream) => stream.codec_type === 'video')
  const audio = probe.streams.filter((stream) => stream.codec_type === 'audio')
  const other = probe.streams.filter((stream) => !['video', 'audio'].includes(stream.codec_type))
  check(video.length === 1, `${video.length} video streams`)
  const [v] = video
  check(v.codec_name === 'h264' && v.profile === 'High', `video ${v.codec_name} ${v.profile} (want h264 High)`)
  check(v.pix_fmt === 'yuv420p', `pix_fmt ${v.pix_fmt}`)
  check(!v.color_range || v.color_range === 'tv', `color_range ${v.color_range} (want tv, limited range)`)
  check(v.width === source.expected.width && v.height === source.expected.height, `size ${v.width}x${v.height}, expected ${source.expected.width}x${source.expected.height}`)
  check(v.width % 2 === 0 && v.height % 2 === 0 && Math.max(v.width, v.height) <= 1920, 'even sides, longest side at most 1920')
  check(rotationOf(v) === 0, `rotation ${rotationOf(v)} left in the output`)
  if (source.audio) {
    check(audio.length === 1 && audio[0].codec_name === 'aac' && audio[0].profile === 'LC' && audio[0].channels === 2, 'one AAC-LC stereo track')
  } else check(audio.length === 0, `${audio.length} audio tracks for an input without audio`)
  check(other.length === 0, `extra streams: ${other.map((stream) => stream.codec_type).join(', ')}`)
  const formatTags = Object.keys(probe.format.tags ?? {}).filter((tag) => !ALLOWED_FORMAT_TAGS.has(tag))
  const streamTags = probe.streams.flatMap((stream) => Object.keys(stream.tags ?? {}).filter((tag) => !ALLOWED_STREAM_TAGS.has(tag)))
  check(formatTags.length === 0 && streamTags.length === 0, `metadata copied from the input: ${[...formatTags, ...streamTags].join(', ')}`)

  const boxes = topLevelBoxes(buffer).map((box) => box.type)
  check(boxes[0] === 'ftyp' && boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'), `faststart: boxes ${boxes.join('/')}`)

  const x264 = x264Options(buffer)
  check(x264, 'x264 settings SEI present (libx264)')
  check(Number(x264.options.crf) === CRF, `x264 crf=${x264.options.crf}, settings CRF ${CRF}`)

  const duration = Number(probe.format.duration)
  const videoDuration = Number(v.duration)
  const frames = await countFrames(file)
  const times = compareFrameTimes(source.times, await frameTimes(file))
  // The null output keeps each frame's own time; otherwise ffmpeg retimes a variable-frame-rate
  // video for the null muxer and logs "non monotonically increasing dts", which is not a decode error.
  const decode = await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0', '-fps_mode:v', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-'])
  check(decode.stderr.trim() === '', `decode errors: ${decode.stderr.trim()}`)
  return {
    file,
    bytes: buffer.length,
    codec: `${v.codec_name} ${v.profile} level ${v.level} ${v.pix_fmt} ${v.color_range ?? ''}`.trim(),
    size: `${v.width}x${v.height}`,
    audio: audio.length ? `${audio[0].codec_name} ${audio[0].profile} ${audio[0].channels} ch ${audio[0].bit_rate} b/s` : 'none',
    duration,
    videoDuration,
    frames,
    times,
    boxes,
    formatTags: probe.format.tags ?? {},
    x264,
  }
}

async function cleanup(client) {
  const docs = await client.fetch('*[_id in $ids]._id', { ids: created.documents }, { perspective: 'raw' })
  if (docs.length) await docs.reduce((transaction, id) => transaction.delete(id), client.transaction()).commit()
  const outputs = await client.fetch('*[_type == "sanity.fileAsset" && source.name == $name && source.id in $ids]._id', { name: CONVERTED_ASSET_SOURCE_NAME, ids: created.uploads }, { perspective: 'raw' })
  const deleted = []
  const kept = []
  for (const id of [...outputs, ...created.uploads]) {
    const references = await client.fetch('count(*[references($id)])', { id }, { perspective: 'raw' })
    if (references > 0) {
      kept.push(`${id} (${references} references)`)
      continue
    }
    if (await client.fetch('*[_id == $id][0]._id', { id }, { perspective: 'raw' })) {
      await client.delete(id)
      deleted.push(id)
    }
  }
  const left = await client.fetch('*[_id in $ids]._id', { ids: [...created.documents, ...outputs, ...created.uploads] }, { perspective: 'raw' })
  note(`cleanup: deleted documents ${docs.join(', ') || 'none'}; deleted assets ${deleted.join(', ') || 'none'}; kept ${kept.join(', ') || 'none'}; remaining ${left.join(', ') || 'none'}`)
  return { deletedDocuments: docs, deletedAssets: deleted, kept, remaining: left }
}

async function main() {
  const projectId = process.env.SANITY_PROJECT_ID
  const token = process.env.SANITY_WRITE_TOKEN
  if (!projectId || !token) throw new Error('SANITY_PROJECT_ID and SANITY_WRITE_TOKEN must be set')
  if (!args.input) throw new Error('--input <video> is required')
  if (args.dataset === 'production') throw new Error('This check writes scratch data; run it on staging')
  const client = createClient({ projectId, dataset: args.dataset, token, apiVersion: SANITY_API_VERSION, useCdn: false })

  const existing = await client.fetch('*[_id in $ids]._id', { ids: created.documents }, { perspective: 'raw' })
  if (existing.length) throw new Error(`Scratch documents already exist: ${existing.join(', ')}; delete them first`)
  const before = await client.fetch(
    `{"files": count(*[_type == "sanity.fileAsset"]), "documents": count(*[!(_id in path("_.**"))]), "leases": *[_type == "sanity.fileAsset" && defined(${LEASE_FIELD})]._id, "pending": ${PENDING_VIDEOS_QUERY}}`,
    {},
    { perspective: 'raw' },
  )
  note(`before: ${before.files} file assets, ${before.documents} documents, ${before.leases.length} conversion leases, ${before.pending} documents with a video that needs conversion; settings ${SETTINGS_VERSION}`)
  check(before.leases.length === 0, `conversion leases already held: ${before.leases.join(', ')}`)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-verification-'))
  let cleanupResult = null
  try {
    // 1. Fresh upload into a scratch draft.
    const copy = uniqueCopy(args.input, work)
    const source = await describeSource(copy)
    note(`input ${path.basename(args.input)}: ${source.codec} ${source.size}, rotation ${source.rotation}, ${source.audio ? 'audio' : 'no audio'}, ${source.duration.toFixed(3)} s, ${source.frames} frames; expected MP4 ${source.expected.width}x${source.expected.height}`)
    const copyBytes = fs.readFileSync(copy)
    const contentType = path.extname(copy).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4'
    const uploaded = await client.assets.upload('file', copyBytes, { filename: path.basename(copy), contentType })
    created.uploads.push(uploaded._id)
    const expectedUploadId = `file-${sha1(copyBytes)}-${path.extname(copy).slice(1).toLowerCase()}`
    check(uploaded._id === expectedUploadId, `upload id ${uploaded._id}, expected ${expectedUploadId}`)
    note(`uploaded ${path.basename(copy)} (${contentType}, ${copyBytes.length} bytes) as ${uploaded._id}`)

    const videoKey = key()
    const t0 = Date.now()
    const createdAt = new Date().toISOString()
    await client.create({
      _id: DRAFT_ID,
      _type: 'blogPost',
      title: 'Video verification check (scratch)',
      body: [
        { _type: 'block', _key: key(), style: 'normal', markDefs: [], children: [{ _type: 'span', _key: key(), text: 'Scratch document for the video-to-mp4 verification check.', marks: [] }] },
        { _type: 'video', _key: videoKey, file: fileRef(uploaded._id) },
      ],
    })
    note(`created ${DRAFT_ID} with video block ${videoKey} at ${createdAt}`)

    // 2. Wait for the Function.
    const processing = await waitFor(client, 'processing', (block) => ['processing', 'ready', 'failed'].includes(block?.conversion?.status), t0)
    const finished = await waitFor(client, 'ready', (block) => ['ready', 'failed'].includes(block?.conversion?.status), t0)
    const block = finished.block
    check(block.conversion.status === 'ready', `status ${block.conversion.status}: ${block.conversion.message}`)
    note(`processing seen after ${(processing.ms / 1000).toFixed(1)} s (status ${processing.block.conversion.status}), ready after ${(finished.ms / 1000).toFixed(1)} s`)

    // 3. The block and the MP4 asset (contract v2).
    const mp4Id = block.file?.asset?._ref
    check(block._key === videoKey, 'the same block was converted')
    check(mp4Id && /^file-[0-9a-f]{40}-mp4$/.test(mp4Id), `file is ${mp4Id}`)
    check(block.conversion.outputAssetId === mp4Id, `conversion.outputAssetId ${block.conversion.outputAssetId} = file`)
    check(block.conversion.sourceAssetId === uploaded._id, `conversion.sourceAssetId ${block.conversion.sourceAssetId} = the upload`)
    check(block.original?.asset?._ref === uploaded._id, `original ${block.original?.asset?._ref} = the upload`)
    check(block.conversion.settingsVersion === SETTINGS_VERSION, `settingsVersion ${block.conversion.settingsVersion}, settings.ts ${SETTINGS_VERSION}`)
    const updatedAt = Date.parse(block.conversion.updatedAt)
    check(Number.isFinite(updatedAt) && updatedAt >= Date.parse(createdAt) - 5000 && updatedAt <= Date.now() + 5000, `conversion.updatedAt ${block.conversion.updatedAt}`)
    check(!videoNeedsConversion(block), "the Studio's videoNeedsConversion is false")
    const outputs = await convertedAssets(client, uploaded._id)
    check(outputs.length === 1 && outputs[0]._id === mp4Id, `exactly one MP4 made from the upload (${outputs.map((output) => output._id).join(', ')})`)
    const [asset] = outputs
    check(asset.mimeType === OUTPUT_MIME_TYPE && asset.extension === OUTPUT_EXTENSION, `asset ${asset.mimeType} .${asset.extension}`)
    const expectedName = convertedFilename(path.basename(copy), uploaded._id)
    check(asset.originalFilename === expectedName, `originalFilename ${asset.originalFilename}, expected ${expectedName}`)
    check(asset.source?.name === CONVERTED_ASSET_SOURCE_NAME && asset.source?.id === uploaded._id, `source ${JSON.stringify(asset.source)}`)
    check(asset.settingsVersion === SETTINGS_VERSION, `the MP4 asset records ${CONVERTED_ASSET_SETTINGS_FIELD} ${asset.settingsVersion}, settings.ts ${SETTINGS_VERSION}`)
    check((await client.fetch('*[_id == $id][0]._id', { id: SCRATCH_ID }, { perspective: 'raw' })) === null, 'nothing was published')
    note(`block: file ${mp4Id}, original ${block.original.asset._ref}, conversion ${JSON.stringify(block.conversion)}`)
    note(`asset: ${asset.originalFilename}, ${asset.mimeType}, source ${asset.source.name}/${asset.source.id}, ${asset.size} bytes, the only MP4 made from the upload`)

    // The run must have released its lease before anything is deleted.
    const leaseStart = Date.now()
    while (await client.fetch(`defined(*[_id == $id][0].${LEASE_FIELD})`, { id: uploaded._id }, { perspective: 'raw' })) {
      if (Date.now() - leaseStart > 120_000) throw new Error('the conversion lease was not released within 120 s')
      await sleep(1000)
    }

    // 4. The MP4 itself.
    const mp4 = await checkMp4(asset, source, work)
    if (args['keep-mp4']) {
      fs.copyFileSync(mp4.file, args['keep-mp4'])
      note(`kept a local copy of the MP4: ${args['keep-mp4']}`)
    }
    note(`MP4 from the CDN: ${mp4.bytes} bytes, ${mp4.codec}, ${mp4.size}, audio ${mp4.audio}, ${mp4.duration.toFixed(3)} s, ${mp4.frames}/${source.frames} frames (${mp4.times.missing} input frame times missing, ${mp4.times.added} output frames at new times), boxes ${mp4.boxes.join('/')}, format tags ${Object.keys(mp4.formatTags).join(', ')}, x264 core ${mp4.x264.core} crf=${mp4.x264.options.crf}, decodes without errors`)

    let comparison = null
    if (args.reference) {
      const reference = fs.readFileSync(args.reference)
      const referenceX264 = x264Options(reference)
      const presetDiffs = PRESET_OPTIONS.filter((name) => mp4.x264.options[name] !== referenceX264?.options[name]).map(
        (name) => `${name}: Function ${mp4.x264.options[name]}, reference ${referenceX264?.options[name]}`,
      )
      const referenceProbe = await ffprobe(args.reference, ['-show_streams', '-show_format'])
      const referenceVideo = referenceProbe.streams.find((stream) => stream.codec_type === 'video')
      const referenceFrames = await countFrames(args.reference)
      const referenceTimes = compareFrameTimes(source.times, await frameTimes(args.reference))
      comparison = {
        referenceTimes,
        referenceSha1: sha1(reference),
        identicalBytes: sha1(reference) === asset.sha1hash,
        referenceX264Core: referenceX264?.core ?? null,
        presetDiffs,
        referenceSize: `${referenceVideo.width}x${referenceVideo.height}`,
        referenceFrames,
        referenceDuration: Number(referenceProbe.format.duration),
      }
      note(
        `reference ${path.basename(args.reference)}: ${comparison.referenceSize}, ${referenceFrames} frames (${referenceTimes.missing} input frame times missing, ${referenceTimes.added} at new times), ${comparison.referenceDuration.toFixed(3)} s; preset options ${presetDiffs.length ? `DIFFER: ${presetDiffs.join('; ')}` : `equal (${PRESET_OPTIONS.map((name) => `${name}=${mp4.x264.options[name]}`).join(' ')})`}; bytes ${comparison.identicalBytes ? 'identical' : `differ (x264 core ${mp4.x264.core} in the Function, ${comparison.referenceX264Core} locally)`}`,
      )
    }
    expectTo(mp4.frames === source.frames, `frames: ${mp4.frames} in the MP4, ${source.frames} in the input`)
    expectTo(
      mp4.times.missing === 0 && mp4.times.added === 0,
      `frame times: ${mp4.times.missing} input frame times have no output frame (first ${mp4.times.firstMissing.join(', ')}), ${mp4.times.added} output frames at times the input has no frame (first ${mp4.times.firstAdded.join(', ')})`,
    )
    expectTo(Math.abs(mp4.duration - source.duration) <= 0.1, `duration ${mp4.duration} s vs input ${source.duration} s`)
    if (comparison) {
      expectTo(comparison.presetDiffs.length === 0, `preset options differ from the reference: ${comparison.presetDiffs.join('; ')}`)
      expectTo(comparison.referenceSize === mp4.size, `reference size ${comparison.referenceSize} vs ${mp4.size}`)
      expectTo(comparison.referenceFrames === mp4.frames, `reference ${comparison.referenceFrames} frames vs ${mp4.frames} in the Function's MP4`)
    }

    const after = await client.fetch(`{"leases": *[_type == "sanity.fileAsset" && defined(${LEASE_FIELD})]._id, "pending": ${PENDING_VIDEOS_QUERY}}`, {}, { perspective: 'raw' })
    check(after.leases.length === 0, `leases left: ${after.leases.join(', ')}`)
    note(`after the run: no conversion lease; ${after.pending} documents with a video that needs conversion`)
    return { source: { ...source, times: undefined }, block, asset, mp4: { ...mp4, file: undefined }, comparison, processingMs: processing.ms, readyMs: finished.ms, deviations }
  } finally {
    cleanupResult = await cleanup(client)
    const final = await client.fetch(
      `{"files": count(*[_type == "sanity.fileAsset"]), "documents": count(*[!(_id in path("_.**"))]), "leases": *[_type == "sanity.fileAsset" && defined(${LEASE_FIELD})]._id}`,
      {},
      { perspective: 'raw' },
    )
    note(`after cleanup: ${final.files} file assets (before ${before.files}), ${final.documents} documents (before ${before.documents}), ${final.leases.length} leases`)
    cleanupResult.counts = { before, final }
    fs.rmSync(work, { recursive: true, force: true })
    if (args.json) {
      fs.writeFileSync(args.json, `${JSON.stringify({ dataset: args.dataset, settingsVersion: SETTINGS_VERSION, results, deviations, timeline, created, cleanup: cleanupResult }, null, 2)}\n`)
    }
    if (cleanupResult.remaining.length || final.files !== before.files || final.documents !== before.documents) {
      process.exitCode = 1
      console.error('CLEANUP INCOMPLETE: the dataset does not have the same documents and file assets as before')
    }
  }
}

try {
  const outcome = await main()
  if (args.json) {
    const written = JSON.parse(fs.readFileSync(args.json, 'utf8'))
    fs.writeFileSync(args.json, `${JSON.stringify({ ...written, outcome }, null, 2)}\n`)
  }
  if (deviations.length) {
    console.error(`video-function-check: ${deviations.length} deviation(s):\n- ${deviations.join('\n- ')}`)
    process.exitCode = 1
  } else if (!process.exitCode) console.log('video-function-check: all checks pass')
} catch (error) {
  console.error(error.stack ?? String(error))
  process.exitCode = 1
}
