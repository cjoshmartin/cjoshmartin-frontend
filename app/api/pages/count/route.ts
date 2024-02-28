// import URL from '@/app/components/defaulturl';

// export const dynamic = 'force-dynamic' // defaults to auto

import response from "../fake_response";

export async function GET(requst: Request){

  // const pages = await fetch(`${URL}/api/pages/?fields=_,id,type,title,slug&format=json`)
  // .then(response => response.json())
  // .then(data => data.items.filter(({meta}: any) => meta.type !== "blog.BlogIndexPage"));
  // const count = pages.reduce((acc: any, {meta} :any) => {
  //   if(!acc[meta?.type]){
  //       acc[meta?.type] = 1;
  //   }
  //   else {
  //       acc[meta?.type] += 1;
  //   }
  //   return acc;

  // }, {})

  const count = response
  .filter(({meta}: any) => meta.type !== "blog.BlogIndexPage")
  .reduce((acc: any, {meta} :any) => {
    if(!acc[meta?.type]){
        acc[meta?.type] = 1;
    }
    else {
        acc[meta?.type] += 1;
    }
    return acc;
  }, {})

  return Response.json({count, response})

}