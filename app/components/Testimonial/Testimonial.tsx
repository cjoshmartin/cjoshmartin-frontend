'use client'

import TypeIt from "typeit-react";
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
    <div className={styles.container}>
      <div
        className={styles.image}
        dangerouslySetInnerHTML={{ __html: testimonial?.image?.value ?? "" }}
      />
      <div className={styles.contentContainer}>
        <TypeIt
          options={{
            speed: 20,
          }}
          className={styles.testimonialText}
        >
          <p dangerouslySetInnerHTML={{ __html: testimonial.body }} />
        </TypeIt>

        <div style={{ display: "flex", flexDirection: "row", gap: "0.5rem" }}>
          <h3>
            <a href={testimonial.link} target="blank">
              {testimonial.first_name} {testimonial.last_name}
            </a>
          </h3>
          {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
          <h3>//</h3>
          <h3 style={{ maxWidth: "15rem" }}>{testimonial.relationship}</h3>
          {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
          <h3>//</h3>
          <h3>{testimonial.job_title}</h3>
        </div>
      </div>
    </div>
  );
}
