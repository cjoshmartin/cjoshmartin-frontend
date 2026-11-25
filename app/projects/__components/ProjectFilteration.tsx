import ProjectListingItem from './ProjectListingItem';
import Tags from './Tags';
import styles from '../projects.module.css'
import ClearFilters from '../ClearFilters';
import type { ProjectListingData } from './projectListing';

export type ProjectSearchParams = { [key: string]: string | string[] | undefined }

/** One value per filter: a repeated query param (`?medium=a&medium=b`) uses the first value. */
function firstValues(searchParams: ProjectSearchParams): Record<string, string> {
  return Object.fromEntries(
    Object.entries(searchParams)
      .map(([key, value]): [string, string | undefined] => [key, Array.isArray(value) ? value[0] : value])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export function ProjectFilteration({homePageData, searchParams}: {homePageData: ProjectListingData[], searchParams: ProjectSearchParams}) {

  const params = Object.fromEntries(
    Object.entries(firstValues(searchParams)).filter(
      ([key]) => key !== "project_audience"
    )
  );

    const filteredData = homePageData
            .reduce((acc: ProjectListingData[], project) => {
              const { mediums: medium, technologies, projectType: project_type } = project;
              if (!params || Object.keys(params).length < 1) {
                acc.push(project);
                return acc;
              }

              const matchesProjectType =
                !params?.project_type || project_type === params?.project_type;

              const matchesMedium =
                !params?.medium ||
                medium.some((m: string) => m.trim() === params?.medium);

              const matchesTechnologies =
                !params?.technologies ||
                technologies.some((t: string) => t.trim() === params?.technologies);

              if (matchesProjectType && matchesMedium && matchesTechnologies) {
                acc.push(project);
              }

              return acc;
            }, [])

      const counts = filteredData.reduce((acc: {medium: Record<string, number>}, {mediums: medium}) => {

        medium.forEach((m: string) =>{
          const name = m.trim();
          if(!acc['medium'][name]){
             acc['medium'][name] = 1;
          }
          else{
            acc['medium'][name] +=1;
          }
        })

        return acc;
      }, {medium: {}})

      const dataForTechnologyCounts = homePageData
            .filter(({mediums: medium, projectType: project_type}) => {
              const matchesProjectType =
                !params?.project_type || project_type === params?.project_type;

              const matchesMedium =
                !params?.medium ||
                medium.some((m: string) => m.trim() === params?.medium);

              return matchesProjectType && matchesMedium;
            })

      const technologies = dataForTechnologyCounts.reduce((acc: Record<string, number>, {technologies}) => {

        technologies.forEach((t: string) =>{
          const name = t.trim();
          if(!acc[name]){
             acc[name] = 1;
          }
          else{
            acc[name] +=1;
          }
        })

        return acc;
      }, {})

    const {medium} = counts;

    return (
      <div className={styles.container}>
        <div className={styles.filterContainer}>
          <h1>
            <span className='bg-black'>
              Portfolio
            </span>
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
          .map((project) => (
            <ProjectListingItem data={project} key={project.key} />
          ))}
        </div>
      </div>
    );
}
