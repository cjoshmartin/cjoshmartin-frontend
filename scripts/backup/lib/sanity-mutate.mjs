import {fetchWithRetry} from './http.mjs'
import {assertDatasetName, assertProjectId, SANITY_API_VERSION} from './sanity-export.mjs'

// Deletes documents through the Mutate API in batches. Deleting an id that no
// longer exists is a no-op, so a retried batch is safe.
export async function deleteDocuments({projectId, dataset, token, ids, fetchImpl, batchSize = 100, apiVersion = SANITY_API_VERSION}) {
  assertProjectId(projectId)
  assertDatasetName(dataset)
  if (!token) throw new Error('Deleting documents needs SANITY_WRITE_TOKEN (Editor role)')
  const url = `https://${projectId}.api.sanity.io/${apiVersion}/data/mutate/${dataset}?returnIds=true&visibility=sync&tag=sanity.restore.exact`
  let deleted = 0
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize)
    const response = await fetchWithRetry(url, {
      label: `Sanity delete of ${batch.length} documents in ${projectId}/${dataset}`,
      fetchImpl,
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({mutations: batch.map((id) => ({delete: {id}}))}),
    })
    const json = await response.json()
    if (!Array.isArray(json?.results)) throw new Error('Sanity mutate API returned no results array')
    deleted += json.results.length
  }
  return deleted
}
