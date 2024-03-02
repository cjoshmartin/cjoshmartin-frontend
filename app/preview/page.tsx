import { redirect } from "next/navigation";
import { PageTypes } from "../PageTypes";

async function getPreviewContent({content_type, token }: any){
    const apiEndpoint = "http://0.0.0.0:8000"
    const path = `/api/page_preview/1/?content_type=${encodeURIComponent(content_type)}&token=${encodeURIComponent(token)}&format=json`;
    const apiCall = apiEndpoint + path;
   return fetch(apiCall)
   .then(data => data.json())
}

export default async function Page({ searchParams }: {  
        searchParams?: { [key: string]: string | string[] | undefined }
    }) 
    {
    if (!searchParams || Object.keys(searchParams).length < 1){
        // redirect('/')
        return (
            <h1>No Content</h1>
        )
    }

    const {content_type, token} = searchParams;
    if (content_type && token){
        //@ts-ignore
        const path = `?content_type=${encodeURIComponent(content_type)}&token=${encodeURIComponent(token)}&format=json`;
        let base = '/'

        switch(content_type){
            case PageTypes.HOME.toLowerCase():
                base = '/'
                break;
            case PageTypes.BLOG_POST.toLowerCase():
                base = '/blog/preview'
                break;
            case PageTypes.PROJECT.toLowerCase():
                base = '/projects/preview'
        }
        redirect(base + path);
    }


    const {title, body, date, id} = await getPreviewContent(searchParams);
    return (
        <div>
            <h2>{title}</h2>
            <h3>content_type: {content_type}</h3>
            <h3>token: {token}</h3>
        </div>
    );
}