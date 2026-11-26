/**
 * Downloads an asset's stored bytes from the Sanity CDN and checks them against the asset's sha1.
 *
 * Files are served as stored. Images are served re-encoded unless the request asks for the original
 * with `dlRaw`, which needs a token, so images are fetched with the token and `?dlRaw=true`.
 * The token is sent only in the Authorization header and never logged.
 */
import {createHash} from 'node:crypto'
import {mkdirSync, renameSync, rmSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'

export interface DownloadableAsset {
  _id: string
  _type: string
  url?: string
  sha1hash?: string
  extension?: string
}

export function assetDownloadUrl(asset: DownloadableAsset): string {
  if (!asset.url) throw new Error(`${asset._id} has no url`)
  if (asset._type === 'sanity.imageAsset') return `${asset.url}?dlRaw=true`
  return asset.url
}

/** Downloads `asset` to `<dir>/<sha1>.<extension>` and returns the path; fails on any sha1 mismatch. */
export async function downloadAsset(asset: DownloadableAsset, dir: string, token: string): Promise<string> {
  if (!asset.sha1hash) throw new Error(`${asset._id} has no sha1hash`)
  const url = assetDownloadUrl(asset)
  mkdirSync(dir, {recursive: true, mode: 0o700})
  const file = path.join(dir, `${asset.sha1hash}.${asset.extension ?? 'bin'}`)
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10 * 60 * 1000)})
      if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const sha1 = createHash('sha1').update(bytes).digest('hex')
      if (sha1 !== asset.sha1hash) throw new Error(`${url} has sha1 ${sha1}, the asset says ${asset.sha1hash}`)
      const partial = `${file}.partial`
      await writeFile(partial, bytes)
      renameSync(partial, file)
      return file
    } catch (error) {
      lastError = error
      rmSync(`${file}.partial`, {force: true})
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
