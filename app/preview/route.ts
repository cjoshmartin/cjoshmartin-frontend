import { redirect } from "next/navigation";
import { PageTypes } from "../PageTypes";

import { type NextRequest } from 'next/server'


export async function GET(request: NextRequest) {
    const searchParams = request?.nextUrl?.searchParams
    const content_type = searchParams.get('content_type')
    const token = searchParams.get('token')
        // @ts-ignore
    console.log("YOYOYO content_Type:", content_type, " YOYO, token:", token)

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
      return redirect(base + path);
    }
    return new Response();
}