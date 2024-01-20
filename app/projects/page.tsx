import styles from './projects.module.css'

import ShowImage from "../blog/_compoents/ShowImage";

import bad_idea from '@/public/projects_list_items/bad_ideas.png'
import miata_key from '@/public/personal_projects/miata_key.jpg'
import Link from 'next/link';
import generateURL from '../components/generateURL';
import { PageTypes } from '../PageTypes';
import { ProjectType } from '../components/PortfolioPreview/ProjectType';


interface ProjectListingItemProps {
    data: any
}


function generateClassList(classes: string[]){
    return classes.join(" ")
}

function ProjectListingItem({ data }: ProjectListingItemProps) {
      const {
        project_type,
        title,
        content_image,
        client,
        medium,
        technologies,
        intro,
      } = data;
    return (
        <div
          className={generateClassList([
            styles.projectContainer,
            project_type === ProjectType.Personal
              ? styles.personalProjectContainer
              : "",
          ])}
        >
          <ShowImage width={480} height={320} url={content_image?.url} />
          <div>
            <div className={styles.projectInfo}>
              <h2>{title}</h2>
              {client && <h3 style={{ fontWeight: "400" }}>Client: {client}</h3>}
              <h4>Medium: {medium?.join(', and ')}</h4>
              <h5>
                Technologies: {technologies.join(", ")}
              </h5>
            </div>
            <div>
              <p>{intro}</p>
              <Link href='/projects/fake-project'
                style={{ color: 'black', padding: '1rem' }}
              >Read More...</Link>
            </div>
          </div>
        </div>
    );
}


async function getResults(){
  return fetch(generateURL("/api/pages"))
    .then((response) => response.json())
    .then((dataset) => { 
      const homePageData = dataset.filter(
        ({ meta }: any) => meta.type === PageTypes.PROJECT 
      );
      const counts = homePageData.reduce((acc: any, {project_type, medium, technologies} : any) => {

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

        if(!acc["project_type"][project_type]){
          acc["project_type"][project_type] = 1;
        }
        else {
          acc["project_type"][project_type] += 1;
        }

        return acc;
      }, {medium: {}, technologies: {}, project_type: {}})
      return {homePageData, counts}
    })
}

function Tags({title, tags }: any) {
  const sortedTags = Object.keys(tags)
            .sort((a: string,b: string) => {

              return tags[b]- tags[a];
            });

    sortedTags.length = Math.min(sortedTags.length, 10);
  return (
        <div className={styles.mediaContainer}>
          <h3>{title}:</h3>
          <div className={styles.mediaLinkContainer}>
            {sortedTags
            .map((key) => (
              <a href="#" key={key}>
                {key}({tags[key]})
              </a>
            ))}
          </div>
        </div>
  )
}

export default async function Page() {
    const {homePageData, counts} = await getResults();
    const {project_type, medium, technologies} = counts;
    return (
      <div className={styles.container}>
        <h1>(All) Project Page</h1>
        <div className={styles.buttonGroup}>
          <button>All ({project_type[ProjectType.Client] + project_type[ProjectType.Personal]}) Projects</button>
          <button>Client ({project_type[ProjectType.Client]}) Projects</button>
          <button>Personal ({project_type[ProjectType.Personal]}) Projects</button>
        </div>
        {/* <input
          type="text"
          className={styles.searchBox}
          autoComplete="search"
          placeholder="search projects"
        /> */}
        <Tags title="Medium" tags={medium}/>
        <Tags title="Technologies" tags={technologies} />
        <div className={styles.listItems}>
          {
            homePageData.map((project: any)=> (
              <ProjectListingItem
                data={project}
                key={project.title}
              />
            ))
          }
        </div>
      </div>
    );
}