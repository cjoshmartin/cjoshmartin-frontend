// Document id conventions in the Content Lake:
//   drafts.<id>                 draft
//   versions.<release>.<id>     version in a content release
//   _.<...>                     system document (groups, retention, releases, ...)
//   anything else               published document (asset documents included)

export function isSystemDocumentId(id) {
  return id.startsWith('_.')
}

// Release and variant definitions are the only system documents that
// `sanity datasets import` (and @sanity/export) carry over, because release
// versions and variant documents reference them. Every other system document
// (_.groups.*, _.retention.*, ...) is managed by Sanity and is never imported.
export function isImportableSystemDocumentId(id) {
  return id.startsWith('_.releases.') || id.startsWith('_.variants.')
}

export function documentKind(id) {
  if (id.startsWith('drafts.')) return 'draft'
  if (id.startsWith('versions.')) return 'version'
  if (isSystemDocumentId(id)) return 'system'
  return 'published'
}

export function countDocuments(documents) {
  const counts = {total: 0, published: 0, drafts: 0, versions: 0, system: 0, byType: {}}
  for (const doc of documents) {
    counts.total++
    const kind = documentKind(doc._id)
    if (kind === 'draft') counts.drafts++
    else if (kind === 'version') counts.versions++
    else if (kind === 'system') counts.system++
    else counts.published++
    counts.byType[doc._type] = (counts.byType[doc._type] ?? 0) + 1
  }
  counts.byType = Object.fromEntries(Object.entries(counts.byType).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return counts
}

export function sortById(documents) {
  return [...documents].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
}

export function toNdjson(documents) {
  return documents.map((doc) => `${JSON.stringify(doc)}\n`).join('')
}
