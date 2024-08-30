'use client'
import styles from '../projects.module.css';
import ShowImage from "../../blog/_compoents/ShowImage";
import Link from 'next/link';
import { ProjectType } from '../../components/PortfolioPreview/ProjectType';
import { generateClassList } from './generateClassList';
import { useEffect, useState } from 'react';

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
    <div
      className={generateClassList([
        styles.projectContainer,
        project_type === ProjectType.Personal
          ? styles.personalProjectContainer
          : "",
      ])}
    >
      <div>
        <ShowImage
          width={content_image?.width ?? 480}
          height={content_image?.height ?? 320}
          url={content_image?.url}
          alt={title}
          className={styles.projectImage}
        />
        {isNoContent && (
          <p className={styles.noContent}>No content write up (yet)</p>
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
          <Link
            href={isNoContent ? website : `/projects/${meta.slug}`}
            style={{ color: "black", paddingTop: "2rem" }}
            target={isNoContent ? "_blank" : undefined}
          >
            {isNoContent ? "Visit Project Website" : "Read More..."}
          </Link>
        </div>
      </div>
    </div>
  );
}
