import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'

interface AuthorImageData {
    url: string,
    title: string,
    width: string,
    height: string,
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
}


import URL from './components/defaulturl';

async function getHomePageData(): Promise<HomePageData>{
  return fetch(`${URL}/api/v2/pages/3/`)
    .then(response => response.json())
    .then(data  =>{
      const {blog_authors, body} = data;

      return  {
        blog_authors: [blog_authors[0]],
        body
      }
    })
}

export default async function Home() {
  const {blog_authors, body}: HomePageData  = await getHomePageData();

  return (
    <div className={styles.body}>

      <DesktopIntro blog_authors={blog_authors && blog_authors} />
      <div className={styles.bio} dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  );
}
