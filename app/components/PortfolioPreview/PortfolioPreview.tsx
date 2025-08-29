
import { PageTypes } from '@/app/PageTypes'
import { ProjectType } from './ProjectType'
import { getPages } from '../api/pages'
import {PortfolioPreviewResult} from './PortfolioPreviewResult'

async function getResults(project_audience?: string){
  return getPages({type:PageTypes.PROJECT, project_type: ProjectType.Client, project_audience})
}

export default async function PortfolioPreview({project_audience}: {project_audience?: string}){
  const projects = (await getResults(project_audience))

  return (
    <PortfolioPreviewResult projects={projects} />
  )
}
