'use client'
import { motion } from 'framer-motion';
import { useState } from 'react';
import styles from './ShowImage.module.css';
import Loader from '@/app/components/Loader/Loader';

export default function ShowImage({
  url,
  defaultUrl,
  alt,
  width,
  height,
  className,
  wrapperClassName,
  initial,
  animate,
  exit,
  shouldHideImageOnFail,
}: any) {
  const [imgError, setImgError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // A cached image can fire its native `load` event before React finishes
  // attaching the onLoad handler, so check `complete` directly on mount too.
  const checkAlreadyLoaded = (node: HTMLImageElement | null) => {
    if (node?.complete) {
      setLoaded(true);
    }
  };

  if (shouldHideImageOnFail && imgError) {
    return null;
  }

  if (url && !imgError) {
    return (
      <div className={wrapperClassName} style={{ position: 'relative', flexShrink: 0 }}>
        <motion.img
          src={url}
          alt={alt}
          width={width}
          height={height}
          className={`${styles.image} ${className}`}
          initial={initial ?? { opacity: 0 }}
          animate={animate ?? { opacity: 1, transition: { delay: 0.1 } }}
          exit={exit ?? { opacity: 0 }}
          key={alt}
          ref={checkAlreadyLoaded}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setImgError(true);
          }}
        />
        {!loaded && (
          <div className={`${styles.image} ${className}`} style={{ position: 'absolute', inset: 0, backgroundColor: 'black' }}>
            <Loader size="small" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={wrapperClassName} style={{ position: 'relative', flexShrink: 0 }}>
      <motion.img
        src={
          defaultUrl ??
          "https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?ixlib=rb-1.2.1&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1170&q=80"
        }
        alt="Default image for blog post when there is not an image to show"
        width={width}
        height={height}
        className={className}
        initial={initial ?? { opacity: 0 }}
        animate={animate ?? { opacity: 1, transition: { delay: 0.1 } }}
        key={"Default image for blog post when there is not an image to show"}
        draggable="false"
        ref={checkAlreadyLoaded}
        onLoad={() => setLoaded(true)}
      />
      {!loaded && (
        <div className={className} style={{ position: 'absolute', inset: 0, backgroundColor: 'black' }}>
          <Loader size="small" />
        </div>
      )}
    </div>
  );
}
