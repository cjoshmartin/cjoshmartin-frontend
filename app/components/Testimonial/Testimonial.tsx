'use client'

import styles from './Testimonial.module.css'
import { useState } from "react";
import { motion } from "framer-motion";
import TestimonialProgress from "@/app/components/TestimonialProgress";
import LoadingImage from "@/app/components/LoadingImage/LoadingImage";
import type { TestimonialView } from "./testimonialView";

interface TestimonialProps {
  testimonial?: TestimonialView;
  title?: string,
  all?: TestimonialView[],
  shouldHideImage?: boolean
}

export default function Testimonial({ testimonial, title, all, shouldHideImage }: TestimonialProps) {
  const [test , setTest] = useState<TestimonialView | undefined>(testimonial);
  const [isRevealed, setIsRevealed] = useState<boolean>(false);

  if(!test){
    // if there is unvaild testimonial then return nothing
    return null;
  }

  return (
    <div style={{
      width: "100%"
    }}>
    <div
      style={{
        color: "black",
        padding: "1rem",
        width: "100%",
      }}
    >
      {title && (
        <>
          <h2 style={{ paddingLeft: "1rem" }}>{title}</h2>
        </>
      )}

      <motion.div
        className={styles.container}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ease: "easeOut", duration: 0.5 }}
        exit={{ opacity: 0, y: 20 }}
        key={test.jobTitle}
      >
        <div
          className={styles.imageWrapper}
          style={{
            display: shouldHideImage ? "none" : undefined,
          }}
          onMouseEnter={() => setIsRevealed(true)}
          onMouseLeave={() => setIsRevealed(false)}
          onTouchStart={() => setIsRevealed(true)}
          onTouchEnd={() => setIsRevealed(false)}
        >
          <div
            className={styles.image}
            style={{ opacity: isRevealed ? 0 : 1 }}
            dangerouslySetInnerHTML={{
              __html: test.asciiArt,
            }}
          />
          {test.imageUrl && (
            <LoadingImage
              className={styles.revealedImage}
              src={test.imageUrl}
              alt={test.imageAlt}
              fill
              sizes="208px"
              loading="eager"
              wrapperStyle={{ position: "absolute", inset: 0, opacity: isRevealed ? 1 : 0 }}
            />
          )}
        </div>
        <div className={styles.contentContainer}>
          {test.body}
          <div
            className={styles.infoContainer}
            style={{
              maxWidth: shouldHideImage ? "initial" : "450px",
            }}
          >
            <h3>
              <a href={test.link} target="blank">
                {test.firstName} {test.lastName}
              </a>
            </h3>
            {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
            <h3>//</h3>
            {!shouldHideImage && (
              <>
                <h3>{test.jobTitle}</h3>
                {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
                <h3>//</h3>
              </>
            )}
            <h3 style={{ maxWidth: "15rem", textTransform: "capitalize" }}>
              {test.relationship}
            </h3>
          </div>
        </div>
      </motion.div>
    </div>
    <TestimonialProgress
      all={all}
      onAdvance={(newTestimonial) => {
        setTest(newTestimonial);
        setIsRevealed(false);
      }}
    />
    </div>
  );
}
