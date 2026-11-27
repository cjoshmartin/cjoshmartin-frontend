'use client'

import styles from './intro.module.css'
import { motion } from 'framer-motion'
import ShowImage from '@/app/blog/_compoents/ShowImage/ShowImage'

interface AuthorImageData {
    url: string,
    alt: string,
    width: number,
    height: number,
}

/** The home page author, prepared on the server (attribute values have stega removed). */
export interface IntroAuthor {
  firstName?: string,
  lastName?: string,
  location?: string,
  jobTitle?: string,
  email?: string,
  github?: string,
  image?: AuthorImageData
}

interface DesktopIntroProps {
  author?: IntroAuthor,
  /** The rendered home page bio. */
  bio: React.ReactNode,
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
  const author = props.author;

  return (
      <div className={styles.intro}>
        <ShowImage
          url={author?.image?.url ?? ""}
          alt={author?.image?.alt ?? ""}
          width={author?.image?.width}
          height={author?.image?.height}
          className={styles.profileImage}
           initial={{opacity: 0, x: 20 }} 
           animate={{opacity: 1, x: 0, transition: {delay: 0.3}}} 
           exit={{opacity: 0, x: 20}} 
           shouldHideImageOnFail={true}
        />
        <div className={styles.introText}>
            <h1>Who Am I?</h1>
          <h2>
            {author?.firstName} {author?.lastName}
          </h2>
          <h2>{author?.jobTitle}</h2>
          <h2>{author?.location}</h2>
          <ClickableLink
            link={author?.email ?? "contact@cjoshmartin.com"}
            type={LinkType.email}
          />
          {author?.github && <ClickableLink link={author?.github} />}
          <div>{props.bio}</div>
        </div>
      </div>
  );
}
