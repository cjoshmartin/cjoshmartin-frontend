import { PageTypes } from '@/app/PageTypes';
import { ProjectType } from '../PortfolioPreview/ProjectType';
import { getPages } from '../api/pages';
import { PersonalPortfolioPreviewResult } from './PersonalPortfolioPreviewResult';

async function getResults(project_audience?: string){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_type: ProjectType.Personal, project_audience})
}

// Gifs have to be smaller then 10Mb is the requirement from the backend.
// you can create and edit your gifs in photoshop
/// Clips mostly should be under 2 seconds so that you can get high qulity gifs
export default async function PortfolioPreview({project_audience}: {project_audience?: string}){
    const projects = await getResults(project_audience);

    return (
        <PersonalPortfolioPreviewResult projects={projects} />
    )
}
