import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { publishedSlugExists, type SluggedType } from '@/sanity/lib/slugExists';

/** Detail routes whose slug must belong to a published document of the given type. */
const DETAIL_ROUTES: ReadonlyArray<{ pattern: RegExp; type: SluggedType }> = [
  { pattern: /^\/blog\/([^/]+)\/?$/, type: 'blogPost' },
  { pattern: /^\/projects\/([^/]+)\/?$/, type: 'project' },
  { pattern: /^\/flex\/([^/]+)\/?$/, type: 'flexPage' },
];

/** Next.js sets this cookie while Draft Mode is on; drafts may then exist under any slug. */
const DRAFT_MODE_COOKIE = '__prerender_bypass';

/**
 * A path no route matches. Rewriting to it renders the app's not-found page with a real 404
 * status, which a page can't do itself: the root layout's <Suspense> starts streaming (as a 200)
 * before the page's own notFound() runs.
 */
const NOT_FOUND_PATH = '/__not-found';

/** True when the path is a detail route whose slug has no published document. */
async function isUnknownSlug(request: NextRequest): Promise<boolean> {
  if (request.cookies.has(DRAFT_MODE_COOKIE)) {
    return false;
  }

  const { pathname } = request.nextUrl;
  for (const { pattern, type } of DETAIL_ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) {
      continue;
    }

    let slug: string;
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      // Malformed percent-encoding can't be a slug.
      return true;
    }

    try {
      return !(await publishedSlugExists(type, slug));
    } catch (error) {
      // Let the page render; it calls notFound() itself if the document is missing.
      console.error(`proxy: could not check whether ${type} "${slug}" exists`, error);
      return false;
    }
  }
  return false;
}

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);

  if (await isUnknownSlug(request)) {
    return NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url), {
      request: {
        headers: requestHeaders,
      },
    });
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}
