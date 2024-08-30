'use client';

import { motion } from 'framer-motion';
import styles from './PortfolioPreview.module.css';
import ShowImage from '@/app/blog/_compoents/ShowImage';
import { useEffect, useState } from 'react';

export interface ProjectItemProps {
  previewImage?: string
  projectName: string
  client?: string
  media: string[]
  technologies: string[]
  slug?:string,
  website?: string,
  body?: string[]
}


export function ProjectItem(props: ProjectItemProps) {
    const {slug, website, body} = props
    const [isNoContent, setIsNoContent] = useState((website ?? [])?.length > 0 && (body ?? [])?.length < 1 );

    useEffect(() => {
      setIsNoContent((website ?? [])?.length > 0 && (body ?? [])?.length < 1 );
    }, [website, body]);


  const ParentCompoent = (props: any) =>
    slug ? (
      <motion.a
        href={isNoContent ? website : `/projects/${slug}`}
        className={props.className}
        {...props}
        target={isNoContent ? "_blank" : undefined}
      >
        {props.children}
      </motion.a>
    ) : (
      <motion.div className={props.className} {...props}>
        {props.children}{" "}
      </motion.div>
    );
  return (
    <ParentCompoent
      whileHover={{ scale: 1.1 }}
      className={styles.projectContainer}
    >
      <div>
        <ShowImage
          url={props.previewImage}
          className={styles.profileImage}
          alt={props.projectName}
          width={150}
          height={150}
        />
        {isNoContent && (
          <p className={styles.noContent}>No content write up (yet)</p>
        )}
      </div>

      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <h3>{props.projectName}</h3>
        <small>{props.client}</small>
        <small>Medium: {props.media.join(", and ")}</small>
        <small>
          <i>Technologies: {props.technologies.join(", ")}</i>
        </small>
      </div>
    </ParentCompoent>
  );
}
