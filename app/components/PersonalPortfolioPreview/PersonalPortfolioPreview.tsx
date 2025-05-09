import { PageTypes } from '@/app/PageTypes';
import { ProjectItem } from '../PortfolioPreview/ProjectItem';
import generateURL from '../generateURL';
import styles from './PersonalPortfolioPreview.module.css'
import { ProjectType } from '../PortfolioPreview/ProjectType';
import ActionButton from '../PortfolioPreview/ActionButton';
import { getPages } from '../api/pages';
import { PersonalPortfolioPreviewResult } from './PersonalPortfolioPreviewResult';

async function getResults(){
  return getPages({type:PageTypes.PROJECT.toLowerCase(), project_type: ProjectType.Personal})
}

// Gifs have to be smaller then 10Mb is the requirement from the backend.
// you can create and edit your gifs in photoshop
/// Clips mostly should be under 2 seconds so that you can get high qulity gifs
export default async function PortfolioPreview(){
    const projects = await getResults();

    return (
        <PersonalPortfolioPreviewResult projects={projects} />
    )
}
