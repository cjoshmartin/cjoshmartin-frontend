import styles from './PortfolioPreview.module.css';
import Image from 'next/image';

export interface ProjectItemProps {
  previewImage: string
  projectName: string
  client?: string
  media: string[]
  technologies: string[]
  slug?:string
}


export function ProjectItem(props: ProjectItemProps) {
  
  const ParentCompoent = ({ children, className }: any) =>
    props.slug ? (
      <a href={`/projects/${props.slug}`} className={className}>{children}</a>
    ) : (
      <div className={className}>{children} </div>
    );
  return (
    <ParentCompoent className={styles.projectContainer}>

        <Image src={props.previewImage}  className={styles.profileImage} alt={props.projectName} width={150} height={150}/>
      <div
        style={{
          padding: "1rem",
        }}
      >
        <h3>{props.projectName}</h3>
        <small>{props.client}</small>
        <br />
        <small>Medium: {props.media.join(', and ')}</small>
        <br />
        <small>
          <i>Technologies: {props.technologies.join(", ")}</i>
        </small>
      </div>
    </ParentCompoent>
  );
}
