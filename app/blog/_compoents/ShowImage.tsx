'use client'
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

function checkImage(imageSrc: string, good: any, bad: any) {
  var img = new Image();
  img.onload = good; 
  img.onerror = bad;
  img.src = imageSrc;
}


export default function ShowImage({ url, alt, width, height, className }: any) {
    const [imgError, setImgError] = useState(false)
    useEffect(() => {

      const onLoad = () => console.log('Image loaded')
      const onError = () => setImgError(true)
      checkImage(url, onLoad, onError);
    }, [url])

    if (url && !imgError) {
        return (
            <motion.img
              src={url}
              alt={alt}
              width={width}
              height={height}
              className={className}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.1 } }}
              key={alt}
            />
        );
    }

    return (
      <motion.img
        src={
          "https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?ixlib=rb-1.2.1&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1170&q=80"
        }
        alt="Default image for blog post when there is not an image to show"
        width={width}
        height={height}
        className={className}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { delay: 0.1 } }}
        key={"Default image for blog post when there is not an image to show"}
      />
    );
}
