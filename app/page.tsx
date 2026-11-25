import styles from './page.module.css'
import DesktopIntro, { type IntroAuthor } from './components/intro/DesktopIntro'
import Testimonial from './components/Testimonial'
import PortfolioPreview from './components/PortfolioPreview/PortfolioPreview'
import PersonalPortfolioPreview from './components/PersonalPortfolioPreview'
import CTASection from './components/CTASection/CTASection'
import ResumeSection from './components/ResumeSection/ResumeSection'
import { Metadata } from 'next'
import { stegaClean } from '@sanity/client/stega'
import seo from '@/app/components/SEO'
import { Services } from './components/Services/Services'
import { Meetup } from './__compoents/Meetup'
import { Esty } from './__compoents/Esty'
import { FocusModes } from './components/Context/FocusMode'
import PortableTextBody from './components/PortableTextBody/PortableTextBody'
import { toTestimonialViews } from './components/Testimonial/testimonialView'
import { sanityFetch } from '@/sanity/lib/live'
import { HOME_PAGE_QUERY, HOME_PAGE_SEO_QUERY } from '@/sanity/lib/queries'
import { hasAsset, imageUrl, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogImageUrl, scaledDimensions } from '@/sanity/lib/image'

const DEFAULT_DESCRIPTION = 'This website showcase the work of Josh Martin.\
    A Chicago based (freelance) programmer who can create your next mobile app, web application or embedded project'

/** Widest rendition of the profile photo (the original is 937px wide). */
const AUTHOR_IMAGE_WIDTH = 1000

export async function generateMetadata(): Promise<Metadata> {
  const { data: content } = await sanityFetch({ query: HOME_PAGE_SEO_QUERY, stega: false })

  if (!content) {
    throw new Error('generateMetadata: the "homePage" document was not found in Sanity.')
  }

  const title = content.seo?.title || content.title || seo.sitename
  const fullTitle = `Home - ${seo.sitename}`
  const description = content.seo?.description || DEFAULT_DESCRIPTION
  const image = hasAsset(content.authorImage)
    ? { url: ogImageUrl(content.authorImage), width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT }
    : seo.defaultImg

  return {
    description,
    title: fullTitle,
    // metadataBase: new URL('http://badideas.cards'),
    openGraph: {
      title,
      siteName: seo.sitename,
      description,
      images: image,
    },
    alternates: {
      canonical: "https://cjoshmartin.com",
    },
  };
}

// Query parameters (for example ?utm_source=...) are ignored: drafts are only shown in Draft Mode.
export default async function Home() {
  const { data: content } = await sanityFetch({
    query: HOME_PAGE_QUERY,
    params: { audience: FocusModes.Developer },
  })

  if (!content) {
    throw new Error('Home: the "homePage" document was not found in Sanity.')
  }

  const { author, bio, services } = content
  const testimonials = toTestimonialViews(content.testimonials)

  const introAuthor: IntroAuthor | undefined = author
    ? {
        firstName: author.firstName ?? undefined,
        lastName: author.lastName ?? undefined,
        jobTitle: author.jobTitle ?? undefined,
        location: author.location ?? undefined,
        email: stegaClean(author.email) ?? undefined,
        github: stegaClean(author.github) ?? undefined,
        image: hasAsset(author.image)
          ? {
              url: imageUrl(author.image, AUTHOR_IMAGE_WIDTH),
              alt: stegaClean(author.image.alt) ?? '',
              ...scaledDimensions(author.image, AUTHOR_IMAGE_WIDTH),
            }
          : undefined,
      }
    : undefined

  return (
    <div className={styles.body}>
      <DesktopIntro
        author={introAuthor}
        bio={<PortableTextBody value={bio} />}
      />
      <Testimonial
        title="What People Have To Say,"
        testimonial={testimonials[0]}
        all={testimonials}
      />

      {/* <h2
        style={{
          backgroundColor: "var(--third-color)",
          color: "var(--secondary-color)",
          padding: "1rem",
          width: "100%",
        }}
      >
        Brands I have worked with
      </h2> */}
      <Services services={services ?? []} />
      <PortfolioPreview project_audience={FocusModes.Developer}/>
      <PersonalPortfolioPreview project_audience={FocusModes.Developer} />
      {/* <Meetup /> */}
      {/* <Esty /> */}

      {/* <h2>Experence</h2>
     <h2>What do I Do?</h2> */}
      {/* <h2>
        <a href="https://storage.googleapis.com/images-for-cms/documents/Josh_Martin_-_Resume.pdf">
          [ contact@cjoshmartin.com ]
        </a>
      </h2>
      <a
        href="https://storage.googleapis.com/images-for-cms/documents/Josh_Martin_-_Resume.pdf"
        target="_blank"
      >
        <h2>[ Download Resume ]</h2>
      </a> */}
      <ResumeSection />
      {/*<CTASection />*/}
    </div>
  );
}
