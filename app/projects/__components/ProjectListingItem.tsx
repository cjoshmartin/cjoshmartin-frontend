'use client'
import styles from '../projects.module.css';
import ShowImage from "../../blog/_compoents/ShowImage/ShowImage";
import { ProjectType } from '../../components/PortfolioPreview/ProjectType';
import { generateClassList } from './generateClassList';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { motion } from 'framer-motion';
import { CalculateReadTime } from '@/app/components/CalculateReadTime/CalculateReadTime';
import { isNoContent } from '../../components/PortfolioPreview/isNoContent';
import type { ProjectListingData } from './projectListing';

interface ProjectListingItemProps {
    data: ProjectListingData
}

export default function ProjectListingItem({ data }: ProjectListingItemProps) {
  const {
    projectType: project_type, title, imageAlt, client, mediums: medium, technologies, intro, slug, website, hasBody, thumbnail, readMinutes
  } = data;

    const noContent = isNoContent(website, hasBody);
  return (
    <motion.a
      whileHover={{ scale: 1.01 }}
      href={noContent ? website : `/projects/${slug}`}
      target={noContent ? "_blank" : undefined}
      className={generateClassList([
        styles.projectContainer,
        project_type === ProjectType.Personal
          ? styles.personalProjectContainer
          : "",
      ])}
    >
      <div className={styles.projectImageContainer}>
        <ShowImage
          width={thumbnail?.width ?? 480}
          height={thumbnail?.height ?? 320}
          url={thumbnail?.url}
          alt={imageAlt}
          className={styles.projectImage}
        />
        {noContent && (
          <p className={styles.noContent}>
            View Project Website
            {` `}
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
          </p>
        )}

        {!noContent && (
          <p className={styles.noContent}>
            Read More...
            {` `}
          </p>
        )}
      </div>
      <div className={styles.projectDetails}>
        <div className={styles.projectInfo}>
          <h2>{title}</h2>
          {!noContent && <CalculateReadTime minutes={readMinutes} />}
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
