/**
 * Corrections to Wagtail content that is broken on the old site as well. Everything else is
 * migrated exactly as it is; only the values listed here change.
 *
 * Each fix names the page, the StreamField block and the exact value it replaces, so it can never
 * apply anywhere else. The transform fails when a fix no longer matches the export (a stale entry),
 * and validation compares the dataset with the corrected value and lists each fix as explained.
 */

export interface LinkHrefFix {
  /** Wagtail page id. */
  pageId: number
  /** Id of the `full_richtext` StreamField block that holds the link. */
  blockId: string
  /** The href in the Wagtail rich text. */
  from: string
  /** The href the link gets in Sanity. */
  to: string
  /** Why the Wagtail value is wrong, with the evidence. */
  reason: string
}

export const LINK_HREF_FIXES: readonly LinkHrefFix[] = [
  {
    pageId: 6,
    blockId: 'f26815c7-98fd-4be5-a86a-b21ead5c4564',
    from: '#https://pypi.org/project/face-recognition/',
    to: 'https://pypi.org/project/face-recognition/',
    reason:
      'Squid Games Nerf Gun: the "face_recognition" link has a stray leading "#", so on the old site it only ' +
      'changes the URL fragment and goes nowhere. It is the only "#"-prefixed href in the export. The text names ' +
      'the PyPI package, and https://pypi.org/project/face-recognition/ is that package\'s page.',
  },
]

/** The fix for one link, or undefined when the link is migrated as it is. */
export function linkHrefFix(pageId: number, blockId: string, href: string): LinkHrefFix | undefined {
  return LINK_HREF_FIXES.find((fix) => fix.pageId === pageId && fix.blockId === blockId && fix.from === href)
}
