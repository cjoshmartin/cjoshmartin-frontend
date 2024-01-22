import ShowImage from "@/app/blog/_compoents/ShowImage";
import styles from './projectPage.module.css';
import Link from 'next/link';
import generateURL from '@/app/components/generateURL';
import HtmlGenerator from '@/app/components/HtmlGenerator';
import Testimonial from "@/app/components/Testimonial";


async function getPage(slug: string){
    const url = generateURL(`/api/pages/get-page-from-slug?query=${slug}`)
    return await fetch(url)
    .then(data => data.json())
}

export default async function Page({ params }: { params: { slug: string } }){
    const {title, body, content_image, client, medium, technologies, testimonials} = await getPage(params.slug);

    return (
      <div className={styles.container}>
        <Link href="/projects">
          <u>{"<<< Go back"}</u>
        </Link>
        <ShowImage
          width={content_image?.width ?? 770}
          height={content_image?.height ?? 360}
          url={content_image.url}
          className={styles.headerImage}
        />
        <div className={styles.projectInfo}>
          <h2>{title}</h2>
          {client &&<h3 style={{ fontWeight: "400" }}>Client: {client}</h3>}
          <h4>Medium: {medium?.join(', and ')}</h4>
          <h5>Technologies: {technologies.join(", ")}</h5>
        </div>
        <div className={styles.testimonials}>
        {
          testimonials.map(({testimonial}: any, i: number)  => (
            <Testimonial 
              testimonial={testimonial}
              key={i}
            />
          ))
        }          
        </div>
        <div className={styles.contentArea}>
            <HtmlGenerator body={body}/>
        </div>
      </div>
    );
}