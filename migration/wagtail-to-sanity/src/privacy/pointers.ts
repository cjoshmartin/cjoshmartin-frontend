/**
 * Public pointers to assets that are no longer in the dataset (privacy review round 2, finding 1).
 *
 * An asset id names the asset's content-addressed CDN URL (`image-<sha1>-<w>x<h>-<ext>`,
 * `file-<sha1>-<ext>`), and the asset CDN keeps serving a deleted asset for up to 30 days. A
 * document that names a deleted asset, in any field, tells anyone where its bytes may still be
 * downloaded; for a replaced upload those are the bytes with the location. Every document is
 * public in these datasets except drafts, release versions and ids with a path (`secrets.`).
 */

const ASSET_ID = /\b(?:image-[0-9a-f]{40}-\d+x\d+-[A-Za-z0-9]+|file-[0-9a-f]{40}-[A-Za-z0-9]+)\b/g

export interface DanglingPointer {
  documentId: string
  /** Field path, with array members as `[]`. */
  path: string
  /** The first 12 characters of the missing asset id's sha1, enough to tell them apart in a report. */
  sha1Prefix: string
}

/** Every string in `docs` that names an image or file asset id not in `assetIds`. */
export function danglingAssetPointers(docs: readonly Record<string, unknown>[], assetIds: ReadonlySet<string>): DanglingPointer[] {
  const found: DanglingPointer[] = []
  for (const doc of docs) {
    const documentId = String(doc._id)
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        for (const match of value.matchAll(ASSET_ID)) {
          if (!assetIds.has(match[0])) found.push({documentId, path, sha1Prefix: match[0].split('-')[1]!.slice(0, 12)})
        }
      } else if (Array.isArray(value)) {
        value.forEach((member) => walk(member, `${path}[]`))
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key)
      }
    }
    walk(doc, '')
  }
  return found
}
