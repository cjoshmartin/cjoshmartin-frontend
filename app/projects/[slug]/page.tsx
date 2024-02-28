import ShowImage from "@/app/blog/_compoents/ShowImage";
import styles from './projectPage.module.css';
import HtmlGenerator from '@/app/components/HtmlGenerator';
import Testimonial from "@/app/components/Testimonial";
import { GoBackLink } from "@/app/blog/[slug]/GoBackLink";
import { Metadata, ResolvingMetadata } from "next";
import { getFromSlug } from "@/app/components/api/pages";


async function getPage(slug: string){
    return await getFromSlug(slug);
}

type Props = {
  params: any 
  searchParams: any 
}

export async function generateMetadata(
  { params, searchParams }: Props,
  parent: ResolvingMetadata
): Promise<Metadata> {
  
    const {title} = await getPage(params.slug);

  return {
    title: `${title} - Projects - Josh Martin\'s Website`,
  }
}

export default async function Page({ params }: { params: { slug: string } }){
    const {title, body, content_image, client, medium, technologies, testimonials} = await getPage(params.slug);

    return (
      <div className={styles.container}>
        <GoBackLink href={'/projects'} />
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