import { PageTypes } from '@/app/PageTypes';
import { ProjectItem } from '../PortfolioPreview/ProjectItem';
import generateURL from '../generateURL';
import styles from './PersonalPortfolioPreview.module.css'
import { ProjectType } from '../PortfolioPreview/ProjectType';
import ActionButton from '../PortfolioPreview/ActionButton';
import { getPages } from '../api/pages';


async function getResults(){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_type: ProjectType.Personal})
}

// Gifs have to be smaller then 10Mb is the requirement from the backend.
// you can create and edit your gifs in photoshop
/// Clips mostly should be under 2 seconds so that you can get high qulity gifs
export default async function PortfolioPreview(){
    const projects = await getResults();

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
          .filter((project: any) => !project.is_unlisted)
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
