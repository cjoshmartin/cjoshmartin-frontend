import {useToast} from '@sanity/ui/toast'
import {useEffect} from 'react'
import {
  getPublishedId,
  useClient,
  useFormValue,
  type InputProps,
  type ObjectInputProps,
} from 'sanity'

import {SETTINGS_VERSION} from '../functions/video-to-mp4/settings'
import {
  isVideoDocumentType,
  VIDEO_FIELDS_BY_TYPE,
  type VideoDocumentType,
} from '../functions/video-to-mp4/trigger'
import {API_VERSION} from '../lib/constants'
import {
  nudgedConversion,
  RETRY_DELAY_SECONDS,
  videoConversionNudge,
  type VideoConversionValue,
  type VideoValue,
} from '../schemaTypes/shared/video-conversion'

/** How often an open document checks whether a video conversion in it is stuck. */
const CHECK_EVERY_MS = 60_000

interface StoredVideo extends VideoValue {
  _key?: string
}

interface StoredDocument {
  _id: string
  _rev: string
  _updatedAt?: string
  fields: Record<string, StoredVideo[] | null>
}

/**
 * When each block was last nudged (milliseconds), by dataset, document, field and block key.
 * Shared by every watcher in this browser tab, so a document that is open in several panes or
 * tools at once is nudged once.
 */
const lastNudges = new Map<string, number>()

/**
 * Every video block of the watched fields, in the draft and the published document. The field
 * names are the constants of VIDEO_FIELDS_BY_TYPE, which a test compares with the schema.
 */
function videoBlocksQuery(fields: readonly string[]): string {
  const projection = fields
    .map((field) => `${JSON.stringify(field)}: ${field}[_type == "video"]{_key, file, conversion}`)
    .join(', ')
  return `*[_id in $ids]{_id, _rev, _updatedAt, "fields": {${projection}}}`
}

/**
 * While the form of a document that can hold videos is open, checks its draft and published
 * document right away and then every minute. The video-to-mp4 Function only runs on a document
 * event, and nothing sends one when a conversion is stuck (a run that died, a retry that is due, an
 * event that was missed, a failure under older settings). For every such block
 * (videoConversionNudge) it writes the nudged `conversion` (nudgedConversion), one patch per
 * document with a revision check, and at most once per RETRY_DELAY_SECONDS per block. That write
 * is the event that starts the Function again.
 */
function useVideoConversionWatch(documentType: VideoDocumentType): void {
  const client = useClient({apiVersion: API_VERSION})
  const toast = useToast()
  const documentId = useFormValue(['_id']) as string | undefined

  useEffect(() => {
    if (!documentId) return
    // Whichever version the form shows (draft, published or a release version), the Function
    // converts the draft and the published document, so those are checked. It leaves release
    // versions alone until they are published.
    const publishedId = getPublishedId(documentId)
    const fields = VIDEO_FIELDS_BY_TYPE[documentType]
    const query = videoBlocksQuery(fields)
    const dataset = client.config().dataset ?? ''
    let cancelled = false
    let running = false

    const check = async () => {
      const docs = await client.fetch<StoredDocument[]>(
        query,
        {ids: [`drafts.${publishedId}`, publishedId]},
        {perspective: 'raw', tag: 'video-conversion.check'},
      )
      for (const doc of docs) {
        if (cancelled) return
        const now = new Date()
        const set: Record<string, VideoConversionValue> = {}
        const nudged: string[] = []
        for (const field of fields) {
          for (const block of doc.fields[field] ?? []) {
            if (typeof block._key !== 'string' || block._key === '') continue
            const reason = videoConversionNudge(block, doc._updatedAt, now, SETTINGS_VERSION)
            if (!reason) continue
            const nudgeKey = [dataset, doc._id, field, block._key].join(':')
            const last = lastNudges.get(nudgeKey)
            if (last !== undefined && now.getTime() - last < RETRY_DELAY_SECONDS * 1000) continue
            set[`${field}[_key==${JSON.stringify(block._key)}].conversion`] = nudgedConversion(
              block,
              reason,
              now,
            )
            nudged.push(nudgeKey)
          }
        }
        if (nudged.length === 0) continue
        try {
          await client
            .patch(doc._id)
            .ifRevisionId(doc._rev)
            .set(set)
            .commit({autoGenerateArrayKeys: false, tag: 'video-conversion.retry'})
        } catch (error) {
          // The document changed between the read and the patch: that change is itself an event
          // for the Function, and the next check looks again.
          if ((error as {statusCode?: number}).statusCode === 409) continue
          throw error
        }
        for (const key of nudged) lastNudges.set(key, now.getTime())
      }
    }

    const run = () => {
      // A check that is still waiting for the API is not started twice.
      if (running) return
      running = true
      check()
        .catch((error: unknown) => {
          console.error('video conversion check failed', error)
          toast.push({
            status: 'error',
            title: 'Could not restart a stuck video conversion',
            description: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          running = false
        })
    }
    run()
    const timer = setInterval(run, CHECK_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, documentId, documentType, toast])
}

function VideoConversionWatcher({
  documentType,
  inputProps,
}: {
  documentType: VideoDocumentType
  inputProps: ObjectInputProps
}) {
  useVideoConversionWatch(documentType)
  return inputProps.renderDefault(inputProps)
}

/**
 * `form.components.input` of both workspaces (sanity.config.ts). It wraps the root input of every
 * document type whose rich text can hold videos (VIDEO_FIELDS_BY_TYPE, the fields the
 * video-to-mp4 Function watches), so the check runs for as long as the document's form is open,
 * whichever field group, block or dialog is shown. Every other input renders as usual.
 */
export function VideoConversionDocumentInput(props: InputProps) {
  const {schemaType} = props
  const typeName = schemaType.name
  if (
    props.id === 'root' &&
    schemaType.type?.name === 'document' &&
    isVideoDocumentType(typeName)
  ) {
    return <VideoConversionWatcher documentType={typeName} inputProps={props as ObjectInputProps} />
  }
  return props.renderDefault(props)
}
