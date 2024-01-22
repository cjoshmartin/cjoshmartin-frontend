'use client'
import { motion } from 'framer-motion';

export default function ShowImage({ url, alt, width, height, className }: any) {

    if (url) {
        return (
          <motion.img
            src={url}
            alt={alt}
            width={width}
            height={height}
            className={className}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.1 } }}
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
      />
    );
}
