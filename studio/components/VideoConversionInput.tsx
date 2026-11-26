import {useToast} from '@sanity/ui/toast'
import {useEffect, useRef} from 'react'
import {useClient, useFormValue, type ObjectInputProps} from 'sanity'

import {API_VERSION} from '../lib/constants'
import {
  nudgedConversion,
  RETRY_DELAY_SECONDS,
  videoConversionNudge,
  type VideoValue,
} from '../schemaTypes/shared/video-conversion'

/** How often an open video block checks whether its conversion is stuck. */
const CHECK_EVERY_MS = 60_000

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

interface StoredDocument {
  _id: string
  _rev: string
  _updatedAt?: string
  block: VideoValue | null
}

/**
 * Input of the `video` block: the default form, plus a check while the document is open. The
 * video-to-mp4 Function only runs on a document event, and nothing sends one when a conversion is
 * stuck (a run that died, a retry that is due, an event that was missed). When this block is stuck
 * in the draft or the published document (videoConversionNudge), the check writes `pending` to
 * that block's `conversion`, which is the event that starts the Function again. It checks when the
 * block is shown and every minute after, and nudges a block at most once per RETRY_DELAY_SECONDS.
 */
export function VideoConversionInput(props: ObjectInputProps) {
  const {path, renderDefault} = props
  const client = useClient({apiVersion: API_VERSION})
  const toast = useToast()
  const documentId = useFormValue(['_id']) as string | undefined
  const field = path.length === 2 && typeof path[0] === 'string' ? path[0] : undefined
  const segment = path[1]
  const key =
    typeof segment === 'object' && segment !== null && '_key' in segment ? segment._key : undefined
  const lastNudge = useRef(0)

  useEffect(() => {
    if (!documentId || !field || !FIELD_NAME.test(field) || typeof key !== 'string') return
    const publishedId = documentId.replace(/^drafts\./, '')
    // Release versions are converted when they are published.
    if (publishedId.startsWith('versions.')) return
    let cancelled = false

    const check = async () => {
      if (Date.now() - lastNudge.current < RETRY_DELAY_SECONDS * 1000) return
      const docs = await client.fetch<StoredDocument[]>(
        `*[_id in $ids]{_id, _rev, _updatedAt, "block": ${field}[_key == $key][0]}`,
        {ids: [`drafts.${publishedId}`, publishedId], key},
        {perspective: 'raw', tag: 'video-conversion.check'},
      )
      for (const doc of docs) {
        if (cancelled || !doc.block) continue
        const now = new Date()
        const reason = videoConversionNudge(doc.block, doc._updatedAt, now)
        if (!reason) continue
        try {
          await client
            .patch(doc._id)
            .ifRevisionId(doc._rev)
            .set({
              [`${field}[_key==${JSON.stringify(key)}].conversion`]: nudgedConversion(
                doc.block,
                reason,
                now,
              ),
            })
            .commit({autoGenerateArrayKeys: false, tag: 'video-conversion.retry'})
          lastNudge.current = Date.now()
        } catch (error) {
          // The document changed between the read and the patch: that change is itself an event
          // for the Function, and the next check looks again.
          if ((error as {statusCode?: number}).statusCode === 409) continue
          throw error
        }
      }
    }

    const run = () => {
      check().catch((error: unknown) => {
        console.error('video conversion check failed', error)
        toast.push({
          status: 'error',
          title: 'Could not restart a stuck video conversion',
          description: error instanceof Error ? error.message : String(error),
        })
      })
    }
    run()
    const timer = setInterval(run, CHECK_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, documentId, field, key, toast])

  return renderDefault(props)
}
