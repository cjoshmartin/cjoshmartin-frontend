'use client'
import styles from '../projects.module.css';
import ShowImage from "../../blog/_compoents/ShowImage";
import Link from 'next/link';
import { ProjectType } from '../../components/PortfolioPreview/ProjectType';
import { generateClassList } from './generateClassList';
import { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { motion } from 'framer-motion';

interface ProjectListingItemProps {
    data: any
}

export default function ProjectListingItem({ data }: ProjectListingItemProps) {
  const {
    project_type, title, content_image, client, medium, technologies, intro, meta, website,body
  } = data;

    const [isNoContent, setIsNoContent] = useState((website ?? [])?.length > 0 && (body ?? [])?.length < 1 );

    useEffect(() => {
      setIsNoContent((website ?? [])?.length > 0 && (body ?? [])?.length < 1 );
    }, [website, body]);
  return (
    <motion.a
      whileHover={{ scale: 1.01 }}
      href={isNoContent ? website : `/projects/${meta.slug}`}
      target={isNoContent ? "_blank" : undefined}
      className={generateClassList([
        styles.projectContainer,
        project_type === ProjectType.Personal
          ? styles.personalProjectContainer
          : "",
      ])}
    >
      <div 
        style={{
          position: 'relative',
        }}
      >
        <ShowImage
          width={content_image?.width ?? 480}
          height={content_image?.height ?? 320}
          url={content_image?.url}
          alt={title}
          className={styles.projectImage}
        />
        {isNoContent && (
          <p className={styles.noContent}>
            View Project Website
            {` `}
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
          </p>
        )}

        {!isNoContent && (
          <p className={styles.noContent}>
            Read More...
            {` `}
          </p>
        )}
      </div>
      <div>
        <div className={styles.projectInfo}>
          <h2>{title}</h2>
          {client && <h3 style={{ fontWeight: "400" }}>Client: {client}</h3>}
          <h4>Medium: {medium?.join(", and ")}</h4>
          <h5>Technologies: {technologies.join(", ")}</h5>
        </div>
        <div>
          <p>{intro}</p>
        </div>
      </div>
    </motion.a>
  );
}
