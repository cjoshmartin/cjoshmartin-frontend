import { ProjectType } from '../components/PortfolioPreview/ProjectType';
import { Metadata } from 'next';
import { ProjectFilteration, type ProjectSearchParams } from './__components/ProjectFilteration';
import { FocusModes } from '../components/Context/FocusMode';
import { sanityFetch } from '@/sanity/lib/live';
import { PROJECTS_LIST_QUERY } from '@/sanity/lib/queries';
import { toProjectListingData } from './__components/projectListing';

/** Every listed (not unlisted) developer-audience project, newest first. */
async function getResults(){
  const { data } = await sanityFetch({
    query: PROJECTS_LIST_QUERY,
    params: { audience: FocusModes.Developer },
  })
  return data.map(toProjectListingData)
}
type Props = {
  searchParams: Promise<ProjectSearchParams>
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const searchParams = await props.searchParams;

  const ProjectLookUpText: Record<string, string> = {
    [ProjectType.Personal]: 'Personal',
    [ProjectType.Client]: 'Client',
  }

  const projectType = Array.isArray(searchParams?.project_type)
    ? searchParams.project_type[0]
    : searchParams?.project_type

  const projecTypeText=(projectType
            ? ProjectLookUpText[projectType]
            : "All")
           + " Projects"
  return {
    title: `${projecTypeText} - Josh Martin\'s Website`,
  }
}

export default async function Page(props: Props) {
  const searchParams = await props.searchParams;
  const homePageData = await getResults();


  return (
      <ProjectFilteration homePageData={homePageData} searchParams={searchParams ?? {}} />
  )
}
