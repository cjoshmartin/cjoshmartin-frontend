import { redirect } from "next/navigation";
import { PageTypes } from "../PageTypes";


export default async function Page({ params, searchParams }: {  
        params?: any
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


    return (<div/>);
}