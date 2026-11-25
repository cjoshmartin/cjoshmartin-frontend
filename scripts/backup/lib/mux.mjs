import {setTimeout as delay} from 'node:timers/promises'

import {fetchWithRetry, HttpError, saveResponseToFile} from './http.mjs'

// Video originals are archived through Mux "master access":
//   PUT /video/v1/assets/{id}/master-access {"master_access": "temporary"}
//   then poll GET /video/v1/assets/{id} until master.status == "ready"
//   and download master.url (an MP4 at the asset's max resolution tier).
// Mux lists no charge for master access. The only side effect is that an
// asset in infrequent or cold storage moves back to frequent storage and its
// cold-storage timer resets. Master access reverts to "none" by itself after
// 24 hours. Static renditions, the alternative, are a paid add-on that is
// billed for storage every month, so they are not used. See README.md.
export const MUX_API_BASE = 'https://api.mux.com'
export const MUX_ORIGINAL_EXTENSION = 'mp4'
export const MUX_METHOD = 'master-access'

export class MuxClient {
  constructor({tokenId, tokenSecret, fetchImpl, baseUrl = MUX_API_BASE, timeoutMs = 60_000, sleep}) {
    if (!tokenId || !tokenSecret) {
      throw new Error('MUX_TOKEN_ID and MUX_TOKEN_SECRET are required to archive Mux video originals')
    }
    this.authorization = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`
    this.fetchImpl = fetchImpl
    this.baseUrl = baseUrl
    this.timeoutMs = timeoutMs
    this.sleep = sleep
  }

  // Returns the asset object, or null when Mux answers 404.
  async getAsset(assetId) {
    const response = await fetchWithRetry(`${this.baseUrl}/video/v1/assets/${encodeURIComponent(assetId)}`, {
      label: `Mux GET asset ${assetId}`,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
      headers: {Authorization: this.authorization, Accept: 'application/json'},
      acceptStatuses: [404],
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    const json = await response.json()
    if (!json?.data || typeof json.data !== 'object') throw new Error(`Mux GET asset ${assetId} returned no data object`)
    return json.data
  }

  // PUT is idempotent here: setting "temporary" twice has the same effect.
  async enableTemporaryMasterAccess(assetId) {
    const response = await fetchWithRetry(`${this.baseUrl}/video/v1/assets/${encodeURIComponent(assetId)}/master-access`, {
      label: `Mux PUT master-access for asset ${assetId}`,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
      method: 'PUT',
      headers: {Authorization: this.authorization, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({master_access: 'temporary'}),
    })
    const json = await response.json()
    if (!json?.data || typeof json.data !== 'object') throw new Error(`Mux PUT master-access for ${assetId} returned no data object`)
    return json.data
  }
}

function describeAssetErrors(asset) {
  const messages = asset?.errors?.messages
  return Array.isArray(messages) && messages.length > 0 ? `: ${messages.join('; ')}` : ''
}

// Archives Mux originals. All waits are bounded: `timeoutMs` covers waiting
// for the asset to be ready plus waiting for the master, and
// `downloadTimeoutMs` covers the MP4 download.
export function createMuxArchiver({
  client,
  fetchImpl,
  pollIntervalMs = 5_000,
  timeoutMs = 20 * 60_000,
  downloadTimeoutMs = 30 * 60_000,
  sleep = delay,
  now = () => Date.now(),
  log = () => {},
}) {
  async function pollUntil(assetId, deadline, isDone, describeWait) {
    for (;;) {
      const asset = await client.getAsset(assetId)
      if (asset === null) return {asset: null}
      const done = isDone(asset)
      if (done) return {asset}
      if (now() >= deadline) {
        throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${describeWait(asset)} of Mux asset ${assetId}`)
      }
      await sleep(pollIntervalMs)
    }
  }

  // Read-only look at an asset, used by dry runs.
  async function inspect(assetId) {
    const asset = await client.getAsset(assetId)
    if (asset === null) return {available: false, reason: 'Mux asset not found (HTTP 404)'}
    if (asset.status === 'errored') return {available: false, reason: `Mux asset is errored${describeAssetErrors(asset)}`}
    return {available: true, status: asset.status, masterAccess: asset.master_access ?? 'none'}
  }

  // Downloads the master of one asset to destPath. Returns
  // {status: 'downloaded', ...} or {status: 'unavailable', reason} when Mux
  // has no original to give (asset deleted or errored). Throws on timeouts,
  // master errors and HTTP failures so the backup run fails and is retried.
  async function downloadOriginal(assetId, destPath) {
    const deadline = now() + timeoutMs
    let {asset} = await pollUntil(assetId, deadline, (a) => a.status !== 'preparing', () => 'processing')
    if (asset === null) return {status: 'unavailable', reason: 'Mux asset not found (HTTP 404)'}
    if (asset.status === 'errored') return {status: 'unavailable', reason: `Mux asset is errored${describeAssetErrors(asset)}`}
    if (asset.status !== 'ready') throw new Error(`Mux asset ${assetId} has unexpected status "${asset.status}"`)

    const masterUsable = (a) => a.master_access === 'temporary' && (a.master?.status === 'ready' || a.master?.status === 'preparing')
    if (!masterUsable(asset)) {
      log(`Requesting temporary master access for Mux asset ${assetId}`)
      asset = await client.enableTemporaryMasterAccess(assetId)
    }
    if (asset.master?.status !== 'ready' || !asset.master?.url) {
      const result = await pollUntil(
        assetId,
        deadline,
        (a) => a.master?.status === 'errored' || (a.master?.status === 'ready' && Boolean(a.master?.url)),
        () => 'the master file',
      )
      if (result.asset === null) return {status: 'unavailable', reason: 'Mux asset disappeared while preparing its master (HTTP 404)'}
      asset = result.asset
    }
    if (asset.master?.status === 'errored') {
      throw new Error(`Mux could not prepare the master file for asset ${assetId}${describeAssetErrors(asset)}`)
    }

    const response = await fetchWithRetry(asset.master.url, {
      label: `Download of the Mux master for asset ${assetId}`,
      fetchImpl,
      timeoutMs: downloadTimeoutMs,
      sleep,
      headers: {'Accept-Encoding': 'identity'},
    }).catch((error) => {
      if (error instanceof HttpError) error.message += ' (the master URL is valid for 24 hours; rerun the backup)'
      throw error
    })
    const saved = await saveResponseToFile(response, destPath, {label: `Download of the Mux master for asset ${assetId}`})
    return {
      status: 'downloaded',
      size: saved.size,
      sha256: saved.sha256,
      extension: MUX_ORIGINAL_EXTENSION,
      method: MUX_METHOD,
      details: {
        durationSeconds: asset.duration ?? null,
        resolutionTier: asset.resolution_tier ?? null,
        maxResolutionTier: asset.max_resolution_tier ?? null,
        videoQuality: asset.video_quality ?? null,
      },
    }
  }

  return {inspect, downloadOriginal}
}
