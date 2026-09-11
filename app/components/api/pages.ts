import URL from '@/app/components/defaulturl';
import { PageTypes } from "@/app/PageTypes";

export async function getPages(params?: {project_audience?: string, type?: string, project_type?: string}){
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
      const data = await fetch(`${baseUrl}&limit=${limit}&offset=${offset}`, {
        // cache: 'no-cache'
        next: { revalidate: 3600 }
      }).then(response => response.json());

      items.push(...data.items);
      totalCount = data.meta.total_count;
      offset += limit;
    }

    const pages = items.filter(({meta}: any) => meta.type !== PageTypes.BLOG_INDEX);


    const results = await Promise.all(
      pages.map(({id}: any) =>
        fetch(`${URL}/api/pages/${id}`, {
          next: { revalidate: 3600 }
        }).then((data) => data.json())
      )
    );

    //@ts-ignore
    return results.sort((a: object, b: object) => (new Date(b.date)) - (new Date(a.date)));
}

export async function getFromSlug(slug: string){

    const id = await fetch(`${URL}/api/pages/?fields=_,id&slug=${slug}`,{
      // cache: 'no-cache'
      next: { revalidate: 3600 }
    })
    .then(data => data.json())
    .then(({items}: any) => items[0].id)

    const pageData = await fetch(`${URL}/api/pages/${id}/`, {
      next: { revalidate: 3600 }
    })
    .then(data => data.json())

    return pageData;

}

export async function getPreviewContent({content_type, token}: any){
    const apiEndpoint = process?.env?.API_PAGES_URL ?? "https://backend.cjoshmartin.com"
    console.log('The base url is: ', apiEndpoint);
    const path = `/api/page_preview/1/?content_type=${encodeURIComponent(content_type)}&token=${encodeURIComponent(token)}&format=json&draft=true`;
    const apiCall = apiEndpoint + path;
    console.log('API full URL: ', apiCall)
   return fetch(apiCall, {
    cache: 'no-cache'
   })
   .then(data => data.json())
  
}