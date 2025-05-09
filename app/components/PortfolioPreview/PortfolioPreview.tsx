
import generateURL from '../generateURL'
import { PageTypes } from '@/app/PageTypes'
import { ProjectItem } from './ProjectItem'
import { ProjectType } from './ProjectType'
import ActionButton from './ActionButton'
import { getPages } from '../api/pages'
import {PortfolioPreviewResult} from './PortfolioPreviewResult'

async function getResults(){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_type: ProjectType.Client})
}

export default async function PortfolioPreview(){
  const projects = await getResults()

  return (
    <PortfolioPreviewResult projects={projects} />
  )
}
