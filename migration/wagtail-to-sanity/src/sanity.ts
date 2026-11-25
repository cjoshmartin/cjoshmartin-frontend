import {createClient, type SanityClient} from '@sanity/client'

import {API_VERSION, PROJECT_ID, type Dataset, type Secrets} from './config'

export function sanityClient(dataset: Dataset, secrets: Secrets): SanityClient {
  return createClient({
    projectId: PROJECT_ID,
    dataset,
    apiVersion: API_VERSION,
    token: secrets.sanityWriteToken,
    useCdn: false,
    // Reads must see drafts and every version, never a perspective-filtered view.
    perspective: 'raw',
  })
}

/** Runs async work over items with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}
