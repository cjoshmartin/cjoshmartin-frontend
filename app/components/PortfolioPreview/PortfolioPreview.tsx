
import generateURL from '../generateURL'
import { PageTypes } from '@/app/PageTypes'
import { ProjectItem } from './ProjectItem'
import { ProjectType } from './ProjectType'
import ActionButton from './ActionButton'
import { getPages } from '../api/pages'
import {PortfolioPreviewResult} from './PortfolioPreviewResult'

async function getResults(project_audience?: string){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_type: ProjectType.Client, project_audience})
}

export default async function PortfolioPreview({project_audience}: {project_audience?: string}){
  const projects = (await getResults(project_audience))

  return (
    <PortfolioPreviewResult projects={projects} />
  )
}
