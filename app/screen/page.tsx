import { PageTypes } from '../PageTypes';
import { getPages } from '../components/api/pages';
import generateURL from '../components/generateURL';
import ProjectShower from './__compoents/ProjectShower';

async function getData(){
  return getPages()
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