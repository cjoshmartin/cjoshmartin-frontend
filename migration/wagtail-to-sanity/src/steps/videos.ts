/**
 * Step `videos` (not part of the default run): adds the mux.videoAsset documents a dataset is
 * missing, and changes nothing else.
 *
 * This is the follow-up for videos Mux refused on the free plan once editors may have changed
 * content in the Studio: a full import would replace every migration document, this step only
 * creates `mux-video-<mediaId>` documents with createIfNotExists. The video blocks already hold
 * weak references to those ids, so each block plays as soon as its document exists. Run it after
 * the `mux` step has created the Mux assets:
 *
 *   npm run migrate -- --dataset production --confirm-production --steps mux,videos
 *
 * A document that already exists is left alone (and reported if it differs). The created
 * documents are added to state/imported-<dataset>.json so a later import's Studio-edit check
 * knows them. Afterwards every video block in the dataset must resolve to a ready video.
 */
import path from 'node:path'

import type {Dataset, DataPaths, Secrets} from '../config'
import {addToImportRecord, contentHash, type StoredDocument} from '../import-guard'
import {sanityClient} from '../sanity'
import {muxVideoDocument} from '../transform/documents'
import {log, readJson, writeJson} from '../util'
import {loadExport} from '../wagtail'
import {importRecordPath, readImportRecord} from './import'
import type {MuxMap} from './mux'

interface VideoBlockRefs {
  _id: string
  refs: (string | null)[] | null
}

export async function addMissingVideos(
  paths: DataPaths,
  dataset: Dataset,
  secrets: Secrets,
  options: {allowPendingVideos: boolean},
): Promise<void> {
  const data = loadExport(paths.exportJson)
  const mux = readJson<MuxMap>(path.join(paths.state, 'mux-map.json'))
  if (mux.pending.length && !options.allowPendingVideos) {
    throw new Error(
      `videos: ${mux.pending.length} videos are still pending on Mux (media ${mux.pending.map((p) => p.mediaId).join(', ')}). ` +
        'Run the mux step once Mux accepts them, or pass --allow-pending-videos to add only the ones that are ready.',
    )
  }
  const record = readImportRecord(paths, dataset)
  if (!record) {
    throw new Error(
      `videos: there is no import record for ${dataset} (${importRecordPath(paths, dataset)}). ` +
        'Import the dataset (or record an untouched one with --steps baseline) first.',
    )
  }

  const wanted = [...data.media]
    .sort((a, b) => a.id - b.id)
    .flatMap((media) => {
      const video = mux.videos[String(media.id)]
      return video ? [muxVideoDocument(media.id, video)] : []
    })
  const client = sanityClient(dataset, secrets)
  const existing = await client.fetch<StoredDocument[]>(`*[_id in $ids]`, {ids: wanted.map((doc) => doc._id)})
  const existingById = new Map(existing.map((doc) => [doc._id, doc]))
  const differing = wanted.filter((doc) => {
    const stored = existingById.get(doc._id)
    return stored && contentHash(stored) !== contentHash(doc)
  })
  if (differing.length) {
    log(`videos: left unchanged because they already exist with other content: ${differing.map((d) => d._id).join(', ')}`)
  }

  const missing = wanted.filter((doc) => !existingById.has(doc._id))
  if (missing.length) {
    const tx = client.transaction()
    for (const doc of missing) tx.createIfNotExists(doc)
    await tx.commit({visibility: 'sync'})
    const created = await client.fetch<StoredDocument[]>(`*[_id in $ids]`, {ids: missing.map((doc) => doc._id)})
    const createdById = new Map(created.map((doc) => [doc._id, doc]))
    const updated = addToImportRecord(
      record,
      'videos',
      missing.map((expected) => {
        const doc = createdById.get(expected._id)
        if (!doc) throw new Error(`videos: ${expected._id} is missing right after it was created`)
        return {doc, expected}
      }),
    )
    writeJson(importRecordPath(paths, dataset), updated)
  }
  log(`videos: ${missing.length} mux.videoAsset documents created, ${wanted.length - missing.length} already present`)

  // Every video block, in every published document and draft, must now point at a video document.
  const videoIds = new Set(await client.fetch<string[]>(`*[_type == "mux.videoAsset"]._id`))
  const blocks = await client.fetch<VideoBlockRefs[]>(
    `*[!(_id in path("_.**")) && !(_id in path("versions.**")) && count(body[_type == "video"]) > 0]{_id, "refs": body[_type == "video"].asset.asset._ref}`,
  )
  const unresolved = blocks.flatMap((doc) =>
    (doc.refs ?? []).filter((ref) => !ref || !videoIds.has(ref)).map((ref) => `${doc._id} -> ${ref ?? '(no reference)'}`),
  )
  const blockCount = blocks.reduce((sum, doc) => sum + (doc.refs ?? []).length, 0)
  if (unresolved.length && !(options.allowPendingVideos && mux.pending.length)) {
    throw new Error(`videos: ${unresolved.length} of ${blockCount} video blocks do not resolve:\n- ${unresolved.join('\n- ')}`)
  }
  log(`videos: ${blockCount - unresolved.length} of ${blockCount} video blocks resolve to a mux.videoAsset document`)
}
