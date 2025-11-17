import { JSDOM } from 'jsdom';

import seo from '@/app/components/SEO'

import styles from './blogpost.module.css'
import moment from "moment"
import HtmlGenerator from "@/app/components/HtmlGenerator/HtmlGenerator"
import Comments from "./Comments"
import { GoBackLink } from "./GoBackLink"
import { Metadata, ResolvingMetadata } from "next"
import { getFromSlug, getPreviewContent } from "@/app/components/api/pages"
import { AuthorInfo } from './AuthorInfo/AuthorInfo'
import HeaderGenerator from '@/app/components/HeaderGenerator'
import { useMemo } from 'react'
import { CalculateReadTime } from '@/app/components/CalculateReadTime/CalculateReadTime'
import RecommendatedPost from '@/app/components/RecommendatedPost/RecommendatedPost'

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
    authors: [{name: "Josh Martin"}],
    publisher: "cjoshmartin.com",
    keywords: content.technologies,
    alternates: {
      canonical: `https://cjoshmartin.com/blog/${params.slug}`,
    },
    openGraph: {
      title,
      siteName: seo.sitename,
      description: description,
      type: "article",
      publishedTime: content.date,
      images:
        type == "image" ? value?.url : undefined ||
        content.content_image?.url ||
        content.preview_image?.url ||
        seo.defaultImg,
    },
  };
}


function OutlineGenerator({body}: {body: any}){
  const content = useMemo(() => {
    return body.filter(({type, value, id}: any) => {
      // const headers = value.match(/<h[1-6]>.*<\/h[1-6]>/g);
      return(type === "full_richtext")
    })  
    .reduce((acc: any, {value}: any) => {
      const {window} = new JSDOM(value);
      const {document} = window;
      const headers = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      //get value of each header and get header size h1, h2, h3, h4, h5, h6
      const headersWithSize = Array.from(headers).map(
        (header: any, index: number) => {
          const title = header.textContent;
          const sanitizedText = title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "") // Remove special characters
            .replace(/\s+/g, "-") // Replace spaces with hyphens
            .trim();

          const id = sanitizedText || `header-${index + 1}`;

          return {
            title: title,
            id: id,
            size: parseInt(header.tagName.toLowerCase().split("h")[1]),
          };
        }
      );
      return acc.concat(headersWithSize)
    }, [])
  
  }, [body])

  return (
    <div>
      <ul>
        {content.map(({id, title, size}: any) => (
          <li key={id} style={{ marginLeft: `${(size - 1) * 20}px` }}>
            <a href={`#${id}`}>{title}</a>
          </li>
        ))}
      </ul>
    </div>
  )
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
  const { title, body, date, id, author, content_visuals, content_image, technologies } =
    await getPage(params.slug, searchParams);

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
        <div className={styles.readTime}>
          <small>{moment(date).format("MMMM DD, YYYY")}</small>
          <CalculateReadTime body={body} />
        </div>

      {/* generate clickaable links that jump to headers in this blog post */}
      <OutlineGenerator  body={body}/>

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
        <hr
          style={{
            marginTop: "2rem",
            marginBottom: "1rem",
          }}
        />
        <RecommendatedPost slug={params.slug} tags={technologies}/>
        {params.slug !== 'preview'&&
          <Comments slug={params.slug} id={id} title={title} />
        }
      </div>
    </div>
  );
}

/*
    
*/