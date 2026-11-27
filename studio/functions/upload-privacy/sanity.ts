/**
 * The upload-privacy Function's store on top of @sanity/client: the image-privacy Function's store
 * (raw perspective, revision-checked patches, the reference query and the guarded delete) plus the
 * sweep query.
 */
import type {SanityClient} from '@sanity/client'

import {createSanityImageStore} from '../image-privacy/sanity'
import type {ImageStore} from '../image-privacy/orchestrator'
import type {UploadStore} from './orchestrator'
import {SWEEP_QUERY, sweepParams} from './trigger'

export function createSanityUploadStore(client: SanityClient, options: {deadline: number}): UploadStore & ImageStore {
  const imageStore = createSanityImageStore(client, options)
  const raw = client.withConfig({perspective: 'raw', useCdn: false})
  return {
    ...imageStore,
    async sweepCandidates(exclude) {
      return raw.fetch<string[]>(SWEEP_QUERY, sweepParams(exclude), {tag: 'upload-privacy.sweep'})
    },
  }
}
