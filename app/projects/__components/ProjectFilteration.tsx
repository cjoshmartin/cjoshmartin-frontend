import ProjectListingItem from './ProjectListingItem';
import Tags from './Tags';
import styles from '../projects.module.css'
import ClearFilters from '../ClearFilters';

export function ProjectFilteration({homePageData, searchParams}: {homePageData: any, searchParams: any}) {

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

      const counts = filteredData.reduce((acc: any, {medium}: any) => {

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
            .filter(({medium, project_type}: any) => {
              const matchesProjectType =
                !params?.project_type || project_type === params?.project_type;

              const matchesMedium =
                !params?.medium ||
                medium.some((m: string) => m.trim() === params?.medium);

              return matchesProjectType && matchesMedium;
            })

      const technologies = dataForTechnologyCounts.reduce((acc: any, {technologies}: any) => {

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
          .map((project: any) => (
            <ProjectListingItem data={project} key={project.title} />
          ))}
        </div>
      </div>
    );
}
