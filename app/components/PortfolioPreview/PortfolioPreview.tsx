import styles from './PortfolioPreview.module.css'

import generateURL from '../generateURL'
import { PageTypes } from '@/app/PageTypes'
import { ProjectItem } from './ProjectItem'
import { ProjectType } from './ProjectType'

async function getResults(){
  return fetch(generateURL("/api/pages"))
    .then((response) => response.json())
    .then((dataset) => { 
      const homePageData = dataset.filter(
        ({ meta, project_type }: any) => meta.type === PageTypes.PROJECT && project_type === ProjectType.Client
      );
      return homePageData
    })
}

export default async function PortfolioPreview(){
  const projects = await getResults()

    return (
      <div className={styles.container}>
        <div>
          <h2 style={{paddingLeft: '1rem'}}> Recent (Client) Projects</h2>
          <p>These are the projects I have found to pay my bills so far and you can look at the kind of work I can help you with in the future</p>
        </div>
        <br />
        <div className={styles.profileContainer}> 
          {
            projects.map((project: any, i :number) => (
            <ProjectItem 
                      key={project.title}
                      previewImage={project.preview_image.url} 
                      projectName={project.title}
                      client={project.client}
                      media={project.medium}
                      technologies={project.technologies}
                      // slug={project.meta.slug}
                      />
            ))
          }
        </div> 
        <div
          style={{
            padding: '1rem',
            width: '100%',
            display: 'flex'
          }}
        >
          <a className={styles.readMoreClient} href='/projects'>See More (Client) Projects</a>
        </div>
      </div>
    );
}
