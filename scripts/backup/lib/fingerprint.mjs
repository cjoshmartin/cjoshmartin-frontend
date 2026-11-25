import {createHash} from 'node:crypto'

// Plan §10, run logic step 1: hash the sorted `_id:_rev` pairs of every document
// in the raw perspective (drafts, release versions, system and asset documents
// included). Each pair is one line terminated by "\n", sorted by UTF-16 code
// unit order (JavaScript's default string order), so the result is independent
// of the order the export API streams documents in.
export const FINGERPRINT_ALGORITHM = 'sha256 of sorted "<_id>:<_rev>\\n" lines, one per document'

export function computeFingerprint(documents) {
  const lines = []
  const seen = new Set()
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') {
      throw new TypeError('Fingerprint input contains a non-object entry')
    }
    if (typeof doc._id !== 'string' || doc._id === '') {
      throw new TypeError('Fingerprint input contains a document without a string _id')
    }
    if (typeof doc._rev !== 'string' || doc._rev === '') {
      throw new TypeError(`Document ${doc._id} has no string _rev`)
    }
    if (seen.has(doc._id)) {
      throw new Error(`Document id ${doc._id} appears more than once in the export`)
    }
    seen.add(doc._id)
    lines.push(`${doc._id}:${doc._rev}\n`)
  }
  lines.sort()
  const hash = createHash('sha256')
  for (const line of lines) hash.update(line, 'utf8')
  return hash.digest('hex')
}
