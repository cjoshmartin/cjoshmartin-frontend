import { stegaClean } from '@sanity/client/stega';
import ProjectShower, { type Project } from './__compoents/ProjectShower';
import { tagTitles } from '../components/PortfolioPreview/tagTitles';
import { toTestimonialView } from '../components/Testimonial/testimonialView';
import { sanityFetch } from '@/sanity/lib/live';
import { SCREEN_PROJECTS_QUERY } from '@/sanity/lib/queries';
import { hasAsset, imageUrl } from '@/sanity/lib/image';

/** Widest rendition of a project preview image (shown at 150px, GIFs stay animated). */
const PREVIEW_IMAGE_WIDTH = 600

/** Every listed (not unlisted) project, newest first, with its first testimonial. */
async function getData(): Promise<Project[]>{
  const { data } = await sanityFetch({ query: SCREEN_PROJECTS_QUERY })
  return data.map((project) => ({
    key: project._id,
    title: project.title ?? '',
    imageAlt: stegaClean(project.title) ?? '',
    previewImageUrl: hasAsset(project.previewImage) ? imageUrl(project.previewImage, PREVIEW_IMAGE_WIDTH) : undefined,
    medium: tagTitles(project.mediums),
    technologies: tagTitles(project.technologies),
    testimonial: project.testimonial ? toTestimonialView(project.testimonial) : undefined,
  }))
}


export default async function Page(){
    const data = await getData();
    return <ProjectShower projects={data}/>;
    
}
