/**
 * Public Sanity settings for the Next.js app. They are read from environment variables so the
 * same build can point at the `production` or `staging` dataset (see
 * docs/sanity-migration/reports/wp4-frontend.md for the full list).
 *
 * `process.env.NEXT_PUBLIC_*` must be referenced literally so Next.js can inline the values into
 * client bundles.
 */

function assertValue<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

export const projectId = assertValue(
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
  'NEXT_PUBLIC_SANITY_PROJECT_ID',
)

export const dataset = assertValue(process.env.NEXT_PUBLIC_SANITY_DATASET, 'NEXT_PUBLIC_SANITY_DATASET')

/** Hosted Studio. Visual Editing overlays link here and `/admin` redirects here. */
export const studioUrl = assertValue(
  process.env.NEXT_PUBLIC_SANITY_STUDIO_URL,
  'NEXT_PUBLIC_SANITY_STUDIO_URL',
)

/** Same dated API version the Studio uses (studio/lib/constants.ts). */
export const apiVersion = '2026-11-01'
