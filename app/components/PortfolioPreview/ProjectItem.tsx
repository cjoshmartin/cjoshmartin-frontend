'use client';

import { motion } from 'framer-motion';
import styles from './PortfolioPreview.module.css';

export interface ProjectItemProps {
  previewImage: string
  projectName: string
  client?: string
  media: string[]
  technologies: string[]
  slug?:string
}


export function ProjectItem(props: ProjectItemProps) {
    const {slug} = props
  const ParentCompoent = (props: any) =>
    slug ? (
      <motion.a
       href={`/projects/${slug}`} className={props.className} {...props}>{props.children}</motion.a>
    ) : (
      <motion.div className={props.className} {...props}>{props.children} </motion.div>
    );
  return (
    <ParentCompoent
      whileHover={{ scale: 1.1 }}
      className={styles.projectContainer}
    >
      <motion.img
        src={props.previewImage}
        className={styles.profileImage}
        alt={props.projectName}
        width={150}
        height={150}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: {delay: 0.3}}}
      />
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
