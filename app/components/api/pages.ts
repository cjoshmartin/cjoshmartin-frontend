import URL from '@/app/components/defaulturl';
import { PageTypes } from "@/app/PageTypes";
import { unstable_cache } from 'next/cache';

// The CMS occasionally returns a 500 (HTML error page) for individual
// endpoints instead of JSON. Calling response.json() on that blindly throws
// "Unexpected token '<' ... is not valid JSON", which is useless for
// figuring out what actually broke. Check response.ok first and fail with
// the real status + URL instead.
async function fetchJson(url: string, options?: RequestInit){
    const response = await fetch(url, options);
    if(!response.ok){
        throw new Error(`Request to ${url} failed with status ${response.status}`);
    }
    return response.json();
}

async function fetchPages(params?: {project_audience?: string, type?: string, project_type?: string}){
    let baseUrl =`${URL}/api/pages/?format=json&fields=_,id,type,title`

    if(params?.project_audience){
      baseUrl += ',project_audience'
    }

    if (params && Object.keys(params)) {
        Object.keys(params).forEach((key)=> {
          //@ts-ignore
          baseUrl += `&${key}=${params[key]}`
        })
    }

    // Wagtail's API caps `limit` at 20 per request, so we have to page
    // through `offset` using `meta.total_count` until we've fetched everything.
    const limit = 20;
    let offset = 0;
    let totalCount = Infinity;
    const items: any[] = [];

    while (offset < totalCount) {
      const data = await fetchJson(`${baseUrl}&limit=${limit}&offset=${offset}`, {
        // cache: 'no-cache'
        next: { revalidate: 3600 }
      });

      items.push(...data.items);
      totalCount = data.meta.total_count;
      offset += limit;
    }

    const pages = items.filter(({meta}: any) => meta.type !== PageTypes.BLOG_INDEX);

    // A single page failing to load (e.g. the CMS 500ing on that one record)
    // shouldn't take down every listing that depends on getPages(). Log it
    // and drop it from the results instead of letting Promise.all reject.
    const results = await Promise.all(
      pages.map(({id}: any) =>
        fetchJson(`${URL}/api/pages/${id}`, {
          next: { revalidate: 3600 }
        }).catch((error) => {
          console.error(`getPages: failed to load page ${id}, skipping.`, error);
          return null;
        })
      )
    );

    const successes = results.filter(Boolean);

    // If the list endpoint found candidates but every single one failed to
    // load, that's a total outage, not a legitimate empty result. Throw
    // instead of returning [] — this function is wrapped in unstable_cache,
    // and caching an empty array here would bake a transient CMS outage in
    // for the full revalidate window (up to an hour), even after the CMS
    // recovers. Throwing means unstable_cache won't persist the failure, so
    // the next request retries against the live backend.
    if(pages.length > 0 && successes.length === 0){
        throw new Error(`getPages: found ${pages.length} candidate page(s) but all of them failed to load.`);
    }

    //@ts-ignore
    return successes.sort((a: object, b: object) => (new Date(b.date)) - (new Date(a.date)));
}

// getPages() is called with the same (or no) params from multiple call sites
// (blog listing, RecommendatedPost on every blog post page, projects listing).
// unstable_cache keys on the actual call arguments, so identical calls across
// call sites share one cached crawl instead of each re-running the pagination
// loop and N+1 fetches on every request.
export const getPages = unstable_cache(
    fetchPages,
    ['pages'],
    { revalidate: 3600, tags: ['pages'] }
);

export async function getFromSlug(slug: string){

    const {items} = await fetchJson(`${URL}/api/pages/?fields=_,id&slug=${slug}`,{
      // cache: 'no-cache'
      next: { revalidate: 3600 }
    })
    const id = items[0].id;

    const pageData = await fetchJson(`${URL}/api/pages/${id}/`, {
      next: { revalidate: 3600 }
    })

    return pageData;

}

export async function getPreviewContent({content_type, token}: any){
    const apiEndpoint = process?.env?.API_PAGES_URL ?? "https://backend.cjoshmartin.com"
    console.log('The base url is: ', apiEndpoint);
    const path = `/api/page_preview/1/?content_type=${encodeURIComponent(content_type)}&token=${encodeURIComponent(token)}&format=json&draft=true`;
    const apiCall = apiEndpoint + path;
    console.log('API full URL: ', apiCall)
   return fetchJson(apiCall, {
    cache: 'no-cache'
   })
}