import URL from '@/app/components/defaulturl';
import { PageTypes } from "@/app/PageTypes";

export async function getPages(){

    const pages = await fetch(`${URL}/api/pages/?fields=_,id,type,title&format=json`, {
      // cache: 'no-cache'
    })
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

    return results;
}

export async function getFromSlug(slug: string){

    const id = await fetch(`${URL}/api/pages/?fields=_,id&slug=${slug}`)
    .then(data => data.json())
    .then(({items}: any) => items[0].id)

    const pageData = await fetch(`${URL}/api/pages/${id}/`)
    .then(data => data.json())

    return pageData;

}

export async function getPreviewContent({content_type, token}: any){
    const apiEndpoint = "http://0.0.0.0:8000"
    const path = `/api/page_preview/1/?content_type=${encodeURIComponent(content_type)}&token=${encodeURIComponent(token)}&format=json`;
    const apiCall = apiEndpoint + path;
   return fetch(apiCall, {
    cache: 'no-cache'
   })
   .then(data => data.json())
  
}