import styles from './PortfolioPreview.module.css'

import generateURL from '../generateURL'
import { PageTypes } from '@/app/PageTypes'
import { ProjectItem } from './ProjectItem'
import { ProjectType } from './ProjectType'
import ActionButton from './ActionButton'
import { getPages } from '../api/pages'

async function getResults(){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_type: ProjectType.Client})
}

export default async function PortfolioPreview(){
  const projects = await getResults()

  if(projects.length < 1){
    return null;

  }

    return (
      <div className={styles.container}>
        <div>
          <h2 style={{ paddingLeft: "1rem" }}> Recent (Client) Projects</h2>
          {/* <p>
            These are the projects I have found to pay my bills so far and you
            can look at the kind of work I can help you with in the future
          </p> */}
        </div>
        <br />
        <div className={styles.profileContainer}>
          {projects
          .slice(0,3)
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
          href="/projects?project_type=CLI"
        >
          See More (Client) Projects
        </ActionButton>
      </div>
    );
}
