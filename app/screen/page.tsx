import { PageTypes } from '../PageTypes';
import generateURL from '../components/generateURL';
import ProjectShower from './__compoents/ProjectShower';

async function getData(){
  return fetch(generateURL("/api/pages"))
    .then((response) => response.json())
    .then((dataset) => { 
      const homePageData = dataset.filter(
        ({ meta }: any) => meta.type === PageTypes.PROJECT
      );
      return homePageData
    })
}


export default async function Page(){
    const data = await getData();
    return <ProjectShower projects={data as any}/>;
    
}