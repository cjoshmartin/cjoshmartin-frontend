import { ProjectType } from '../components/PortfolioPreview/ProjectType';
import { PageTypes } from '../PageTypes';
import ProjectListingItem from './__components/ProjectListingItem';
import Tags from './__components/Tags';
import styles from './projects.module.css'
import ClearFilters from './ClearFilters';
import { ProjectTypeButtons } from './ProjectTypeButtons';
import { Metadata, ResolvingMetadata } from 'next';
import { getPages } from '../components/api/pages';

async function getResults(){
  return getPages({type:PageTypes.PROJECT.toLowerCase()})
}
type Props = {
  params: { id: string }
  searchParams: any 
}

export async function generateMetadata(
  { params, searchParams }: Props,
  parent: ResolvingMetadata
): Promise<Metadata> {

    const ProjectLookUpText = {
      [ProjectType.Personal]: 'Personal',
      [ProjectType.Client]: 'Client',
    }
 
    const projecTypeText=(searchParams?.project_type
              ? // @ts-ignore
                ProjectLookUpText[searchParams?.project_type]
              : "All")
             + " Projects"
  return {
    title: `${projecTypeText} - Josh Martin\'s Website`,
  }
}

export default async function Page({searchParams}: any) {
    const homePageData = (await getResults())
    .filter((project: any) => !project.is_unlisted);

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
          <ClearFilters searchParams={searchParams}/>
          <ProjectTypeButtons searchParams={searchParams} projectTypeCounts={projectTypeCounts}/>
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