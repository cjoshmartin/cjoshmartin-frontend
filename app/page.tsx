import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'
import generateURL from './components/generateURL'
import { PageTypes } from './PageTypes'
import Testimonial from './components/Testimonial'
import PortfolioPreview from './components/PortfolioPreview/PortfolioPreview'
import PersonalPortfolioPreview from './components/PersonalPortfolioPreview'
import { RandomIntFromInterval } from './randomIntFromInterval'
import { getPages } from './components/api/pages'

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

async function getHomePageData(): Promise<HomePageData> {

  const url = generateURL("/api/pages");

  /*
  return fetch(url)
    .then((response) => response.json())
    .then((dataset) => {
      const homePageData = dataset.find(
        ({ meta }: any) => meta.type === PageTypes.HOME
      );

      const { blog_authors, body, testimonials } = homePageData;

      return {
        blog_authors: [blog_authors[0]],
        body,
        testimonials,
      };
    });
    */

    return getPages()
    .then((dataset) => {
          const homePageData = dataset.find(
            ({ meta }: any) => meta.type === PageTypes.HOME
          );

          const { blog_authors, body, testimonials } = homePageData;

          return {
            blog_authors: [blog_authors[0]],
            body,
            testimonials,
          };
        });
}

export default async function Home() {
  const {blog_authors, body, testimonials}: HomePageData  = await getHomePageData();

  return (
    <div className={styles.body}>
      <DesktopIntro blog_authors={blog_authors && blog_authors} bio={body}/>
      <Testimonial 
      title='What People Have To Say,'
      testimonial={testimonials[RandomIntFromInterval(0, testimonials.length - 1)].testimonial} 
      all={testimonials}
      />
     {/* <PortfolioPreview /> 
     <PersonalPortfolioPreview /> */}
     {/* <h2>Experence</h2>
     <h2>Brands I have worked with</h2>
     <h2>What do I Do?</h2> */}
     <h2><a href='https://storage.googleapis.com/images-for-cms/documents/Josh_Martin_-_Resume.pdf'>[ contact@cjoshmartin.com ]</a></h2>
     <a href='https://storage.googleapis.com/images-for-cms/documents/Josh_Martin_-_Resume.pdf' target='_blank'><h2>[ Download Resume ]</h2></a>
    </div>
  );
}
