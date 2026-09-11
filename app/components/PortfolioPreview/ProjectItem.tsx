'use client';

import { motion } from 'framer-motion';
import styles from './PortfolioPreview.module.css';
import ShowImage from '@/app/blog/_compoents/ShowImage/ShowImage';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { isNoContent } from './isNoContent';

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
    const noContent = isNoContent(website, body);

  const content = (
    <>
      <div
      style={{
        position: 'relative'
      }}
      >
        <ShowImage
          url={props.previewImage}
          className={styles.profileImage}
          alt={props.projectName}
          width={150}
          height={150}
        />
        {noContent && (
          <p className={styles.noContent}>View project website
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
          </p>
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
        {props.client && (
          <small>{props.client}</small>
        )}
        {props.media.length > 0 && (
          <small>Medium: {props.media.join(", and ")}</small>
        )}
          {props.technologies.length > 0 && (
        <small>
            <i>Technologies: {props.technologies.join(", ")}</i>
          </small>
        )}
      </div>
    </>
  );

  if (slug) {
    return (
      <motion.a
        whileHover={{ scale: 1.01 }}
        className={styles.projectContainer}
        href={noContent ? website : `/projects/${slug}`}
        target={noContent ? "_blank" : undefined}
      >
        {content}
      </motion.a>
    );
  }

  return (
    <motion.div whileHover={{ scale: 1.01 }} className={styles.projectContainer}>
      {content}{" "}
    </motion.div>
  );
}
