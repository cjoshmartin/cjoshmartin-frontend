import { stegaClean } from '@sanity/client/stega'

import { tagTitles } from '@/app/components/PortfolioPreview/tagTitles'
import { readingMinutes } from '@/lib/portableText'
import { hasAsset, imageUrl, scaledDimensions, type SanityImageValue } from '@/sanity/lib/image'
import type { ProjectListItem } from '@/sanity/lib/types'

/** Widest rendition of a project card thumbnail. */
const THUMBNAIL_WIDTH = 960

/** A project card on /projects, prepared on the server for the client-side ProjectListingItem. */
export interface ProjectListingData {
  key: string
  slug: string
  title: string
  /** The title without stega characters, for the thumbnail's alt attribute. */
  imageAlt: string
  intro: string
  client?: string
  website?: string
  /** "CLI" or "PER". */
  projectType?: string
  mediums: string[]
  technologies: string[]
  thumbnail?: { url: string; width: number; height: number }
  hasBody: boolean
  readMinutes: number
}

/** The content image, then the preview image, then the first hero image (as the old site did). */
function thumbnailOf(project: ProjectListItem): ProjectListingData['thumbnail'] {
  const candidates: Array<SanityImageValue | null | undefined> = [
    project.contentImage,
    project.previewImage,
    ...(project.heroImages ?? []),
  ]
  const image = candidates.find(hasAsset)
  return image ? { url: imageUrl(image, THUMBNAIL_WIDTH), ...scaledDimensions(image, THUMBNAIL_WIDTH) } : undefined
}

export function toProjectListingData(project: ProjectListItem): ProjectListingData {
  return {
    key: project._id,
    slug: project.slug,
    title: project.title ?? '',
    imageAlt: stegaClean(project.title) ?? '',
    intro: project.intro ?? '',
    client: project.client ?? undefined,
    website: stegaClean(project.website) ?? undefined,
    projectType: stegaClean(project.projectType) ?? undefined,
    mediums: tagTitles(project.mediums),
    technologies: tagTitles(project.technologies),
    thumbnail: thumbnailOf(project),
    hasBody: project.hasBody,
    readMinutes: readingMinutes({ text: project.readingText, codeTexts: project.codeTexts }),
  }
}
