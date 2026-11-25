import styles from './projectPage.module.css';
import Testimonial from "@/app/components/Testimonial";
import { GoBackLink } from "@/app/blog/[slug]/GoBackLink/GoBackLink";
import { Metadata } from "next";
import { notFound } from 'next/navigation';
import { stegaClean } from '@sanity/client/stega';
import seo from '@/app/components/SEO'
import { AuthorInfo } from "@/app/blog/[slug]/AuthorInfo/AuthorInfo";
import Comments from "@/app/blog/[slug]/Comments";
import HeaderGenerator from "@/app/components/HeaderGenerator";
import UnlistedBanner from '@/app/components/UnlistedBanner/UnlistedBanner';
import PortableTextBody from '@/app/components/PortableTextBody/PortableTextBody';
import { tagTitles } from '@/app/components/PortfolioPreview/tagTitles';
import { toTestimonialViews } from '@/app/components/Testimonial/testimonialView';
import { sanityFetch } from '@/sanity/lib/live';
import { PROJECT_QUERY, PROJECT_SEO_QUERY } from '@/sanity/lib/queries';
import { hasAsset, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogImageUrl } from '@/sanity/lib/image';

type Props = {
  params: Promise<{ slug: string }>
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;

  const { data: content } = await sanityFetch({
    query: PROJECT_SEO_QUERY,
    params: { slug: params.slug },
    stega: false,
  });

  if (!content) {
    notFound();
  }

  const title = content.seo?.title || content.title || '';
  const fullTitle = `${title} - Projects - ${seo.sitename}`;

  // The SEO description, falling back to the intro (never the SEO title).
  const description = content.seo?.description || content.intro || undefined;

  const image = [content.contentImage, content.previewImage].find(hasAsset);

  return {
    description,
    title: fullTitle,
    authors: [{ name: "Josh Martin" }],
    publisher: "cjoshmartin.com",
    keywords: tagTitles(content.technologies),
    alternates: {
      canonical: `https://cjoshmartin.com/projects/${params.slug}`,
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

export default async function Page(props: Props) {
  const params = await props.params;
  const { data: project } = await sanityFetch({
    query: PROJECT_QUERY,
    params: { slug: params.slug },
  });

  if (!project) {
    notFound();
  }

  const {
    _id,
    title,
    body,
    heroMedia,
    contentImage,
    client,
    legacyId,
    isUnlisted,
  } = project;
  const medium = tagTitles(project.mediums);
  const technologies = tagTitles(project.technologies);
  const testimonials = toTestimonialViews(project.testimonials);

  return (
    <div className={styles.container}>
      {isUnlisted && <UnlistedBanner />}
      <GoBackLink href={"/projects"} />
      <HeaderGenerator
        className={styles.headerImage}
        heroMedia={heroMedia}
        contentImage={contentImage}
      />
      <div className={styles.projectInfo}>
        <h2>{title}</h2>
        {client && <h3 style={{ fontWeight: "400" }}>Client: {client}</h3>}
        <h4>Medium: {medium.join(", and ")}</h4>
        <h5>Technologies: {technologies.join(", ")}</h5>
      </div>
      <div className={styles.testimonials}>
        {testimonials.map((testimonial) => (
          <Testimonial testimonial={testimonial} key={testimonial.key} />
        ))}
      </div>
      <div className={styles.contentArea}>
        <PortableTextBody value={body} />
      </div>
      {/* <AuthorInfo {...author} /> */}
      <Comments
        slug={params.slug}
        identifier={legacyId != null ? String(legacyId) : _id}
        title={stegaClean(title) ?? ''}
      />
    </div>
  );
}
