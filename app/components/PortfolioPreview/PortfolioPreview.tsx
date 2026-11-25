
import { ProjectType } from './ProjectType'
import {PortfolioPreviewResult} from './PortfolioPreviewResult'
import { sanityFetch } from '@/sanity/lib/live'
import { PORTFOLIO_PREVIEW_QUERY } from '@/sanity/lib/queries'
import { toProjectItemProps } from './projectItemProps'

/** The 3 newest listed client projects for the given audience. */
async function getResults(project_audience: string){
  const { data } = await sanityFetch({
    query: PORTFOLIO_PREVIEW_QUERY,
    params: { projectType: ProjectType.Client, audience: project_audience },
  })
  return data
}

export default async function PortfolioPreview({project_audience}: {project_audience: string}){
  const projects = (await getResults(project_audience)).map(toProjectItemProps)

  return (
    <PortfolioPreviewResult projects={projects} />
  )
}
