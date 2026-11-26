import type { NextConfig } from 'next'

import { fetchSanityRedirects } from './sanity/lib/redirects'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

const sanityProjectId = requireEnv('NEXT_PUBLIC_SANITY_PROJECT_ID')
/** Hosted Sanity Studio, the replacement for the Wagtail admin. */
const sanityStudioUrl = requireEnv('NEXT_PUBLIC_SANITY_STUDIO_URL')

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        // Images uploaded to this Sanity project (any dataset).
        protocol: "https",
        hostname: "cdn.sanity.io",
        pathname: `/images/${sanityProjectId}/**`,
      },
    ],
    dangerouslyAllowSVG: true,
  },

  // Read once per build: a new or changed redirect document in Sanity needs a redeploy.
  async redirects() {
    return [
      {
        source: "/about",
        destination: "/",
        permanent: true,
      },
      {
        source: "/admin",
        destination: sanityStudioUrl,
        permanent: false,
      },
      ...(await fetchSanityRedirects()),
    ];
  },

  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
      {
        source: "/ingest/decide",
        destination: "https://us.i.posthog.com/decide",
      },
    ];
  },

  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
