/** Sanity project that holds all cjoshmartin.com content. */
export const PROJECT_ID = 'j3vdh6ti'

/** Live content. The site reads this dataset. */
export const PRODUCTION_DATASET = 'production'

/** Rehearsal and restore-test copy of production, used by testers through the workspace switcher. */
export const STAGING_DATASET = 'staging'

/**
 * Content Lake API version used by validation queries in this Studio.
 * A fixed date keeps query behaviour stable across Studio auto-updates.
 */
export const API_VERSION = '2026-11-01'

/** Public site that the Presentation tool previews by default. */
export const SITE_URL = 'https://cjoshmartin.com'

/**
 * Every Vercel deployment URL of the cjoshmartin-frontend project, for example
 * cjoshmartin-frontend-git-<branch>-josh-martins-projects-0186b4e9.vercel.app. Scoped to the
 * project name and the Vercel team slug: a bare https://*.vercel.app would also match sites
 * anyone can deploy. The same pattern is registered as a credentialed CORS origin.
 */
export const VERCEL_PREVIEW_ORIGIN =
  'https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app'
