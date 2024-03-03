import { MetadataRoute } from 'next'
import { getPages } from './components/api/pages';
import { PageTypes } from './PageTypes';


// export async function generateSitemaps() {
//     return pages;
// }
 
export default async function sitemap() :Promise<MetadataRoute.Sitemap> {

    const baseURL = "https:/cjoshmartin.com"
    const pages = await getPages();

    //@ts-ignore
    return pages.map((page) => {
        const {meta} = page;
        let url = baseURL;
        let changeFrequency = 'yearly';

        switch(meta.type){
            case PageTypes.HOME:
                url += '/'
                changeFrequency = 'weekly';
                break;
            case PageTypes.BLOG_POST:
                url += `/blog/${meta.slug}`
                break;
            case PageTypes.PROJECT:
                url += `/projects/${meta.slug}`
                break;
            default:
                return undefined;
        }
        let lastModified = meta?.first_published_at;

        if (page?.data) {
            lastModified = new Date(page?.data).toISOString()
        }


        return {
            url,
            lastModified,
            changeFrequency
        }
    })
    .filter((data) => !!data)
}