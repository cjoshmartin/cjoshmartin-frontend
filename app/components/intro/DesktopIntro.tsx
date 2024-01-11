import Image from 'next/image'
import styles from './intro.module.css'
import URL from '../defaulturl';

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

interface DesktopIntroProps {
  blog_authors?: AuthorEntryData[],
}

enum LinkType {
    email,
    http
}
interface ClickableLinkProps {
    link?: string,
    type?: LinkType,
    style?: React.CSSProperties
}
function ClickableLink(props: ClickableLinkProps) {
    let link = props.link;
    switch (props.type) {
        case LinkType.email:
        link = `mailto:${link}`;
        break;
    }

    if (!props.link){
        return null;
    }

    return (
        <span style={props?.style}>
            [
            <a className={styles.clickableLink} href={link} target="_blank">
                {props.link}
            </a>
            ]
        </span>
    );
}

export default function DesktopIntro(props: DesktopIntroProps){

    let author: AuthorData | undefined = undefined;
    let authorImage: string | undefined = undefined

    if(props?.blog_authors &&  props?.blog_authors.length > 0){
        author = props?.blog_authors[0].author;
    }

    if (author?.image.url) {
        authorImage = `${URL}${author?.image.url}`;
    }
    return (
    <div className={styles.intro}>
            <Image 
               src={authorImage ?? ""} 
               alt={author?.image.title ?? ""}
               width={author?.image.width}
               height={author?.image?.height}
               className={styles.profileImage}
               priority
            />
            <div className={styles.introText}>
                <h1>{author?.first_name} {author?.last_name}</h1>
                <h2>{author?.job_title}</h2>
                <h4>{author?.location}</h4>
                <ClickableLink link={author?.email ?? "contact@cjoshmartin.com"} type={LinkType.email} />
                {author?.github && (<ClickableLink link={author?.github}/>)}
            </div>
</div>
    );
}