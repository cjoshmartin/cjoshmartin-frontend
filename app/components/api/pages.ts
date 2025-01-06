import URL from '@/app/components/defaulturl';
import { PageTypes } from "@/app/PageTypes";

export async function getPages(params?: object){
    let url =`${URL}/api/pages/?fields=_,id,type,title&format=json` 
    if (params && Object.keys(params)) {
        Object.keys(params).forEach((key)=> {
          //@ts-ignore
          url += `&${key}=${params[key]}`
        })
    }

    const pages = await fetch(url, {
      // cache: 'no-cache'
      next: { revalidate: 3600 }
    }
    )
    .then(response => response.json())
    .then(data => data.items.filter(({meta}: any) => meta.type !== PageTypes.BLOG_INDEX));


    const results: any[] = []
    for (let i = 0; i < pages.length; i++){
      const page = pages[i];
      const {id} = page;
      const result = await fetch(`${URL}/api/pages/${id}`).then((data) =>
        data.json()
      );
      results.push(result);
    }

    //@ts-ignore
    return results.sort((a: object, b: object) => (new Date(b.date)) - (new Date(a.date)));
}

export async function getFromSlug(slug: string){

    const id = await fetch(`${URL}/api/pages/?fields=_,id&slug=${slug}`,{
      next: { revalidate: 3600 }
    })
    .then(data => data.json())
    .then(({items}: any) => items[0].id)

    const pageData = await fetch(`${URL}/api/pages/${id}/`)
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