import generateURL from "@/app/components/generateURL"

async function getPage(slug: string){
    const url = generateURL(`/api/pages/get-page-from-slug?query=${slug}`)
    return await fetch(url)
    .then(data => data.json())
}


export default async function Page({ params }: { params: { slug: string } }){
    const {title, body} = await getPage(params.slug);
    return (
        <div>
            <div 
                dangerouslySetInnerHTML={{__html: body[0].value}}
            />
        </div>
    )
}
