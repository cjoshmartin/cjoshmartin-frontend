import {fetchWithRetry} from './http.mjs'
import {assertDatasetName, assertProjectId, SANITY_API_VERSION} from './sanity-export.mjs'

// Sends mutations through the Mutate API in batches, one transaction per
// batch. Callers only pass idempotent mutations (deletes, and patches that
// set or unset fixed values), so a retried batch is safe.
async function mutateInBatches({projectId, dataset, token, mutations, describeBatch, tag, fetchImpl, batchSize = 100, apiVersion = SANITY_API_VERSION}) {
  assertProjectId(projectId)
  assertDatasetName(dataset)
  if (!token) throw new Error('Changing documents needs SANITY_WRITE_TOKEN (Editor role)')
  const url = `https://${projectId}.api.sanity.io/${apiVersion}/data/mutate/${dataset}?returnIds=true&visibility=sync&tag=${tag}`
  let applied = 0
  for (let start = 0; start < mutations.length; start += batchSize) {
    const batch = mutations.slice(start, start + batchSize)
    const response = await fetchWithRetry(url, {
      label: `Sanity ${describeBatch(batch.length)} in ${projectId}/${dataset}`,
      fetchImpl,
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({mutations: batch}),
    })
    const json = await response.json()
    if (!Array.isArray(json?.results)) throw new Error('Sanity mutate API returned no results array')
    applied += json.results.length
  }
  return applied
}

// Deletes documents. Deleting an id that no longer exists is a no-op.
export async function deleteDocuments({projectId, dataset, token, ids, fetchImpl, batchSize, apiVersion}) {
  return mutateInBatches({
    projectId,
    dataset,
    token,
    mutations: ids.map((id) => ({delete: {id}})),
    describeBatch: (count) => `delete of ${count} documents`,
    tag: 'sanity.restore.exact',
    fetchImpl,
    batchSize,
    apiVersion,
  })
}

// Applies {id, set, unset} patches, as planned by planAssetMetadataPatches.
// Each patch sets whole top-level fields to fixed values and unsets others,
// so applying it twice gives the same result.
export async function patchDocuments({projectId, dataset, token, patches, fetchImpl, batchSize, apiVersion}) {
  const mutations = patches.map(({id, set, unset}) => ({
    patch: {
      id,
      ...(set && Object.keys(set).length > 0 ? {set} : {}),
      ...(unset && unset.length > 0 ? {unset} : {}),
    },
  }))
  for (const {patch} of mutations) {
    if (!patch.set && !patch.unset) throw new Error(`Patch for ${patch.id} neither sets nor unsets anything`)
  }
  return mutateInBatches({
    projectId,
    dataset,
    token,
    mutations,
    describeBatch: (count) => `patch of ${count} asset documents`,
    tag: 'sanity.restore.asset-metadata',
    fetchImpl,
    batchSize,
    apiVersion,
  })
}
