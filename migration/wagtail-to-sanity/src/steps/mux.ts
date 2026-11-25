/**
 * Step 3: videos.
 *
 * Creates one Mux asset per Wagtail media item from its public bucket URL (basic video quality,
 * public playback, passthrough "wagtail-media-<id>"). Before creating anything it lists every Mux
 * asset in the environment and reuses the one whose passthrough matches, so reruns and
 * interrupted runs never upload a video twice. Then it waits until every asset is ready.
 *
 * Mux assets are shared by all datasets (one Mux environment), so the map is
 * state/mux-map.json, not per dataset. The transform turns it into mux.videoAsset documents.
 */
import path from 'node:path'

import {gcsPublicUrl, MUX_PASSTHROUGH_PREFIX, type DataPaths, type Secrets} from '../config'
import {log, readJson, sleep, writeJson} from '../util'
import {loadExport} from '../wagtail'
import type {Inventory} from './extract'

const MUX_API = 'https://api.mux.com'
const POLL_INTERVAL_MS = 10_000
const READY_TIMEOUT_MS = 45 * 60 * 1000

export interface MuxAsset {
  id: string
  status: 'preparing' | 'ready' | 'errored'
  passthrough?: string
  playback_ids?: {id: string; policy: string}[]
  video_quality?: string
  errors?: {type?: string; messages?: string[]}
  [key: string]: unknown
}

export interface MuxMapEntry {
  mediaId: number
  passthrough: string
  sourceUrl: string
  filename: string
  assetId: string
  playbackId: string
  status: string
  /** Full asset JSON from GET /video/v1/assets/{id}. */
  asset: MuxAsset
}

export interface PendingVideo {
  mediaId: number
  passthrough: string
  sourceUrl: string
  reason: string
}

export interface MuxMap {
  updatedAt: string
  videos: Record<string, MuxMapEntry>
  /**
   * Media items that have no Mux asset yet because Mux refused to create one (the free plan's
   * asset limit). Only allowed with --allow-pending-videos; validation fails while any remain.
   */
  pending: PendingVideo[]
}

/** Mux's answer when the environment is on the free plan and already holds its 10 assets. */
export class MuxAssetLimitError extends Error {}

export class MuxClient {
  private readonly auth: string

  constructor(secrets: Secrets) {
    this.auth = 'Basic ' + Buffer.from(`${secrets.muxTokenId}:${secrets.muxTokenSecret}`).toString('base64')
  }

  async request<T>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(MUX_API + pathname, {
        method,
        headers: {Authorization: this.auth, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      if (response.ok) return (await response.json()) as T
      const text = await response.text()
      // Rate limits and server errors are retried; anything else is a real failure.
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        log(`  Mux ${method} ${pathname} -> ${response.status}, retrying`)
        await sleep(2000 * attempt)
        continue
      }
      const message = `Mux ${method} ${pathname} failed with ${response.status}: ${text.slice(0, 2000)}`
      if (response.status === 400 && /free plan is limited to \d+ assets/i.test(text)) {
        throw new MuxAssetLimitError(message)
      }
      throw new Error(message)
    }
  }

  async listAllAssets(): Promise<MuxAsset[]> {
    const all: MuxAsset[] = []
    const limit = 100
    for (let page = 1; ; page++) {
      const {data} = await this.request<{data: MuxAsset[]}>('GET', `/video/v1/assets?limit=${limit}&page=${page}`)
      all.push(...data)
      if (data.length < limit) return all
    }
  }

  async getAsset(id: string): Promise<MuxAsset> {
    return (await this.request<{data: MuxAsset}>('GET', `/video/v1/assets/${encodeURIComponent(id)}`)).data
  }

  async createAsset(url: string, passthrough: string): Promise<MuxAsset> {
    return (
      await this.request<{data: MuxAsset}>('POST', '/video/v1/assets', {
        inputs: [{url}],
        playback_policies: ['public'],
        video_quality: 'basic',
        passthrough,
      })
    ).data
  }
}

/**
 * The asset JSON stored in mux.videoAsset `data`, in its steady state. Temporary master access,
 * which the weekly backup requests to download each original and which Mux reverts after 24 hours,
 * adds a signed download URL (`master.url`) and sets `master_access` to "temporary". Neither may
 * end up in a public document, and recording them would make a rerun's output depend on when the
 * last backup ran. The steady state is `master_access: "none"` with no `master` object.
 */
export function steadyStateAsset(asset: MuxAsset): MuxAsset {
  const withoutMaster = Object.fromEntries(Object.entries(asset).filter(([key]) => key !== 'master')) as MuxAsset
  return {...withoutMaster, master_access: 'none'}
}

function publicPlaybackId(asset: MuxAsset): string {
  const id = asset.playback_ids?.find((p) => p.policy === 'public')?.id
  if (!id) throw new Error(`Mux asset ${asset.id} (${asset.passthrough}) has no public playback id`)
  return id
}

/**
 * Mux is one environment for both datasets, so this step does not depend on the dataset. With
 * `allowPendingVideos`, a refusal because of the free plan's asset limit records the remaining
 * videos as pending instead of failing (the CLI only accepts that for production together with
 * --confirm-production); validation keeps failing until they are on Mux.
 */
export async function migrateVideos(
  paths: DataPaths,
  secrets: Secrets,
  options: {allowPendingVideos: boolean},
): Promise<MuxMap> {
  const data = loadExport(paths.exportJson)
  const inventory = readJson<Inventory>(path.join(paths.state, 'inventory.json'))
  const mux = new MuxClient(secrets)
  const mapPath = path.join(paths.state, 'mux-map.json')

  const existing = await mux.listAllAssets()
  const byPassthrough = new Map<string, MuxAsset[]>()
  for (const asset of existing) {
    if (!asset.passthrough) continue
    byPassthrough.set(asset.passthrough, [...(byPassthrough.get(asset.passthrough) ?? []), asset])
  }
  log(`mux: ${existing.length} assets in the Mux environment, ${data.media.length} Wagtail media items`)

  const assetIds = new Map<number, string>()
  const pending: PendingVideo[] = []
  let limitError: MuxAssetLimitError | null = null
  let created = 0
  for (const media of [...data.media].sort((a, b) => a.id - b.id)) {
    const passthrough = `${MUX_PASSTHROUGH_PREFIX}${media.id}`
    const file = inventory.mediaFiles[String(media.id)]
    if (!file) throw new Error(`media ${media.id} has no file in the bucket mirror`)
    const matches = byPassthrough.get(passthrough) ?? []
    if (matches.length > 1) {
      throw new Error(
        `Mux has ${matches.length} assets with passthrough ${passthrough} (${matches.map((m) => m.id).join(', ')}). ` +
          'Delete the extra ones in the Mux dashboard, then rerun.',
      )
    }
    const match = matches[0]
    if (match) {
      if (match.status === 'errored') {
        throw new Error(`Mux asset ${match.id} for ${passthrough} errored: ${JSON.stringify(match.errors)}`)
      }
      assetIds.set(media.id, match.id)
      continue
    }
    if (limitError) {
      pending.push({mediaId: media.id, passthrough, sourceUrl: gcsPublicUrl(file), reason: limitError.message})
      continue
    }
    try {
      const asset = await mux.createAsset(gcsPublicUrl(file), passthrough)
      created++
      log(`  created Mux asset for media ${media.id} (${file})`)
      assetIds.set(media.id, asset.id)
    } catch (error) {
      if (!(error instanceof MuxAssetLimitError)) throw error
      // Every further create would be refused the same way.
      limitError = error
      pending.push({mediaId: media.id, passthrough, sourceUrl: gcsPublicUrl(file), reason: error.message})
    }
  }
  if (limitError && !options.allowPendingVideos) {
    throw new Error(
      `${limitError.message}\n${pending.length} of ${data.media.length} videos have no Mux asset ` +
        `(media ${pending.map((p) => p.mediaId).join(', ')}). Upgrade the Mux environment from the free plan, ` +
        'then rerun. To import everything else without them, pass --allow-pending-videos.',
    )
  }

  // Wait until every asset is ready.
  const started = Date.now()
  const ready = new Map<number, MuxAsset>()
  while (ready.size < assetIds.size) {
    for (const [mediaId, assetId] of assetIds) {
      if (ready.has(mediaId)) continue
      const asset = await mux.getAsset(assetId)
      if (asset.status === 'errored') {
        throw new Error(`Mux asset ${assetId} (media ${mediaId}) errored: ${JSON.stringify(asset.errors)}`)
      }
      if (asset.status === 'ready') ready.set(mediaId, asset)
    }
    if (ready.size < assetIds.size) {
      if (Date.now() - started > READY_TIMEOUT_MS) {
        const waiting = [...assetIds.keys()].filter((id) => !ready.has(id))
        throw new Error(`Mux assets for media ${waiting.join(', ')} were not ready after ${READY_TIMEOUT_MS / 60000} min`)
      }
      log(`  waiting for Mux: ${ready.size}/${assetIds.size} ready`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  const map: MuxMap = {updatedAt: new Date().toISOString(), videos: {}, pending}
  for (const media of [...data.media].sort((a, b) => a.id - b.id)) {
    const asset = ready.get(media.id)
    if (!asset) {
      if (pending.some((p) => p.mediaId === media.id)) continue
      throw new Error(`media ${media.id} has neither a ready Mux asset nor a pending entry`)
    }
    const passthrough = `${MUX_PASSTHROUGH_PREFIX}${media.id}`
    if (asset.passthrough !== passthrough) {
      throw new Error(`Mux asset ${asset.id} has passthrough ${asset.passthrough}, expected ${passthrough}`)
    }
    if (asset.video_quality !== 'basic') {
      throw new Error(`Mux asset ${asset.id} (media ${media.id}) has video_quality ${asset.video_quality}, expected basic`)
    }
    const file = inventory.mediaFiles[String(media.id)]!
    map.videos[String(media.id)] = {
      mediaId: media.id,
      passthrough,
      sourceUrl: gcsPublicUrl(file),
      filename: path.posix.basename(file),
      assetId: asset.id,
      playbackId: publicPlaybackId(asset),
      status: asset.status,
      asset: steadyStateAsset(asset),
    }
  }
  writeJson(mapPath, map)
  log(`mux: ${ready.size} videos ready (${created} created now, ${ready.size - created} reused)`)
  if (pending.length) {
    log(
      `mux: WARNING ${pending.length} videos are PENDING (media ${pending.map((p) => p.mediaId).join(', ')}): ` +
        `${pending[0]!.reason}. Validation fails until they are on Mux.`,
    )
  }
  return map
}
