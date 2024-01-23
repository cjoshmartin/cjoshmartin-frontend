'use client'
import { motion } from 'framer-motion';
import { Suspense, useEffect, useState } from 'react';

function checkImage(imageSrc: string, good: any, bad: any) {
  var img = new Image();
  img.onload = good; 
  img.onerror = bad;
  img.src = imageSrc;
}


export default function ShowImage({ url, defaultUrl, alt, width, height, className, initial, animate, exit, shouldHideImageOnFail}: any) {
    const [imgError, setImgError] = useState(false)
    useEffect(() => {

      if(url) {
        const onLoad = () => console.log('Image loaded')
        const onError = () => setImgError(true)
        checkImage(url, onLoad, onError);
      }
    }, [url])

    if(shouldHideImageOnFail && imgError){
      return null;
    }

    if (url && !imgError) {
        return (
          <Suspense>
            <motion.img
              src={url}
              alt={alt}
              width={width}
              height={height}
              className={className}
              initial={initial ?? { opacity: 0 }}
              animate={animate ?? { opacity: 1, transition: { delay: 0.1 } }}
              exit={exit ?? { opacity: 0 }}
              key={alt}
            />
          </Suspense>
        );
    }

    return (
      <Suspense>
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
        />
      </Suspense>
    );
}
