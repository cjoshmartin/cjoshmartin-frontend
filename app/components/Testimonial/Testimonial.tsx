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
  // const [copyText, setCopyText] = useState<any | null>(null);

  // useEffect(() => {
  //   const comp = (
  //     <TypeIt
  //       options={{
  //         speed: 20,
  //       }}
  //       className={styles.testimonialText}
  //     >
  //       {stripHtml(test.body).result}
  //     </TypeIt>
  //   );
  //   setCopyText(comp);
  //   console.log("firing!!!")
  //   console.log(test.body)
  // }, [test])

  return (
    <div
      style={{
        backgroundColor: "white",
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
          <div
            className={styles.image}
            dangerouslySetInnerHTML={{
              __html: test?.image?.value ?? "",
            }}
          />
        </div>
        <div className={styles.contentContainer}>
          {stripHtml(test.body).result}
          <div
            className={styles.infoContainer}
            style={{
              maxWidth: shouldHideImage ? "initial" : "450px",
            }}
          >
            <h3>
              <a href={test.link} target="blank">
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
            onClick={() =>
              setTest(all[RandomIntFromInterval(0, all.length - 1)].testimonial)
            }
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
