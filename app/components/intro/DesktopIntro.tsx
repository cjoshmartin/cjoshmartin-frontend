'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image'
import styles from './intro.module.css'

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
    const [link, setLink] = useState(props.link);
    useEffect(() => {
        switch(props.type){
            case LinkType.email:
                setLink(`mailto:${link}`);
                break;
            default:
                setLink(link)
        }
    }, [])

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
    const [author, setAuthor] = useState<AuthorData | null | undefined>();
    useEffect(() => {
        if((props?.blog_authors ?? []).length > 0){
            setAuthor(props.blog_authors[0].author)
        }

    }, [props.blog_authors])

    return (
    <div className={styles.intro}>
            <Image 
               src={author?.image.url} 
               alt={author?.image.title}
               width={author?.image.width}
               height={author?.image.height}
               className={styles.profileImage}
            />
            <div style={{textAlign: "center"}}>
                <h1>{author?.first_name} {author?.last_name}</h1>
                <h2>{author?.job_title}</h2>
                <h4>{author?.location}</h4>
                <ClickableLink link={author?.email ?? "contact@cjoshmartin.com"} type={LinkType.email} />
                {author?.github && (
                    <>
                        <br />
                        <ClickableLink style={{ marginTop: ".5rem" }} link={author?.github}/>
                    </>
                )}
            </div>
</div>
    );
}