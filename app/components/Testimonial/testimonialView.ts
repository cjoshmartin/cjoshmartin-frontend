import { toPlainText } from '@portabletext/react'
import { stegaClean } from '@sanity/client/stega'

import { hasAsset, originalImageUrl } from '@/sanity/lib/image'
import type { TestimonialData } from '@/sanity/lib/types'

/** What the client-side Testimonial component needs, prepared on the server. */
export interface TestimonialView {
  key: string
  firstName: string
  lastName: string
  jobTitle: string
  relationship: string
  /** Attribute value, so stega characters are removed. */
  link?: string
  /** Plain text of the rich-text body (the old site stripped the HTML the same way). */
  body: string
  /** Generated `<span>` markup (testimonial-ascii-art Function / migration). */
  asciiArt: string
  imageUrl?: string
  imageAlt: string
}

export function toTestimonialView(testimonial: NonNullable<TestimonialData>): TestimonialView {
  const image = testimonial.image
  return {
    key: testimonial._id,
    firstName: testimonial.firstName ?? '',
    lastName: testimonial.lastName ?? '',
    jobTitle: testimonial.jobTitle ?? '',
    relationship: testimonial.relationship ?? '',
    link: stegaClean(testimonial.link) ?? undefined,
    body: testimonial.body ? toPlainText(testimonial.body) : '',
    asciiArt: testimonial.asciiArt ?? '',
    imageUrl: hasAsset(image) ? originalImageUrl(image) : undefined,
    imageAlt: stegaClean(image?.alt) ?? '',
  }
}

/** Testimonials in their stored order, skipping references to missing or unpublished ones. */
export function toTestimonialViews(testimonials: ReadonlyArray<TestimonialData> | null | undefined): TestimonialView[] {
  return (testimonials ?? []).filter((testimonial) => testimonial !== null).map(toTestimonialView)
}
