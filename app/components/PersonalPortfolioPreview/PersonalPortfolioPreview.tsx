import { ProjectType } from '../PortfolioPreview/ProjectType';
import { PersonalPortfolioPreviewResult } from './PersonalPortfolioPreviewResult';
import { sanityFetch } from '@/sanity/lib/live';
import { PORTFOLIO_PREVIEW_QUERY } from '@/sanity/lib/queries';
import { toProjectItemProps } from '../PortfolioPreview/projectItemProps';

/** The 3 newest listed personal projects for the given audience. */
async function getResults(project_audience: string){
  const { data } = await sanityFetch({
    query: PORTFOLIO_PREVIEW_QUERY,
    params: { projectType: ProjectType.Personal, audience: project_audience },
  })
  return data
}

// Gifs have to be smaller then 10Mb is the requirement from the backend.
// you can create and edit your gifs in photoshop
/// Clips mostly should be under 2 seconds so that you can get high qulity gifs
export default async function PortfolioPreview({project_audience}: {project_audience: string}){
    const projects = (await getResults(project_audience)).map(toProjectItemProps);

    return (
        <PersonalPortfolioPreviewResult projects={projects} />
    )
}
