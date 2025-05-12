import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'
import { PageTypes } from './PageTypes'
import Testimonial from './components/Testimonial'
import PortfolioPreview from './components/PortfolioPreview/PortfolioPreview'
import PersonalPortfolioPreview from './components/PersonalPortfolioPreview'
import { RandomIntFromInterval } from './randomIntFromInterval'
import { getPages, getPreviewContent } from './components/api/pages'
import CTASection from './components/CTASection/CTASection'
import { Metadata, ResolvingMetadata } from 'next'
import seo from '@/app/components/SEO'
import { Services } from './components/Services/Services'
import { Meetup } from './__compoents/Meetup'
import { Esty } from './__compoents/Esty'
interface AuthorImageData {
    url: string,
    title: string,
    width: number,
    height: number,
}

interface AuthorData {
  first_name: string,
  last_name: string,
  location: string, 
  job_title: string,
  bio?: string, 
  email?: string, 
  github?: string,
  image: AuthorImageData
}
interface AuthorEntryData {
  author: AuthorData
}
interface HomePageData {
  blog_authors: AuthorEntryData[],
  body: string,
  testimonials: any[]
}

export async function generateMetadata(
  { params, searchParams }: any,
  parent: ResolvingMetadata
): Promise<Metadata> {
  
    const content: any = (await getPages({type: PageTypes.HOME}))[0];
    
    const {meta} = content;
    let title =  content.title;
    if (meta?.seo_title && meta?.seo_title.length > 0){
      title = meta?.seo_title;
    }
    const fullTitle = `Home - ${seo.sitename}`;

    const image = content?.blog_authors[0].author?.image?.file || seo.defaultImg

  return {
    description: 'This website showcase the work of Josh Martin.\
    A Chicago based (freelance) programmer who can create your next mobile app, web application or embedded project',
    title: fullTitle,
    // metadataBase: new URL('http://badideas.cards'),
    openGraph: {
      title,
      siteName: seo.sitename,
      description: 'This website showcase the work of Josh Martin.\
      A Chicago based (freelance) programmer who can create your next mobile app, web application or embedded project',
      images: image,
    },
    alternates: {
      canonical: "https://cjoshmartin.com",
    },
  };
}

async function getHomePageData(): Promise<HomePageData> {
    return getPages({type: PageTypes.HOME})
    .then((dataset ) => {
          //@ts-ignore
          const { blog_authors, body, testimonials } = dataset[0];

          return {
            blog_authors: [blog_authors[0]],
            body,
            testimonials,
          };
        });
}

async function getPreviewHomePageData(searchParams: object){
  return getPreviewContent(searchParams)
  .then(data =>{
    const { blog_authors, body, testimonials } = data;
    return {
      blog_authors: [blog_authors[0]],
      body,
      testimonials,
    };
  })
}

export default async function Home({ searchParams }: {  
  searchParams?: { [key: string]: string | string[] | undefined }
}) 
{
  let content = undefined;


  console.log('searchParams', searchParams);

  const params = Object.fromEntries(
    Object.entries(searchParams ?? {}).filter(
      ([key]) => key !== "project_audience"
    )
  );



  if(params && Object.keys(params).length > 0){
    content = await getPreviewHomePageData(params);
  }
  else {
    content = await getHomePageData();
  }

  const {blog_authors, body, testimonials}: HomePageData  = content;

  return (
    <div className={styles.body}>
      <DesktopIntro
        //@ts-ignore
        blog_authors={blog_authors && blog_authors}
        bio={body}
      />
      <Testimonial
        title="What People Have To Say,"
        testimonial={testimonials[0]?.testimonial}
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
      <Services />
      <PortfolioPreview project_audience={searchParams?.project_audience as string}/>
      <PersonalPortfolioPreview project_audience={searchParams?.project_audience as string} />
      <Meetup />
      <Esty />

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
      <CTASection />
    </div>
  );
}
