import { stegaClean, type StegaBranded } from '@sanity/client/stega';
import ShowImage from '@/app/blog/_compoents/ShowImage/ShowImage';
import PortableTextBody from '@/app/components/PortableTextBody/PortableTextBody';
import { hasAsset, imageUrl } from '@/sanity/lib/image';
import type { BLOG_POST_QUERY_RESULT } from '@/sanity.types';
import styles from './styles.module.css'

/** Widest rendition of the author photo (shown at 400px). */
const AUTHOR_IMAGE_WIDTH = 800

export type AuthorData = NonNullable<StegaBranded<NonNullable<BLOG_POST_QUERY_RESULT>>['author']>

export function AuthorInfo({ author }: { author: AuthorData }) {
  const { bio, firstName, lastName, jobTitle, location, image } = author;
  const email = stegaClean(author.email);

  return (
    <div className={styles.container}>
      <ShowImage
        url={hasAsset(image) ? imageUrl(image, AUTHOR_IMAGE_WIDTH) : undefined}
        alt={stegaClean(image?.alt) ?? undefined}
        width={400}
        className={styles.authorImage}
      />
      <div className={styles.jobInfo}>
        <h2>
          {firstName} {lastName}
        </h2>
        <h3>{jobTitle}</h3>
        <h4>
          <a
            href={`mailto:${email}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "black" }}
          >
            {email}
          </a>
        </h4>
        <h4>{location}</h4>
        <div>
          <PortableTextBody value={bio} />
        </div>
      </div>
    </div>
  );
}
