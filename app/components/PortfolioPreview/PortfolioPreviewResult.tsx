import { ProjectItem, type ProjectItemProps } from "./ProjectItem";
import ActionButton from "./ActionButton";
import styles from './PortfolioPreview.module.css'

export function PortfolioPreviewResult({projects}: {projects: ProjectItemProps[]}){
  if (projects.length < 1) {
    return null;
  }

  return (
      <div className={styles.container} >
        <div>
          <h2 style={{ paddingLeft: "1rem" }}> Recent (Client) Projects</h2>
          {/* <p>
            These are the projects I have found to pay my bills so far and you
            can look at the kind of work I can help you with in the future
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
          href="/projects?project_type=CLI"
        >
          See More (Client) Projects
        </ActionButton>
      </div>
  );
}