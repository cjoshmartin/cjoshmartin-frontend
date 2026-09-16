'use client'

import { useState } from 'react'
import Image, { ImageProps } from 'next/image'
import Loader from '@/app/components/Loader/Loader'

interface LoadingImageProps extends ImageProps {
  wrapperStyle?: React.CSSProperties
}

/**
 * Drop-in replacement for `next/image`'s `Image` that overlays a small
 * loader until the image actually finishes loading in the browser. Works
 * the same for server-rendered and client-rendered images, since it's
 * driven by the image's own onLoad/onError rather than React Suspense
 * (Suspense can't observe a native <img> still downloading over the wire).
 */
export default function LoadingImage({ wrapperStyle, style, onLoad, onError, ...props }: LoadingImageProps) {
  const [loaded, setLoaded] = useState(false)

  return (
    <div style={{ position: 'relative', ...wrapperStyle }}>
      <Image
        {...props}
        style={{ ...style, opacity: loaded ? (style?.opacity ?? 1) : 0 }}
        onLoad={(e) => {
          setLoaded(true)
          onLoad?.(e)
        }}
        onError={(e) => {
          setLoaded(true)
          onError?.(e)
        }}
      />
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <Loader size="small" />
        </div>
      )}
    </div>
  )
}
