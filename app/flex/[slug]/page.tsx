import HtmlGenerator from "@/app/components/HtmlGenerator";
import generateURL from "@/app/components/generateURL"
import styles from './flexPage.module.css'

async function getPage(slug: string){
    const url = generateURL(`/api/pages/get-page-from-slug?query=${slug}`)
    return await fetch(url)
    .then(data => data.json())
}

export default async function Page({ params }: { params: { slug: string } }){
    const {title, body} = await getPage(params.slug);
    return (
        <div className={styles.container}>
            <h1>{title}</h1>
            <HtmlGenerator body={body}/>
        </div>
    )
}
