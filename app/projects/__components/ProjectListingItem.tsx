import styles from '../projects.module.css';
import ShowImage from "../../blog/_compoents/ShowImage";
import Link from 'next/link';
import { ProjectType } from '../../components/PortfolioPreview/ProjectType';
import { generateClassList } from './generateClassList';

interface ProjectListingItemProps {
    data: any
}

export default function ProjectListingItem({ data }: ProjectListingItemProps) {
  const {
    project_type, title, content_image, client, medium, technologies, intro, meta
  } = data;
  return (
    <div
      className={generateClassList([
        styles.projectContainer,
        project_type === ProjectType.Personal
          ? styles.personalProjectContainer
          : "",
      ])}
    >
      <ShowImage width={ content_image?.width ?? 480} height={ content_image?.height ?? 320} url={content_image?.url} alt={title} className={styles.projectImage}/>
      <div>
        <div className={styles.projectInfo}>
          <h2>{title}</h2>
          {client && <h3 style={{ fontWeight: "400" }}>Client: {client}</h3>}
          <h4>Medium: {medium?.join(', and ')}</h4>
          <h5>
          Technologies: {technologies.join(", ")}
          </h5>
        </div>
        <div>
          <p>{intro}</p>
          <Link href={`/projects/${meta.slug}`}
            style={{ color: 'black', padding: '1rem' }}
          >Read More...</Link>
        </div>
      </div>
    </div>
  );
}
