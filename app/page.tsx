import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'
import generateURL from './components/generateURL'
import { PageTypes } from './PageTypes'
import Testimonial from './components/Testimonial'
import PortfolioPreview from './components/PortfolioPreview/PortfolioPreview'

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

function randomIntFromInterval(min: number, max: number) { // min and max included 
  return Math.floor(Math.random() * (max - min + 1) + min)
}

async function getHomePageData(): Promise<HomePageData> {
  return fetch(generateURL("/api/pages"))
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
}

export default async function Home() {
  const {blog_authors, body, testimonials}: HomePageData  = await getHomePageData();

  return (
    <div className={styles.body}>
      <DesktopIntro blog_authors={blog_authors && blog_authors} bio={body}/>
      <br />
      <Testimonial testimonial={testimonials[randomIntFromInterval(0, testimonials.length - 1)].testimonial} />
      <br />
     <PortfolioPreview /> 
     <br />
    </div>
  );
}
