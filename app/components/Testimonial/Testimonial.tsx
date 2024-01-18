'use client'

import TypeIt from "typeit-react";
import { stripHtml } from "string-strip-html";

import styles from './Testimonial.module.css'


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

interface TestimonialProps {
  testimonial: TestimonialObject;
}

export default function Testimonial({ testimonial }: TestimonialProps) {
  return (
    <div 
      style={{
        backgroundColor: 'white',
        color: 'black',
        padding: "1rem",
      }}
    >
      <h2><u>What People Have To Say: </u></h2>
      <br />

      <div className={styles.container}>
        <div>
          <div
            className={styles.image}
            dangerouslySetInnerHTML={{
              __html: testimonial?.image?.value ?? "",
            }}
          />
        </div>
        <div className={styles.contentContainer}>
          <TypeIt
            options={{
              speed: 20,
            }}
            className={styles.testimonialText}
          >
            {stripHtml(testimonial.body).result}
          </TypeIt>

          <div className={styles.infoContainer}>
            <h3>
              <a href={testimonial.link} target="blank">
                {testimonial.first_name} {testimonial.last_name}
              </a>
            </h3>
            {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
            <h3>//</h3>
            <h3>{testimonial.job_title}</h3>
            {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
            <h3>//</h3>
            <h3 style={{ maxWidth: "15rem", textTransform: "capitalize" }}>
              {testimonial.relationship}
            </h3>
          </div>
        </div>
      </div>
    </div>
  );
}
