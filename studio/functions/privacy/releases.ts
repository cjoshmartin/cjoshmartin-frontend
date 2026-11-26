/**
 * Release versions (`versions.<release>.<document id>`) and when the Functions may write to them.
 * A version can be edited while its release is `active`; a scheduled, published or archived
 * release is locked (see https://www.sanity.io/docs/content-lake/content-release-document-flow).
 */

/** The release name of a version id, or null for drafts and published documents. */
export function releaseOfVersion(id: string): string | null {
  const match = /^versions\.([^.]+)\./.exec(id)
  return match ? match[1] : null
}

/** The `_id` of a release's system document. */
export function releaseDocumentId(release: string): string {
  return `_.releases.${release}`
}

/** The only release state in which its versions can be edited. */
export const EDITABLE_RELEASE_STATE = 'active'

/**
 * Whether a document can be written: drafts and published documents always, a version only while
 * `releaseState` (the state of its release document, read by the caller) is active.
 */
export function isWritableDocument(id: string, releaseState: string | null | undefined): boolean {
  return releaseOfVersion(id) === null || releaseState === EDITABLE_RELEASE_STATE
}
