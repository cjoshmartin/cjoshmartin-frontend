'use client'
import ProjectListingItem from './ProjectListingItem';
import Tags from './Tags';
import styles from '../projects.module.css'
import ClearFilters from '../ClearFilters';
import { ProjectType } from '../../components/PortfolioPreview/ProjectType';
import { ProjectTypeButtons } from '../ProjectTypeButtons';
import { FocusModes, useFocusState } from '../../components/Context/FocusStateContext';

export function ProjectFilteration({homePageData, searchParams}: {homePageData: any, searchParams: any}) {

    const { focusMode } = useFocusState();

    const focedData = homePageData.filter((project: any) => project.project_audience === focusMode);    

    const filteredData = focedData 
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

    return (
      <div className={styles.container}>
        <div className={styles.filterContainer}>
          <h1>
            {focusMode === FocusModes.Developer ? "Portfolio" : "Projects"}
          </h1>
          <ClearFilters searchParams={searchParams}/>
          <Tags title="Medium" tags={medium} searchParams={searchParams} />
          <Tags
            title="Technologies"
            tags={technologies}
            searchParams={searchParams}
          />
        </div>
        <div className={styles.listItems}>
          {filteredData
          .map((project: any) => (
            <ProjectListingItem data={project} key={project.title} />
          ))}
        </div>
      </div>
    );
}