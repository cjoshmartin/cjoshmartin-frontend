import { stegaClean, type StegaBranded } from '@sanity/client/stega'

import type { PORTFOLIO_PREVIEW_QUERY_RESULT } from '@/sanity.types'
import { hasAsset, imageUrl } from '@/sanity/lib/image'

import type { ProjectItemProps } from './ProjectItem'
import { tagTitles } from './tagTitles'

/** Widest rendition of a project preview image (shown at 150px, GIFs stay animated). */
const PREVIEW_IMAGE_WIDTH = 600

export type ProjectPreviewData = StegaBranded<PORTFOLIO_PREVIEW_QUERY_RESULT>[number]

/** Props for the client-side ProjectItem card, prepared on the server. */
export function toProjectItemProps(project: ProjectPreviewData): ProjectItemProps {
  return {
    previewImage: hasAsset(project.previewImage) ? imageUrl(project.previewImage, PREVIEW_IMAGE_WIDTH) : undefined,
    imageAlt: stegaClean(project.title) ?? '',
    projectName: project.title ?? '',
    client: project.client ?? undefined,
    media: tagTitles(project.mediums),
    technologies: tagTitles(project.technologies),
    slug: project.slug,
    website: stegaClean(project.website) ?? undefined,
    hasBody: project.hasBody,
  }
}
