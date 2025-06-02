import ProjectListingItem from './ProjectListingItem';
import Tags from './Tags';
import styles from '../projects.module.css'
import ClearFilters from '../ClearFilters';
import { FocusModes } from '@/app/components/Context/FocusMode';

export function ProjectFilteration({homePageData, searchParams}: {homePageData: any, searchParams: any}) {

  const focusType = searchParams?.project_audience ?? FocusModes.Developer;
  const params = Object.fromEntries(
    Object.entries(searchParams ?? {}).filter(
      ([key]) => key !== "project_audience"
    )
  );

    const filteredData = homePageData 
            .reduce((acc: any, project: any) => {
              const { medium, technologies, project_type } = project;
              if (!params || Object.keys(params).length < 1) {
                acc.push(project);
                return acc;
              }

              let shouldPush = false;

              if (
                !!params?.project_type &&
                project_type === params?.project_type
              ) {
                shouldPush = true;
              }

              if (
                !!params?.medium &&
                medium.includes(params?.medium)
              ) {
                shouldPush = true;
              }
              if (
                !!params?.technologies &&
                technologies.includes(params?.technologies)
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
            {focusType === FocusModes.Developer ? "Portfolio" : "Projects"}
          </h1>
          <ClearFilters searchParams={params}/>
          <Tags title="Medium" tags={medium} searchParams={params} />
          <Tags
            title="Technologies"
            tags={technologies}
            searchParams={params}
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