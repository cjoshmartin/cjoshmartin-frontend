import generateURL from "@/app/components/generateURL"
import ShowImage from '@/app/blog/_compoents/ShowImage'

import styles from './blogpost.module.css'
import moment from "moment"
import HtmlGenerator from "@/app/components/HtmlGenerator"

async function getPage(slug: string){
    const url = generateURL(`/api/pages/get-page-from-slug?query=${slug}`)
    return await fetch(url)
    .then(data => data.json())
}

export default async function Page({ params }: { params: { slug: string } }){
    const {title, body, date} = await getPage(params.slug);
    return (
      <div className={styles.container}>
        <a href="/blog">
          <u>{"<<< Go back"}</u>
        </a>
        <ShowImage width={772} height={360} className={styles.headerImage} />
        <div className={styles.contentArea}>
          <h2>{title}</h2>
          <small>{moment(date).format("MMMM DD, YYYY")}</small>
          <div className={styles.content}>
            <HtmlGenerator body={body}/>
          </div>
        </div>
      </div>
    );
}

/*
    
*/