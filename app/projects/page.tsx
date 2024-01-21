import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import generateURL from '../components/generateURL';
import { ProjectType } from '../components/PortfolioPreview/ProjectType';
import { PageTypes } from '../PageTypes';
import ProjectListingItem from './__components/ProjectListingItem';
import Tags from './__components/Tags';
import styles from './projects.module.css'
import Link from 'next/link';
import { faCircleXmark } from '@fortawesome/free-solid-svg-icons';

/*
  three query parameters:
  1) type of clients
    * all
    * profrontal 
    * personal
  2) Medium
    can all select one medium at a time
  3) Techologies
    can all select one techologies at a time 
*/

async function getResults(){
  return fetch(generateURL("/api/pages"))
    .then((response) => response.json())
    .then((dataset) => { 
      return dataset.filter(
        ({ meta }: any) => meta.type === PageTypes.PROJECT 
      ) 
    })
}

export default async function Page({searchParams}: any) {
    const homePageData = await getResults();

      const projectTypeCounts = homePageData.reduce((acc: any, {project_type}: any) => {
        if(!acc[project_type]){
          acc[project_type] = 1;
        }
        else {
          acc[project_type] += 1;
        }

        return acc;
      }, {})


      const filteredData = homePageData
            .reduce((acc: any, project: any) => {
              const { medium, technologies, project_type } = project;
              if (!searchParams || Object.keys(searchParams).length < 1) {
                acc.push(project);
                return acc;
              }

              let shouldPush = false;

              if (
                !!searchParams?.project_type &&
                project_type === searchParams?.project_type
              ) {
                shouldPush = true;
              }

              if (
                !!searchParams?.medium &&
                medium.includes(searchParams?.medium)
              ) {
                shouldPush = true;
              }
              if (
                !!searchParams?.technologies &&
                technologies.includes(searchParams?.technologies)
              ) {
                shouldPush = true;
              }

              if (shouldPush) {
                acc.push(project);
              }

              return acc;
            }, [])
      
      const counts = filteredData.reduce((acc: any, {medium, technologies} : any) => {

        medium.forEach((m: string) =>{
          const name = m.trim();
          if(!acc['medium'][name]){
             acc['medium'][name] = 1;
          }
          else{
            acc['medium'][name] +=1;
          }
        })

        technologies.forEach((t: string) =>{
          const name = t.trim();
          if(!acc['technologies'][name]){
             acc['technologies'][name] = 1;
          }
          else{
            acc['technologies'][name] +=1;
          }
        })

        return acc;
      }, {medium: {}, technologies: {}})

    const {medium, technologies} = counts;

    const ProjectLookUpText = {
      [ProjectType.Personal]: 'Personal',
      [ProjectType.Client]: 'Client',
    }


    return (
      <div className={styles.container}>
        <div className={styles.filterContainer}>
          <h1>
            (
            {searchParams?.project_type
              ? // @ts-ignore
                ProjectLookUpText[searchParams?.project_type]
              : "All"}
            ) Projects
          </h1>
          { !!searchParams && Object.keys(searchParams).length > 0 && (
            <Link href="/projects" className={styles.clearFiltersLink}>
              <FontAwesomeIcon
                icon={faCircleXmark}
                className="fas fa-check"
                style={{ color: "green", fontSize: 28 }}
              />
              Clear Filters
            </Link>
          )
          }
          <div className={styles.buttonGroup}>
            <Link
              href={{
                pathname: "/projects",
                query: { ...searchParams, project_type: undefined },
              }}
            >
              All (
              {projectTypeCounts[ProjectType.Client] +
                projectTypeCounts[ProjectType.Personal]}
              ) Projects
            </Link>
            <Link
              href={{
                pathname: "/projects",
                query: { ...searchParams, project_type: ProjectType.Client },
              }}
            >
              Client ({projectTypeCounts[ProjectType.Client]}) Projects
            </Link>
            <Link
              href={{
                pathname: "/projects",
                query: { ...searchParams, project_type: ProjectType.Personal },
              }}
            >
              Personal ({projectTypeCounts[ProjectType.Personal]}) Projects
            </Link>
          </div>
          <Tags title="Medium" tags={medium} searchParams={searchParams} />
          <Tags
            title="Technologies"
            tags={technologies}
            searchParams={searchParams}
          />
        </div>
        <div className={styles.listItems}>
          {filteredData.map((project: any) => (
            <ProjectListingItem data={project} key={project.title} />
          ))}
        </div>
      </div>
    );
}