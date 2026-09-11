import { ProjectType } from '../components/PortfolioPreview/ProjectType';
import { PageTypes } from '../PageTypes';
import { Metadata, ResolvingMetadata } from 'next';
import { getPages } from '../components/api/pages';
import { ProjectFilteration } from './__components/ProjectFilteration';
async function getResults(searchParams: any){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_audience: searchParams?.project_audience})
}
type Props = {
  params: Promise<{ id: string }>
  searchParams: any 
}

export async function generateMetadata(props: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const searchParams = await props.searchParams;

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

export default async function Page(props: any) {
  const searchParams = await props.searchParams;
  const homePageData = (await getResults(searchParams))
  .filter((project: any) => !project.is_unlisted);


  return (
      <ProjectFilteration homePageData={homePageData} searchParams={searchParams} />
  )
}