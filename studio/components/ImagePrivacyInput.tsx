import {Card, Text} from '@sanity/ui'
import {useEffect, useState} from 'react'
import {useClient, type InputProps} from 'sanity'

import type {AssetPrivacy} from '../functions/privacy/constants'
import {API_VERSION} from '../lib/constants'
import {imagePrivacyLabel, imagePrivacyState} from '../schemaTypes/shared/image-privacy'

/** An upload this recent without a `privacy` field is shown as "being checked". */
const RECENT_UPLOAD_MS = 10 * 60 * 1000

interface AssetSummary {
  _createdAt?: string
  privacy?: AssetPrivacy
}

/**
 * Input of every image field and type: the usual image input, and under it what the image-privacy
 * Function found or is doing (checking, removing, removed, retrying, failed). It follows the asset
 * document live, so the line changes as the Function works and when it points the field at the
 * stripped copy.
 */
export function ImagePrivacyInput(props: InputProps) {
  const assetId = (props.value as {asset?: {_ref?: string}} | undefined)?.asset?._ref
  const client = useClient({apiVersion: API_VERSION})
  const [asset, setAsset] = useState<AssetSummary | null>(null)

  useEffect(() => {
    setAsset(null)
    if (!assetId) return
    let cancelled = false
    const query = '*[_id == $id][0]{_createdAt, privacy}'
    client
      .fetch<AssetSummary | null>(query, {id: assetId}, {tag: 'image-privacy.status'})
      .then((result) => {
        if (!cancelled) setAsset(result)
      })
      .catch((error: unknown) => console.error('image privacy status', error))
    const subscription = client
      .listen<AssetSummary>('*[_id == $id]', {id: assetId}, {includeResult: true, visibility: 'query', tag: 'image-privacy.listen'})
      .subscribe({
        next: (event) => {
          if (!cancelled && event.type === 'mutation' && event.result) setAsset(event.result)
        },
        error: (error: unknown) => console.error('image privacy status', error),
      })
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [assetId, client])

  const label =
    assetId && asset
      ? imagePrivacyLabel(
          imagePrivacyState(asset.privacy),
          Date.now() - Date.parse(asset._createdAt ?? '') < RECENT_UPLOAD_MS,
        )
      : null
  return (
    <>
      {props.renderDefault(props)}
      {label && (
        <Card marginTop={2} padding={2} radius={2} tone={label.tone} border>
          <Text size={1}>{label.text}</Text>
        </Card>
      )}
    </>
  )
}
