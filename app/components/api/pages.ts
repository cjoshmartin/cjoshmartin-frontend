import URL from '@/app/components/defaulturl';
import { PageTypes } from "@/app/PageTypes";
import generateURL from '../generateURL';

export async function getPages(){

    const pages = await fetch(`${URL}/api/pages/?fields=_,id,type,title&format=json`)
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

    const baseURl = generateURL(`/api/pages/?fields=_,id&slug=${slug}`, URL)

    const id = await fetch(baseURl)
    .then(data => data.json())
    .then(({items}: any) => items[0].id)

    const pageURL = generateURL(`/api/pages/${id}/`, URL)

    const pageData = await fetch(pageURL)
    .then(data => data.json())

    return pageData;

}