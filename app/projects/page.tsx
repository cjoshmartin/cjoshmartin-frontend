import { ProjectType } from '../components/PortfolioPreview/ProjectType';
import { PageTypes } from '../PageTypes';
import { Metadata, ResolvingMetadata } from 'next';
import { getPages } from '../components/api/pages';
import { ProjectFilteration } from './__components/ProjectFilteration';

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


      return (
          <ProjectFilteration homePageData={homePageData} searchParams={searchParams} />
      )
}