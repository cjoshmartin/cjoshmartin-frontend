import { PageTypes } from '../PageTypes';
import ProjectShower from './__compoents/ProjectShower';
import fakeData from './tempData';

async function getData() {
    return fakeData.filter(
        ({ meta }: any) => meta.type === PageTypes.PROJECT
      )
}


export default async function Page(){
    const data = await getData();
    return <ProjectShower projects={data as any}/>;
    
}