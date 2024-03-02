import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'
import { PageTypes } from './PageTypes'
import Testimonial from './components/Testimonial'
import PortfolioPreview from './components/PortfolioPreview/PortfolioPreview'
import PersonalPortfolioPreview from './components/PersonalPortfolioPreview'
import { RandomIntFromInterval } from './randomIntFromInterval'
import { getPages, getPreviewContent } from './components/api/pages'
import CTASection from './components/CTASection/CTASection'

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

  if(searchParams && Object.keys(searchParams).length > 0){
    content = await getPreviewHomePageData(searchParams);
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
        testimonial={
          testimonials[RandomIntFromInterval(0, testimonials.length - 1)]
            .testimonial
        }
        all={testimonials}
      />
      {/* <div
        style={{
          backgroundColor: "var(--primary-color)",
          color: "var(--secondary-color)",
          width: "100%",
          padding: "2rem",
        }}
      >
        <h2>Services</h2>
        <div
          style={{
            display: "flex",
            padding: "1rem",
            flexDirection: "column",
          }}
        >
          <div>
            <h3>Mobile Developement</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <img
                src="https://unsplash.com/photos/bMTl6uFMONg/download?ixid=M3wxMjA3fDB8MXxzZWFyY2h8Mnx8bW9iaWxlJTIwYXBwfGVufDB8fHx8MTcwOTIzNzUyNnww&force=true&w=640"
                style={{
                  width: "350px",
                  padding: "1rem",
                }}
                alt="tacos"
              />
              <p>
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. In
                commodo erat eleifend risus tempor, a gravida metus maximus.
                Praesent gravida diam vitae nisi aliquam, non scelerisque eros
                ullamcorper. Mauris vel porttitor ante, vel facilisis risus.
                Vestibulum eu magna sit amet felis bibendum dapibus eget et
                magna. Maecenas maximus lobortis lacus in fermentum. Nullam at
                ante tempor odio vulputate malesuada eget vitae elit. Mauris
                tempor consectetur nibh, quis dictum sapien fringilla eget.
              </p>
            </div>
          </div>
          <div>
            <h3>Web Developement</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "row-reverse",
                alignItems: "center",
              }}
            >
              <img
                src="https://unsplash.com/photos/hGV2TfOh0ns/download?ixid=M3wxMjA3fDB8MXxzZWFyY2h8OHx8d2Vic2l0ZXxlbnwwfHx8fDE3MDkyMjQyNzR8MA&force=true&w=640"
                style={{
                  width: "350px",
                  padding: "1rem",
                }}
              />
              <div>
                <p>
                  Lorem ipsum dolor sit amet, consectetur adipiscing elit. In
                  commodo erat eleifend risus tempor, a gravida metus maximus.
                  Praesent gravida diam vitae nisi aliquam, non scelerisque eros
                  ullamcorper. Mauris vel porttitor ante, vel facilisis risus.
                  Vestibulum eu magna sit amet felis bibendum dapibus eget et
                  magna. Maecenas maximus lobortis lacus in fermentum. Nullam at
                  ante tempor odio vulputate malesuada eget vitae elit. Mauris
                  tempor consectetur nibh, quis dictum sapien fringilla eget.
                </p>
                <button>Looking at web projects</button>
              </div>
            </div>
          </div>
          <div>
            <h3>IoT/Firmware Developement</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <img
                src="https://unsplash.com/photos/cDK_VY_A9x8/download?ixid=M3wxMjA3fDB8MXxzZWFyY2h8MTZ8fGlvdHxlbnwwfHx8fDE3MDkyMzg0MDh8MA&force=true&w=640"
                style={{
                  width: "350px",
                  padding: "1rem",
                }}
              />
              <p>
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. In
                commodo erat eleifend risus tempor, a gravida metus maximus.
                Praesent gravida diam vitae nisi aliquam, non scelerisque eros
                ullamcorper. Mauris vel porttitor ante, vel facilisis risus.
                Vestibulum eu magna sit amet felis bibendum dapibus eget et
                magna. Maecenas maximus lobortis lacus in fermentum. Nullam at
                ante tempor odio vulputate malesuada eget vitae elit. Mauris
                tempor consectetur nibh, quis dictum sapien fringilla eget.
              </p>
            </div>
          </div>
        </div>
      </div> */}
      <PortfolioPreview />
      <PersonalPortfolioPreview />
      {/* <h2>Experence</h2>
     <h2>Brands I have worked with</h2>
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
