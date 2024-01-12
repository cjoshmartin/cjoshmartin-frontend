import URL from '@/app/components/defaulturl';
import generateURL from '@/app/components/generateURL';

export async function GET(request: Request){
    const searchParams = request?.nextUrl?.searchParams
    const query = searchParams.get('query')
    if(!query){
        throw "Need query preams"
    }
    const baseURl = generateURL(`/api/v2/pages/?fields=_,id&slug=${query}`, URL)

    const id = await fetch(baseURl)
    .then(data => data.json())
    .then(({items}: any) => items[0].id)

    const pageURL = generateURL(`/api/v2/pages/${id}`, URL)

    const pageData = await fetch(pageURL)
    .then(data => data.json())
    
    return Response.json(pageData)
}