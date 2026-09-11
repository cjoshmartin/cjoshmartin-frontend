'use client'

import TypeIt from "typeit-react";
import { stripHtml } from "string-strip-html";

import styles from './Testimonial.module.css'
import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useState } from "react";
import { RandomIntFromInterval } from "@/app/randomIntFromInterval";
import { motion } from "framer-motion";


interface TestimonialImage {
  title: string;
  value: string;
  url?: string;
}

interface TestimonialObject {
  image?: TestimonialImage;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  relationship?: string;
  link?: string;
  body: string;
}

export interface FromAPI {
 testimonial: TestimonialObject
}

interface TestimonialProps {
  testimonial: TestimonialObject;
  title?: string,
  all?: FromAPI[],
  shouldHideImage?: boolean
}

export default function Testimonial({ testimonial, title, all, shouldHideImage }: TestimonialProps) {
  const [test , setTest] = useState<TestimonialObject>(testimonial);
  const [testIndex, setTestIndex] = useState<number>(1);
  const [isRevealed, setIsRevealed] = useState<boolean>(false);

  if(!test){
    // if there is unvaild testimonial then return nothing
    return null;
  }

  return (
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
        key={test.job_title}
      >
        <div
          style={{
            display: shouldHideImage ? "none" : undefined,
          }}
        >
            { test?.image?.url && isRevealed ? (
            <img
              className={styles.revealedImage}
              src={test.image.url}
              alt={test.image.title}
              onMouseLeave={() => setIsRevealed(false)}
              onTouchEnd={() => setIsRevealed(false)}
            />
             ) : (
               <div
                 className={styles.image}
                 onMouseEnter={() => setIsRevealed(true)}
                 onTouchStart={() => setIsRevealed(true)}
                 dangerouslySetInnerHTML={{
                   __html: test?.image?.value ?? "",
                 }}
               />
             )}
        </div>
        <div className={styles.contentContainer}>
          {test?.body && stripHtml(test.body)?.result}
          <div
            className={styles.infoContainer}
            style={{
              maxWidth: shouldHideImage ? "initial" : "450px",
            }}
          >
            <h3>
              <a href={test?.link} target="blank">
                {test.first_name} {test.last_name}
              </a>
            </h3>
            {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
            <h3>//</h3>
            {!shouldHideImage && (
              <>
                <h3>{test.job_title}</h3>
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
      {!!all && all.length > 1 && (
        <div className={styles.testimonialButtonContainer}>
          <motion.button
            className={styles.testimonialButton}
            // @ts-ignore
            onClick={() => {
              const newI = (testIndex + 1) % all.length;
              setTestIndex(newI)
              setTest(all[newI].testimonial)
              setIsRevealed(false)
            }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
          >
            <FontAwesomeIcon icon={faRotateRight} />
            Get a different testimonial
          </motion.button>
        </div>
      )}
    </div>
  );
}
