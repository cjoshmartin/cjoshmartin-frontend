import {fetchWithRetry} from './http.mjs'

export const SANITY_API_VERSION = 'v2025-02-19'

const PROJECT_ID_PATTERN = /^[a-z0-9]+$/
// Dataset names: lowercase letters, digits, "_" and "-", up to 64 characters.
const DATASET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid Sanity project id: ${JSON.stringify(projectId)}`)
  }
}

export function assertDatasetName(dataset) {
  if (typeof dataset !== 'string' || !DATASET_PATTERN.test(dataset)) {
    throw new Error(`Invalid Sanity dataset name: ${JSON.stringify(dataset)}`)
  }
}

// Parses an Export API response body. The API streams one document per line
// in no particular order. If something fails after the stream started, the
// status stays 200 and the last line is {"error": {...}}, so every line is
// checked for an `error` key before the export is treated as complete.
export function parseExportNdjson(text) {
  const documents = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`Export line ${index + 1} is not valid JSON: ${error.message}`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Export line ${index + 1} is not a JSON object`)
    }
    if ('error' in value && !('_id' in value)) {
      const {type, description} = value.error ?? {}
      throw new Error(`Export stream ended with an error (${type ?? 'unknown type'}): ${description ?? JSON.stringify(value.error)}`)
    }
    if ('nextCursor' in value && !('_id' in value)) {
      throw new Error('Export stream contained a cursor object, but this client never requests cursor mode')
    }
    if (typeof value._id !== 'string' || typeof value._type !== 'string') {
      throw new Error(`Export line ${index + 1} has no string _id and _type`)
    }
    documents.push(value)
  }
  return documents
}

// Exports every document the token can read: published documents, drafts,
// release versions, asset documents and system documents. A Viewer token can
// read drafts. Stream mode (the default) returns a consistent point-in-time
// view, so the fingerprint and the snapshot always describe the same state.
export async function exportDataset({projectId, dataset, token, apiVersion = SANITY_API_VERSION, fetchImpl, timeoutMs = 10 * 60_000}) {
  assertProjectId(projectId)
  assertDatasetName(dataset)
  if (typeof token !== 'string' || token === '') {
    throw new Error('A Sanity token with read access to drafts (Viewer role) is required; without one the export only returns published documents')
  }
  const url = `https://${projectId}.api.sanity.io/${apiVersion}/data/export/${dataset}?tag=sanity.backup`
  const response = await fetchWithRetry(url, {
    label: `Sanity export of ${projectId}/${dataset}`,
    fetchImpl,
    timeoutMs,
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/x-ndjson'},
  })
  const text = await response.text()
  return parseExportNdjson(text)
}
