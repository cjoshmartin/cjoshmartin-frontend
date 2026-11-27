/**
 * Step: prune-mp4s (after import).
 *
 * Deletes the MP4s of the Wagtail videos that were made with other settings than the current
 * SETTINGS_VERSION (studio/functions/video-to-mp4/settings.ts), once nothing references them.
 * After a settings change the convert and videos steps make and upload new MP4s, and the import
 * points every video block at them; the old MP4s are then leftovers that the contract's reuse rule
 * must never pick up again (docs/sanity-migration/schema-contract.md, "Videos").
 *
 * Only assets with source {name: "video-to-mp4", id: <a migrated original>} are considered, so
 * conversions the video-to-mp4 Function made from Studio uploads are never touched, and neither
 * is the current MP4 of each video (state/videos-<dataset>.json). An old MP4 that a document still
 * references (a Studio document that uses it) stops the step: it lists the documents and deletes
 * nothing, because deleting it would break them.
 *
 * When it deletes anything, it first writes reports/wp3/pruned-mp4s-<dataset>-<time>.json with
 * the assets it is about to delete (outside git).
 */
import path from 'node:path'

import {
  CONVERTED_ASSET_SETTINGS_FIELD,
  CONVERTED_ASSET_SOURCE_NAME,
  SETTINGS_VERSION,
} from '../../../../studio/functions/video-to-mp4/settings'
import type {Dataset, DataPaths, Secrets} from '../config'
import {sanityClient} from '../sanity'
import {log, writeJson} from '../util'
import {readVideoAssetMap, videoAssetMapPath} from './videos'

export interface StaleMp4 {
  _id: string
  originalFilename?: string
  source: {name: string; id: string}
  settingsVersion: string | null
  size?: number
  /** Ids of the documents (drafts and versions included) that reference it. */
  referencedBy: string[]
}

/** The MP4s of migrated originals that are neither current nor made with the current settings. */
export function staleMp4Query(): string {
  return (
    `*[_type == "sanity.fileAsset" && source.name == $name && source.id in $originals && !(_id in $current) ` +
    `&& coalesce(${CONVERTED_ASSET_SETTINGS_FIELD}, "") != $settingsVersion]` +
    `{_id, originalFilename, source, "settingsVersion": ${CONVERTED_ASSET_SETTINGS_FIELD}, size, ` +
    `"referencedBy": *[references(^._id)]._id} | order(_id asc)`
  )
}

export async function pruneStaleMp4s(paths: DataPaths, dataset: Dataset, secrets: Secrets): Promise<StaleMp4[]> {
  const map = readVideoAssetMap(paths, dataset)
  if (!map) throw new Error(`${videoAssetMapPath(paths, dataset)} does not exist; run the videos step first`)
  if (map.settingsVersion !== SETTINGS_VERSION) {
    throw new Error(`${videoAssetMapPath(paths, dataset)} was made with ${map.settingsVersion}, the current settings are ${SETTINGS_VERSION}; run the videos step again`)
  }
  const videos = Object.values(map.videos)
  const originals = videos.map((v) => v.original.assetId)
  const current = videos.map((v) => v.mp4.assetId)
  const client = sanityClient(dataset, secrets)

  const stale = await client.fetch<StaleMp4[]>(staleMp4Query(), {
    name: CONVERTED_ASSET_SOURCE_NAME,
    originals,
    current,
    settingsVersion: SETTINGS_VERSION,
  })
  const inUse = stale.filter((asset) => asset.referencedBy.length > 0)
  if (inUse.length > 0) {
    throw new Error(
      `prune-mp4s: ${inUse.length} MP4(s) made with other settings are still used in ${dataset}; nothing was deleted:\n` +
        inUse.map((a) => `- ${a._id} (${a.settingsVersion ?? 'no settings version'}) used by ${a.referencedBy.join(', ')}`).join('\n') +
        '\nPoint those video blocks at the original upload again (the video-to-mp4 Function converts it), then rerun.',
    )
  }
  if (stale.length > 0) {
    const prunedAt = new Date().toISOString()
    writeJson(path.join(paths.reports, 'wp3', `pruned-mp4s-${dataset}-${prunedAt.replace(/[:.]/g, '-')}.json`), {
      dataset,
      settingsVersion: SETTINGS_VERSION,
      prunedAt,
      deleted: stale,
    })
  }
  for (const asset of stale) {
    await client.delete(asset._id)
    log(`  deleted ${asset._id} (${asset.originalFilename ?? 'no name'}, ${asset.settingsVersion ?? 'no settings version'}, made from ${asset.source.id})`)
  }
  log(`prune-mp4s: ${stale.length} MP4(s) made with other settings deleted from ${dataset}`)
  return stale
}
