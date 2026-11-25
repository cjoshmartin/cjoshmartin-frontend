import { ProjectItem, type ProjectItemProps } from "../PortfolioPreview/ProjectItem";
import styles from './PersonalPortfolioPreview.module.css'
import ActionButton from '../PortfolioPreview/ActionButton';

export function PersonalPortfolioPreviewResult({projects}: {projects: ProjectItemProps[]}){

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
          {/* Unlisted projects are excluded and the list is limited to 3 by PORTFOLIO_PREVIEW_QUERY. */}
          {projects.map((project) => (
            <ProjectItem key={project.slug ?? project.projectName} {...project} />
          ))}
        </div>
        <ActionButton
            href="/projects?project_type=PER"
        >
            See More (Personal) Projects
        </ActionButton>
      </div>
    );
}