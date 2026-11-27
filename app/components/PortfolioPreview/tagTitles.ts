import { stegaClean } from '@sanity/client/stega'

/**
 * Titles of a project's mediums or technologies, in their stored order. References to tags that
 * are missing or unpublished come back as null and are skipped. Titles are cleaned of stega
 * characters because they are used as filter values, counts and URLs, not only as text.
 */
export function tagTitles(titles: ReadonlyArray<string | null> | null | undefined): string[] {
  return (titles ?? [])
    .map((title) => stegaClean(title)?.trim())
    .filter((title): title is string => Boolean(title))
}
