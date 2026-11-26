/**
 * Step 4: videos.
 *
 * Uploads every Wagtail video to the target dataset twice, following video contract v2
 * (docs/sanity-migration/schema-contract.md, "Videos"):
 *
 * - the original, exactly as it is in the bucket, as a file asset with
 *   source {name: "wagtail", id: "media-<id>", url: <public bucket URL>}. Video blocks keep it in
 *   `original`, which is never served;
 * - its MP4 from the convert step as a file asset with originalFilename "<base name>.mp4",
 *   mimeType video/mp4 and source {name: "video-to-mp4", id: <original asset _id>}. Video blocks
 *   play it from `file`.
 *
 * Like every converter, this step first looks for an asset whose source is
 * {name: "video-to-mp4", id: <original asset _id>} and reuses it instead of adding another
 * conversion. When that asset's bytes are not the local MP4 (the video-to-mp4 Function converted
 * the same original), it is downloaded and must pass the same checks as the local MP4
 * (src/video/ffmpeg.ts verifyMp4); otherwise the step fails. More than one such asset fails too.
 *
 * Assets are content-addressed, so reruns reuse what is there and only patch metadata. The step
 * protects asset metadata like the assets step: before writing, it refuses when an asset's title,
 * description, originalFilename or source differs from what it would set and from what its last
 * run left (state/videos-<dataset>.json), unless the run is told to discard those changes.
 *
 * Writes state/videos-<dataset>.json: per Wagtail media id the original and MP4 asset ids, which
 * the transform turns into video blocks.
 */
import {createReadStream, existsSync, mkdirSync, renameSync, rmSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'

import type {SanityClient} from '@sanity/client'

import {
  CONVERTED_ASSET_SOURCE_NAME,
  convertedFilename,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
} from '../../../../studio/functions/video-to-mp4/settings'
import {ASSET_SOURCE_NAME, gcsPublicUrl, mediaAssetSourceId, type Dataset, type DataPaths, type Secrets} from '../config'
import {mapLimit, sanityClient} from '../sanity'
import {hashFile, log, readJson, sleep, writeJson} from '../util'
import {describeProblems, verifyMp4} from '../video/ffmpeg'
import {loadExport} from '../wagtail'
import {
  differingMetadata,
  findAssetMetadataEdits,
  type AssetMetadataEdit,
  type ExistingAsset,
  type PlannedAsset,
} from './assets'
import {readMp4Map, type ConvertedVideo} from './convert'

/** MIME types of the original files, by extension (what a browser reports when uploading them). */
export const ORIGINAL_MIME_TYPES: Readonly<Record<string, string>> = {
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
}

export function originalMimeType(filename: string): string {
  const extension = path.posix.extname(filename).slice(1).toLowerCase()
  const mimeType = ORIGINAL_MIME_TYPES[extension]
  if (!mimeType) throw new Error(`${filename}: no MIME type known for the extension "${extension}"`)
  return mimeType
}

export interface StoredFileAsset extends ExistingAsset {
  mimeType?: string
  extension?: string
  size?: number
  url?: string
}

export interface VideoAssets {
  mediaId: number
  original: {assetId: string; sha1: string; originalFilename: string; mimeType: string}
  mp4: {
    assetId: string
    sha1: string
    originalFilename: string
    mimeType: string
    size: number
    /** `convert`: the convert step's MP4. `existing`: a conversion already in the dataset, verified. */
    origin: 'convert' | 'existing'
  }
  /**
   * Settings version and time of the conversion; the transform writes them to `conversion`. For a
   * reused existing conversion both come from the video blocks that already play it.
   */
  conversion: {settingsVersion: string; convertedAt: string}
}

export interface VideoAssetMap {
  dataset: string
  settingsVersion: string
  /** Wagtail media id -> its two assets. */
  videos: Record<string, VideoAssets>
  /** asset id -> the metadata this step left on it (the record the metadata check compares with). */
  assets: Record<string, PlannedAsset & {assetId: string}>
}

export function videoAssetMapPath(paths: DataPaths, dataset: Dataset): string {
  return path.join(paths.state, `videos-${dataset}.json`)
}

export function readVideoAssetMap(paths: DataPaths, dataset: Dataset): VideoAssetMap | null {
  const file = videoAssetMapPath(paths, dataset)
  if (!existsSync(file)) return null
  const map = readJson<VideoAssetMap>(file)
  if (map.dataset !== dataset) throw new Error(`${file} is the video map of dataset ${map.dataset}, not ${dataset}`)
  return map
}

/** The asset of a Wagtail video as uploaded. */
export function plannedOriginal(video: ConvertedVideo): PlannedAsset {
  return {
    type: 'file',
    sha1: video.source.sha1,
    paths: [video.source.path],
    primaryPath: video.source.path,
    originalFilename: video.source.filename,
    title: video.title,
    source: {name: ASSET_SOURCE_NAME, id: mediaAssetSourceId(video.mediaId), url: gcsPublicUrl(video.source.path)},
    records: [`media:${video.mediaId}`],
  }
}

/** The MP4 asset of a Wagtail video whose original is the asset `original`. */
export function plannedMp4(video: ConvertedVideo, original: {_id: string; originalFilename?: string}, sha1: string): PlannedAsset {
  return {
    type: 'file',
    sha1,
    paths: [video.output.path],
    primaryPath: video.output.path,
    originalFilename: convertedFilename(original.originalFilename, original._id),
    title: video.title,
    source: {name: CONVERTED_ASSET_SOURCE_NAME, id: original._id},
    records: [`media:${video.mediaId}`],
  }
}

/** The video-to-mp4 assets made from `originalId`; the contract's reuse rule looks these up. */
export function conversionsOf(assets: readonly StoredFileAsset[], originalId: string): StoredFileAsset[] {
  return assets.filter((a) => a.source?.name === CONVERTED_ASSET_SOURCE_NAME && a.source.id === originalId)
}

const FILE_ASSET_FIELDS = '_id, _type, sha1hash, title, description, originalFilename, source, mimeType, extension, size, url'

async function fetchFileAssets(client: SanityClient): Promise<StoredFileAsset[]> {
  return client.fetch<StoredFileAsset[]>(`*[_type == "sanity.fileAsset"]{${FILE_ASSET_FIELDS}}`)
}

function refuseOrWarn(edits: AssetMetadataEdit[], dataset: Dataset, recordFile: string | null, discard: boolean): void {
  if (!edits.length) return
  const list = edits.map((e) => `- ${e.assetId} (${e.fields.join(', ')}): ${e.reason}`).join('\n')
  if (!discard) {
    throw new Error(
      `videos: refusing to change asset metadata in ${dataset}; this migration did not leave these values ` +
        `(record: ${recordFile ?? 'none'}):\n${list}\nPass --discard-studio-edits to overwrite them on purpose.`,
    )
  }
  log(`videos: WARNING --discard-studio-edits overwrites the metadata of these assets in ${dataset}:\n${list}`)
}

/** Sets title, description, originalFilename and source to the plan; returns whether it wrote. */
async function patchMetadata(client: SanityClient, current: StoredFileAsset, asset: PlannedAsset): Promise<boolean> {
  const fields = differingMetadata(current, asset)
  if (!fields.length) return false
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const field of fields) {
    const value = asset[field as keyof PlannedAsset]
    if (value === undefined) unset.push(field)
    else set[field] = field === 'source' ? {...asset.source} : value
  }
  await client.patch(current._id).set(set).unset(unset).commit()
  log(`  updated metadata of ${current._id} (${[...Object.keys(set), ...unset.map((u) => `-${u}`)].join(', ')})`)
  return true
}

async function upload(client: SanityClient, file: string, asset: PlannedAsset, contentType: string): Promise<StoredFileAsset> {
  const doc = await client.assets.upload('file', createReadStream(file), {
    filename: asset.originalFilename,
    contentType,
    title: asset.title,
    ...(asset.description ? {description: asset.description} : {}),
    source: {...asset.source},
  })
  return doc as unknown as StoredFileAsset
}

/**
 * Every file asset, from a query, once the query sees all of `ids` (it can lag a few seconds
 * behind uploads). Fails after a minute.
 */
async function waitForQuery(client: SanityClient, ids: readonly string[]): Promise<StoredFileAsset[]> {
  const deadline = Date.now() + 60_000
  while (true) {
    const assets = await fetchFileAssets(client)
    const seen = new Set(assets.map((a) => a._id))
    const missing = ids.filter((id) => !seen.has(id))
    if (!missing.length) return assets
    if (Date.now() > deadline) throw new Error(`videos: queries still do not return ${missing.join(', ')} a minute after the upload`)
    await sleep(2000)
  }
}

/**
 * The settings version and time another converter recorded for the MP4 `assetId`, read from the
 * `conversion` of the video blocks that play it. The asset itself does not say which settings made
 * it, so without such a block (or with blocks that disagree) the step cannot write a truthful
 * `conversion` and fails.
 */
async function recordedConversion(client: SanityClient, assetId: string): Promise<VideoAssets['conversion']> {
  const docs = await client.fetch<Record<string, unknown>[]>(`*[references($id)]`, {id: assetId})
  const found: {settingsVersion: string; updatedAt: string}[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      const item = value as {_type?: unknown; conversion?: {status?: unknown; outputAssetId?: unknown; settingsVersion?: unknown; updatedAt?: unknown}}
      const c = item.conversion
      if (item._type === 'video' && c?.status === 'ready' && c.outputAssetId === assetId && typeof c.settingsVersion === 'string' && typeof c.updatedAt === 'string') {
        found.push({settingsVersion: c.settingsVersion, updatedAt: c.updatedAt})
      }
      Object.values(value).forEach(visit)
    }
  }
  visit(docs)
  const versions = [...new Set(found.map((f) => f.settingsVersion))]
  if (versions.length !== 1) {
    throw new Error(
      `videos: cannot tell which settings made ${assetId}: ${versions.length ? `video blocks record ${versions.join(' and ')}` : 'no ready video block records its conversion'}. ` +
        'Delete the asset or record its conversion, then rerun.',
    )
  }
  const updatedAt = found.map((f) => f.updatedAt).sort().at(-1)!
  return {settingsVersion: versions[0]!, convertedAt: updatedAt}
}

/** Downloads an asset's bytes from the CDN to `file` and checks their sha1. */
async function download(url: string, file: string, sha1: string): Promise<void> {
  const response = await fetch(url, {signal: AbortSignal.timeout(10 * 60 * 1000)})
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  mkdirSync(path.dirname(file), {recursive: true, mode: 0o700})
  const partial = `${file}.partial`
  await writeFile(partial, Buffer.from(await response.arrayBuffer()))
  const actual = await hashFile(partial, 'sha1')
  if (actual !== sha1) {
    rmSync(partial, {force: true})
    throw new Error(`${url} has sha1 ${actual}, the asset says ${sha1}`)
  }
  renameSync(partial, file)
}

export async function uploadVideos(
  paths: DataPaths,
  dataset: Dataset,
  secrets: Secrets,
  options: {discardStudioEdits: boolean},
): Promise<VideoAssetMap> {
  const data = loadExport(paths.exportJson)
  const mp4s = readMp4Map(paths)
  const client = sanityClient(dataset, secrets)
  const previous = readVideoAssetMap(paths, dataset)
  const recordFile = previous ? videoAssetMapPath(paths, dataset) : null
  const videos = [...data.media].sort((a, b) => a.id - b.id).map((media) => {
    const video = mp4s.videos[String(media.id)]
    if (!video) throw new Error(`videos: media ${media.id} has no MP4; run the convert step`)
    return video
  })
  log(`videos: ${videos.length} videos into ${dataset} (original + MP4 each)`)

  // --- Originals: check, then upload or patch ---------------------------------------------
  let existing = await fetchFileAssets(client)
  const bySha1 = () => new Map(existing.map((a) => [`file:${a.sha1hash}`, a]))
  const originals = videos.map(plannedOriginal)
  // MP4s whose original is already in the dataset can be checked before anything is written.
  const knownMp4s = (): PlannedAsset[] => {
    const byKey = bySha1()
    return videos.flatMap((video) => {
      const original = byKey.get(`file:${video.source.sha1}`)
      if (!original) return []
      const conversions = conversionsOf(existing, original._id)
      const sha1 = conversions.length === 1 ? conversions[0]!.sha1hash : video.output.sha1
      return [plannedMp4(video, original, sha1)]
    })
  }
  refuseOrWarn(findAssetMetadataEdits([...originals, ...knownMp4s()], bySha1(), previous), dataset, recordFile, options.discardStudioEdits)

  let uploaded = 0
  let patched = 0
  const originalAssets = await mapLimit(videos, 3, async (video, index) => {
    const planned = originals[index]!
    let current = bySha1().get(`file:${planned.sha1}`)
    if (!current) {
      current = await upload(client, path.join(paths.gcs, video.source.path), planned, originalMimeType(video.source.filename))
      uploaded++
      log(`  uploaded ${video.source.path} -> ${current._id}`)
    }
    if (current.sha1hash !== planned.sha1) throw new Error(`Sanity stored ${video.source.path} with sha1 ${current.sha1hash}, expected ${planned.sha1}`)
    if (await patchMetadata(client, current, planned)) patched++
    return current
  })

  // --- MP4s: reuse a conversion of the original, else upload the local MP4 -----------------
  existing = await fetchFileAssets(client)
  const plannedMp4s: PlannedAsset[] = []
  const chosen: {video: ConvertedVideo; original: StoredFileAsset; reuse: StoredFileAsset | null}[] = []
  for (const [index, video] of videos.entries()) {
    const original = originalAssets[index]!
    const conversions = conversionsOf(existing, original._id)
    if (conversions.length > 1) {
      throw new Error(
        `videos: ${dataset} has ${conversions.length} video-to-mp4 assets for the original ${original._id} (media ${video.mediaId}): ` +
          `${conversions.map((c) => c._id).join(', ')}. Keep one (the one the video blocks use) and delete the others, then rerun.`,
      )
    }
    const reuse = conversions[0] ?? null
    chosen.push({video, original, reuse})
    plannedMp4s.push(plannedMp4(video, original, reuse ? reuse.sha1hash : video.output.sha1))
  }
  // Repeated with the original ids now known; normally everything was covered above.
  refuseOrWarn(findAssetMetadataEdits(plannedMp4s, bySha1(), previous), dataset, recordFile, options.discardStudioEdits)

  const result: VideoAssetMap = {dataset, settingsVersion: SETTINGS_VERSION, videos: {}, assets: {}}
  await mapLimit(chosen, 3, async ({video, original, reuse}, index) => {
    const planned = plannedMp4s[index]!
    let current: StoredFileAsset
    let origin: VideoAssets['mp4']['origin'] = 'convert'
    let existingConversion: VideoAssets['conversion'] | null = null
    if (reuse && reuse.sha1hash !== video.output.sha1) {
      // Another converter (the video-to-mp4 Function) already made this original's MP4. The rule
      // is to reuse it, so it has to pass the same checks as the local file.
      if (!reuse.url) throw new Error(`${reuse._id} has no url`)
      const file = path.join(paths.videoMp4, `media-${video.mediaId}`, `existing-${dataset}-${reuse._id}.mp4`)
      await download(reuse.url, file, reuse.sha1hash)
      const check = await verifyMp4(file, video.source.probe)
      if (!check.ok) {
        throw new Error(
          `videos: ${reuse._id}, the existing MP4 of ${original._id} (media ${video.mediaId}) in ${dataset}, fails the checks: ` +
            `${describeProblems(check.problems)}. Delete it (and point any video block at the original again), then rerun.`,
        )
      }
      existingConversion = await recordedConversion(client, reuse._id)
      log(`  media ${video.mediaId}: reusing ${reuse._id}, an existing conversion of ${original._id} (${existingConversion.settingsVersion}) that passes every check`)
      current = reuse
      origin = 'existing'
    } else {
      const found = reuse ?? bySha1().get(`file:${video.output.sha1}`)
      if (found) {
        current = found
      } else {
        current = await upload(client, path.join(paths.root, video.output.path), planned, OUTPUT_MIME_TYPE)
        uploaded++
        log(`  uploaded ${video.output.path} -> ${current._id}`)
      }
      if (current.sha1hash !== video.output.sha1) throw new Error(`Sanity stored ${video.output.path} with sha1 ${current.sha1hash}, expected ${video.output.sha1}`)
    }
    if (await patchMetadata(client, current, planned)) patched++
    result.assets[original._id] = {...originals[index]!, assetId: original._id}
    result.assets[current._id] = {...planned, assetId: current._id}
    result.videos[String(video.mediaId)] = {
      mediaId: video.mediaId,
      original: {assetId: original._id, sha1: original.sha1hash, originalFilename: originals[index]!.originalFilename, mimeType: original.mimeType ?? ''},
      mp4: {assetId: current._id, sha1: current.sha1hash, originalFilename: planned.originalFilename, mimeType: current.mimeType ?? '', size: current.size ?? 0, origin},
      conversion: existingConversion ?? {settingsVersion: SETTINGS_VERSION, convertedAt: video.convertedAt},
    }
  })

  // --- Read everything back -------------------------------------------------------------
  // By id from the document endpoint, which sees an asset as soon as its upload returned; a query
  // can lag behind the last uploads.
  const ids = Object.values(result.videos).flatMap((v) => [v.original.assetId, v.mp4.assetId])
  const stored = new Map(
    (await client.getDocuments<StoredFileAsset>(ids)).flatMap((doc) => (doc ? [[doc._id, doc as unknown as StoredFileAsset] as const] : [])),
  )
  // Conversions of these originals, from a query (the only way to search by source), once it
  // sees every asset this step uploaded.
  const conversions = await waitForQuery(client, ids)
  const problems: string[] = []
  for (const entry of Object.values(result.videos)) {
    const original = stored.get(entry.original.assetId)
    const mp4 = stored.get(entry.mp4.assetId)
    const where = `media ${entry.mediaId}`
    if (!original || !mp4) {
      problems.push(`${where}: an asset is missing after the upload`)
      continue
    }
    const plannedOriginalAsset = result.assets[original._id]!
    const plannedMp4Asset = result.assets[mp4._id]!
    if (differingMetadata(original, plannedOriginalAsset).length) problems.push(`${where}: ${original._id} metadata differs from the plan`)
    if (differingMetadata(mp4, plannedMp4Asset).length) problems.push(`${where}: ${mp4._id} metadata differs from the plan`)
    if (original.mimeType !== originalMimeType(plannedOriginalAsset.originalFilename)) {
      problems.push(`${where}: ${original._id} has mimeType ${original.mimeType}, expected ${originalMimeType(plannedOriginalAsset.originalFilename)}`)
    }
    if (mp4.mimeType !== OUTPUT_MIME_TYPE) problems.push(`${where}: ${mp4._id} has mimeType ${mp4.mimeType}, expected ${OUTPUT_MIME_TYPE}`)
    if (mp4.extension !== 'mp4') problems.push(`${where}: ${mp4._id} has extension ${mp4.extension}, expected mp4`)
    const made = conversionsOf(conversions, original._id)
    if (made.length !== 1) problems.push(`${where}: ${original._id} has ${made.length} video-to-mp4 assets (${made.map((a) => a._id).join(', ')}), expected 1`)
    entry.original.mimeType = original.mimeType ?? ''
    entry.mp4.mimeType = mp4.mimeType ?? ''
    entry.mp4.size = mp4.size ?? 0
  }
  if (problems.length) throw new Error(`videos: ${dataset} is not as planned after the upload:\n- ${problems.join('\n- ')}`)

  const sorted: VideoAssetMap = {
    ...result,
    videos: Object.fromEntries(Object.entries(result.videos).sort(([a], [b]) => Number(a) - Number(b))),
    assets: Object.fromEntries(Object.entries(result.assets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }
  writeJson(videoAssetMapPath(paths, dataset), sorted)
  const reused = Object.values(sorted.videos).filter((v) => v.mp4.origin === 'existing').length
  log(
    `videos: ${videos.length} originals and ${videos.length} MP4s in ${dataset} (${uploaded} uploaded, ${patched} metadata updates` +
      `${reused ? `, ${reused} existing conversions reused` : ''})`,
  )
  return sorted
}
