import styles from './projectPage.module.css';
import HtmlGenerator from '@/app/components/HtmlGenerator';
import Testimonial from "@/app/components/Testimonial";
import { GoBackLink } from "@/app/blog/[slug]/GoBackLink";
import { Metadata, ResolvingMetadata } from "next";
import { getFromSlug, getPreviewContent } from "@/app/components/api/pages";
import seo from '@/app/components/SEO'
import { AuthorInfo } from "@/app/blog/[slug]/AuthorInfo/AuthorInfo";
import Comments from "@/app/blog/[slug]/Comments";
import HeaderGenerator from "@/app/components/HeaderGenerator";
import UnlistedBanner from '@/app/components/UnlistedBanner/UnlistedBanner';

async function getPage(slug: string, searchParams: any){
  if(slug === 'preview'){
    return await getPreviewContent(searchParams)
  }


    return await getFromSlug(slug);
}

type Props = {
  params: any 
  searchParams: any 
}

export async function generateMetadata(
  { params, searchParams }: Props,
  parent: ResolvingMetadata
): Promise<Metadata> {
  
    const content = await getPage(params.slug, searchParams);
    const {meta} = content
    let title =  content.title;
    if (meta?.seo_title && meta?.seo_title.length > 0){
      title = meta?.seo_title;
    }
    const fullTitle = `${title} - Projects - ${seo.sitename}`;

    let description = content.intro;
    if (meta.seo_title && meta.seo_title.length > 0) {
      description = meta.seo_title
    }

  return {
    description,
    title: fullTitle,
    authors: [{name: "Josh Martin"}],
    openGraph: {
      title,
      siteName: seo.sitename,
      description: description,
      images:
        content.content_image?.url ||
        content.preview_image?.url ||
        seo.defaultImg,
    },
  };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { [key: string]: string | string[] | undefined }
}) {
  const {
    title,
    body,
    content_visuals,
    content_image,
    client,
    medium,
    technologies,
    testimonials,
    author,
    id,
    is_unlisted
  } = await getPage(params.slug, searchParams);

  return (
    <div className={styles.container}>
      {(is_unlisted || params.slug === 'preview') && <UnlistedBanner />}
      <GoBackLink href={"/projects"} />
      <HeaderGenerator
        className={styles.headerImage}
        content_visuals={content_visuals}
        content_image={content_image}
      />
      <div className={styles.projectInfo}>
        <h2>{title}</h2>
        {client && <h3 style={{ fontWeight: "400" }}>Client: {client}</h3>}
        <h4>Medium: {medium?.join(", and ")}</h4>
        <h5>Technologies: {technologies.join(", ")}</h5>
      </div>
      <div className={styles.testimonials}>
        {testimonials.map(({ testimonial }: any, i: number) => (
          <Testimonial testimonial={testimonial} key={i} />
        ))}
      </div>
      <div className={styles.contentArea}>
        <HtmlGenerator body={body} />
      </div>
      {/* <AuthorInfo {...author} /> */}
      <Comments slug={params.slug} id={id} title={title} />
    </div>
  );
}