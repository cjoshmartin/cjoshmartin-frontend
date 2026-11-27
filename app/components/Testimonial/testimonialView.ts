import { toPlainText } from '@portabletext/react'
import { stegaClean } from '@sanity/client/stega'

import { hasAsset, originalImageUrl } from '@/sanity/lib/image'
import type { TestimonialData } from '@/sanity/lib/types'

import { parseAsciiArt, type AsciiArt } from './asciiArt'

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
  /**
   * The generated art (testimonial-ascii-art Function / migration), parsed from its stored
   * `<span>` markup. Null when the field is empty or holds anything but that markup.
   */
  asciiArt: AsciiArt | null
  imageUrl?: string
  imageAlt: string
}

/**
 * Parses a testimonial's stored art. Art that is not the generator's markup is not rendered; the
 * reason is logged on the server so the bad value can be found and regenerated.
 */
function testimonialAsciiArt(testimonial: NonNullable<TestimonialData>): AsciiArt | null {
  // Stega (Visual Editing) can append invisible characters to string fields in Draft Mode.
  const stored = stegaClean(testimonial.asciiArt)
  if (!stored) {
    return null
  }
  const parsed = parseAsciiArt(stored)
  if (!parsed.ok) {
    console.error(`Testimonial ${testimonial._id}: asciiArt is not generated art markup, so it is not shown (${parsed.reason})`)
    return null
  }
  return parsed.art
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
    asciiArt: testimonialAsciiArt(testimonial),
    imageUrl: hasAsset(image) ? originalImageUrl(image) : undefined,
    imageAlt: stegaClean(image?.alt) ?? '',
  }
}

/** Testimonials in their stored order, skipping references to missing or unpublished ones. */
export function toTestimonialViews(testimonials: ReadonlyArray<TestimonialData> | null | undefined): TestimonialView[] {
  return (testimonials ?? []).filter((testimonial) => testimonial !== null).map(toTestimonialView)
}
