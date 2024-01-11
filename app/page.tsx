import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'
import { redirect } from 'next/navigation'

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
async function getPages(){
  const unfilteredPages = await fetch(`${URL}/api/v2/pages?fields=_,id,type`)
  .then(response => response.json())
  .then(data => data.items)
  return unfilteredPages
}

async function processPage(id){
  return await fetch(`${URL}/api/v2/pages/${id}`).then(data => data.json())
}

export default async function Home() {
  const {blog_authors, body}: HomePageData  = await getHomePageData();
  const pages = await getPages();
  const results = []
  for (let i = 0; i < pages.length; i++){
    const page = pages[i];
    const {id} = page;
    const result = await processPage(id);
    results.push(result)
  }


  

  return (
    <div className={styles.body}>

      <DesktopIntro blog_authors={blog_authors && blog_authors} />
      <div className={styles.bio} dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  );
}
