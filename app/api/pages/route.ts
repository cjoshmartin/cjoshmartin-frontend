import URL from '@/app/components/defaulturl';

export const dynamic = 'force-dynamic' // defaults to auto
export async function GET(requst: Request){
  
  const pages = await fetch(`${URL}/api/v2/pages?fields=_,id,type,title`)
  .then(response => response.json())
  .then(data => data.items.filter(({meta}: any) => meta.type !== "blog.BlogIndexPage"));

  const results: any[] = []
  for (let i = 0; i < pages.length; i++){
    const page = pages[i];
    const {id} = page;
    const result = await fetch(`${URL}/api/v2/pages/${id}`).then((data) =>
      data.json()
    );
    results.push(result);
  }

  return Response.json(results)

}