/**
 * Which upload a stripped copy was made from, without publishing the upload's asset id (privacy
 * review round 2, finding 1).
 *
 * An asset id names the asset's content-addressed CDN URL, and the asset CDN keeps serving a
 * deleted asset for up to 30 days (private-fetch.ts). The datasets are public, so a copy's
 * `privacy.strippedFrom` and `source.id` holding the unstripped upload's id told anyone where the
 * deleted bytes with their location could still be downloaded. A copy now records a keyed digest
 * instead: HMAC-SHA256 of the upload's asset id with the owner's key PRIVACY_LINK_KEY (a Function
 * environment variable, and in the migration's secrets.env). Whoever has the key can tell which
 * upload a copy came from (the Functions use it to find an upload's earlier copy); nobody else can
 * get from the digest to the id, or confirm a guessed id.
 */
import {createHmac} from 'node:crypto'

/** Name of the environment variable that holds the key (64 hex digits: 32 random bytes). */
export const PRIVACY_LINK_KEY_ENV = 'PRIVACY_LINK_KEY'

/** Prefix of every digest, so a digest is never mistaken for an asset id. */
export const UPLOAD_DIGEST_PREFIX = 'hmac-sha256:'

/**
 * `source.id` of a copy made while the key is missing (the Assets API requires a source id with a
 * source name). The copy is then not linked to its upload at all; the Function logs it.
 */
export const UNLINKED_SOURCE_ID = 'unlinked'

const KEY_PATTERN = /^[0-9a-f]{64}$/

/** Turns an upload's asset id into its digest. */
export type UploadDigester = (uploadAssetId: string) => string

export function uploadDigest(uploadAssetId: string, key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error(`${PRIVACY_LINK_KEY_ENV} must be 64 hexadecimal digits (32 random bytes)`)
  return `${UPLOAD_DIGEST_PREFIX}${createHmac('sha256', Buffer.from(key, 'hex')).update(uploadAssetId, 'utf8').digest('hex')}`
}

/**
 * The digester for the key in the environment, or undefined when PRIVACY_LINK_KEY is not set.
 * Throws when it is set but malformed (a configuration error, not a missing link).
 */
export function uploadDigesterFromEnv(env: Record<string, string | undefined> = process.env): UploadDigester | undefined {
  const key = env[PRIVACY_LINK_KEY_ENV]?.trim()
  if (!key) return undefined
  uploadDigest('check', key)
  return (uploadAssetId) => uploadDigest(uploadAssetId, key)
}

/** `source.id` of a copy of `uploadAssetId`: its digest, or UNLINKED_SOURCE_ID without a key. */
export function copySourceId(uploadAssetId: string, digest: UploadDigester | undefined): string {
  return digest ? digest(uploadAssetId) : UNLINKED_SOURCE_ID
}

/** Whether a value is a digest (never an asset id). */
export function isUploadDigest(value: unknown): value is string {
  return typeof value === 'string' && /^hmac-sha256:[0-9a-f]{64}$/.test(value)
}
