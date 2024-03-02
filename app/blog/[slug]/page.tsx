

import generateURL from "@/app/components/generateURL"
import ShowImage from '@/app/blog/_compoents/ShowImage'

import styles from './blogpost.module.css'
import moment from "moment"
import HtmlGenerator from "@/app/components/HtmlGenerator"
import Comments from "./Comments"
import { GoBackLink } from "./GoBackLink"
import { Metadata, ResolvingMetadata } from "next"
import { getFromSlug, getPreviewContent } from "@/app/components/api/pages"

async function getPage(slug: string, searchParams: any){
  if(slug === 'preview'){
    return await getPreviewContent(searchParams)
  }


    return await getFromSlug(slug);
}

export async function generateMetadata(
  { params, searchParams }: any,
  parent: ResolvingMetadata
): Promise<Metadata> {
  
    const {title} = await getPage(params.slug, searchParams);

  return {
    title: `${title} - Blog - Josh Martin\'s Website`,
  }
}

export default async function Page({
  params,
  searchParams,
}: {
  params: {
    slug: string;
  };
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const { title, body, date, id } = await getPage(params.slug, searchParams);
  return (
    <div className={styles.container}>
      <GoBackLink href="/blog" />
      <ShowImage width={772} height={360} className={styles.headerImage} />
      <div className={styles.contentArea}>
        <h2>{title}</h2>
        <small>{moment(date).format("MMMM DD, YYYY")}</small>
        <div className={styles.content}>
          <HtmlGenerator body={body} />
        </div>

        <Comments slug={params.slug} id={id} title={title} />
      </div>
    </div>
  );
}

/*
    
*/