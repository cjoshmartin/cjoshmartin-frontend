import { ProjectItem } from "../PortfolioPreview/ProjectItem";
import styles from './PersonalPortfolioPreview.module.css'
import ActionButton from '../PortfolioPreview/ActionButton';

export function PersonalPortfolioPreviewResult({projects}: {projects: any[]}){

    if(projects.length < 1){
      return null;
    }

    return (
          <div className={styles.container}>
            <div>
          <h2 style={{ paddingLeft: "1rem" }}> Recent (Personal) Projects</h2>
          {/* <p>
            These are the projects I have done for myself as a learning exercise
            and keep me going in the morning
          </p> */}
        </div>
        <br />
        <div className={styles.profileContainer}>
          {projects
            .filter(
              (project: any) =>
                !project.is_unlisted 
            )
          .slice(0, 3)
          .map((project: any, i: number) => (
            <ProjectItem
              key={project.title}
              previewImage={project?.preview_image?.url}
              projectName={project.title}
              client={project.client}
              media={project.medium}
              technologies={project.technologies}
              slug={project.meta.slug}
              website={project.website}
              body={project.body}
            />
          ))}
        </div>
        <ActionButton
            className={styles.readMoreClient}
            href="/projects?project_type=PER"
        >
            See More (Personal) Projects
        </ActionButton>
      </div>
    );
}