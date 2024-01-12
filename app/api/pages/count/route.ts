import URL from '@/app/components/defaulturl';

export const dynamic = 'force-dynamic' // defaults to auto
export async function GET(requst: Request){

  const pages = await fetch(`${URL}/api/v2/pages?fields=_,id,type,title,slug`)
  .then(response => response.json())
  .then(data => data.items.filter(({meta}: any) => meta.type !== "blog.BlogIndexPage"));
  const count = pages.reduce((acc, {meta}) => {
    if(!acc[meta?.type]){
        acc[meta?.type] = 1;
    }
    else {
        acc[meta?.type] += 1;
    }
    return acc;

  }, {})

  return Response.json({count, pages})

}