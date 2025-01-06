import seo from '@/app/components/SEO'
import ShowImage from '@/app/blog/_compoents/ShowImage'

import styles from './blogpost.module.css'
import moment from "moment"
import HtmlGenerator from "@/app/components/HtmlGenerator"
import Comments from "./Comments"
import { GoBackLink } from "./GoBackLink"
import { Metadata, ResolvingMetadata } from "next"
import { getFromSlug, getPreviewContent } from "@/app/components/api/pages"
import { AuthorInfo } from './AuthorInfo/AuthorInfo'
import HeaderGenerator from '@/app/components/HeaderGenerator'

async function getPage(slug: string, searchParams: any){
  if(slug === 'preview'){
    return await getPreviewContent(searchParams)
  }
    const content =  await getFromSlug(slug);
    const {blog_authors} = content;

    return {
      ...content, 
      author: blog_authors[0].author
    };
}

export async function generateMetadata(
  { params, searchParams }: any,
  parent: ResolvingMetadata
): Promise<Metadata> {
  
    const content = await getPage(params.slug, searchParams);
    const {meta} = content
    let title =  content.title;
    if (meta?.seo_title && meta?.seo_title.length > 0){
      title = meta?.seo_title;
    }
    const fullTitle = `${title} - Blog - ${seo.sitename}`;

    let description = content.intro;
    if (meta?.seo_title && meta.seo_title.length > 0) {
      description = meta.seo_title
    }


    const {content_visuals} = content;
    const  {type, value} = content_visuals.length > 0 ? content_visuals[0] : {type: "", value: undefined};
  return {
    description,
    title: fullTitle,
    openGraph: {
      title,
      siteName: seo.sitename,
      description: description,
      images:
        type == "image" ? value?.url : undefined ||
        content.content_image?.url ||
        content.preview_image?.url ||
        seo.defaultImg,
    },
    alternates: {
      canonical: "https://cjoshmartin.com",
    },
  };
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
  const { title, body, date, id , author, content_visuals, content_image } = await getPage(params.slug, searchParams);

  return (
    <div className={styles.container}>
      <GoBackLink href="/blog" />
      <HeaderGenerator
        className={styles.headerImage}
        content_visuals={content_visuals}
        content_image={content_image}
      />
      <div className={styles.contentArea}>
        <h2>{title}</h2>
        <small>{moment(date).format("MMMM DD, YYYY")}</small>
        <div className={styles.content}>
          <HtmlGenerator body={body} />
        </div>
        <hr
          style={{
            marginTop: "2rem",
            marginBottom: "1rem",
          }}
        />
        <AuthorInfo {...author} slug={params.slug} />
        {/* {params.slug !== 'preview'&&
          <Comments slug={params.slug} id={id} title={title} />
        } */}
      </div>
    </div>
  );
}

/*
    
*/