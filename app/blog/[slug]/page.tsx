import seo from '@/app/components/SEO'

import styles from './blogpost.module.css'
import moment from "moment"
import Comments from "./Comments"
import { GoBackLink } from "./GoBackLink/GoBackLink"
import { Metadata } from "next"
import { notFound } from 'next/navigation'
import { stegaClean } from '@sanity/client/stega'
import { AuthorInfo } from './AuthorInfo/AuthorInfo'
import HeaderGenerator from '@/app/components/HeaderGenerator'
import { CalculateReadTime } from '@/app/components/CalculateReadTime/CalculateReadTime'
import RecommendatedPost from '@/app/components/RecommendatedPost/RecommendatedPost'
import PortableTextBody from '@/app/components/PortableTextBody/PortableTextBody'
import UnlistedBanner from '@/app/components/UnlistedBanner/UnlistedBanner'
import { getHeadings, readingMinutes, readingSourceFromBody, type Heading } from '@/lib/portableText'
import { sanityFetch } from '@/sanity/lib/live'
import { BLOG_POST_QUERY, BLOG_POST_SEO_QUERY } from '@/sanity/lib/queries'
import { hasAsset, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogImageUrl } from '@/sanity/lib/image'

type Props = {
  params: Promise<{
    slug: string;
  }>;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;

  const { data: content } = await sanityFetch({
    query: BLOG_POST_SEO_QUERY,
    params: { slug: params.slug },
    stega: false,
  })

  if (!content) {
    notFound()
  }

  const title = content.seo?.title || content.title || ''
  const fullTitle = `${title} - Blog - ${seo.sitename}`;

  // The SEO description, falling back to the intro (never the SEO title).
  const description = content.seo?.description || content.intro || undefined

  const image = [content.heroImage, content.contentImage].find(hasAsset)

  return {
    description,
    title: fullTitle,
    authors: [{name: "Josh Martin"}],
    publisher: "cjoshmartin.com",
    alternates: {
      canonical: `https://cjoshmartin.com/blog/${params.slug}`,
    },
    openGraph: {
      title,
      siteName: seo.sitename,
      description: description,
      type: "article",
      publishedTime: content.date ?? undefined,
      images: image
        ? { url: ogImageUrl(image), width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT }
        : seo.defaultImg,
    },
  };
}


function OutlineGenerator({content}: {content: Heading[]}){
  if(content.length < 1){
    return null;
  }


  return (
    <div
    className={styles.outlineContainer}
    >
        <ul className={styles.outlineList}>
        {content.map(({id, title, level: size}) => (
          <li key={id} style={{ marginLeft: `${(size - 1) * 20}px` }}>
            <a href={`#${id}`}>{title}</a>
          </li>
        ))}
      </ul>
    </div>
  )
}



export default async function Page(props: Props) {
  const params = await props.params;
  const { data: post } = await sanityFetch({
    query: BLOG_POST_QUERY,
    params: { slug: params.slug },
  })

  if (!post) {
    notFound()
  }

  const { _id, title, body, date, legacyId, author, heroMedia, contentImage, isUnlisted } = post;

  // The outline and the rendered headings use the same ids (lib/portableText.ts).
  const content = getHeadings(body);
  return (
    <div
    className={styles.outerContainer}
    >
      {/* generate clickaable links that jump to headers in this blog post */}
      <OutlineGenerator content={content} />
      <div className={`${styles.container} ${content.length > 0 ? styles.withOutline : ''}`}>
        {isUnlisted && <UnlistedBanner />}
        <HeaderGenerator
          className={styles.headerImage}
          heroMedia={heroMedia}
          contentImage={contentImage}
        />
        <div className={styles.contentArea}>
          <h2>{title}</h2>
          <div className={styles.readTime}>
            <small>{moment(stegaClean(date) ?? undefined).format("MMMM DD, YYYY")}</small>
            <CalculateReadTime minutes={readingMinutes(readingSourceFromBody(body))} />
          </div>
          <div className={styles.content}>
            <PortableTextBody value={body} />
          </div>
          <hr
            style={{
              marginTop: "2rem",
              marginBottom: "1rem",
            }}
          />
          {author && <AuthorInfo author={author} />}
          <hr
            style={{
              marginTop: "2rem",
              marginBottom: "1rem",
            }}
          />
          <RecommendatedPost slug={params.slug} />
          <Comments
            slug={params.slug}
            identifier={legacyId != null ? String(legacyId) : _id}
            title={stegaClean(title) ?? ''}
          />
        </div>
      </div>
    </div>
  );
}

/*

*/
