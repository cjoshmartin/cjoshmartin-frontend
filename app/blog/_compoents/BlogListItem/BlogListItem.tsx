
import styles from './blogListItem.module.css'
import Link from 'next/link';
import moment from 'moment';
import ShowImage from '../ShowImage/ShowImage';
import { CalculateReadTime } from '@/app/components/CalculateReadTime/CalculateReadTime';
import { buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';
import { stegaClean, type StegaBranded } from '@sanity/client/stega';
import { readingMinutes } from '@/lib/portableText';
import { hasAsset, imageUrl } from '@/sanity/lib/image';
import type { BLOG_LIST_QUERY_RESULT } from '@/sanity.types';

/** Widest rendition of a post's list image (shown at most 480px wide). */
const POST_IMAGE_WIDTH = 960

type BlogListPost = StegaBranded<BLOG_LIST_QUERY_RESULT>[number]

export default function BlogListItem({post}: {post: BlogListPost}){
    const {slug, title, date: publishDate, intro, heroImage} = post

    return (
      <Link
        href={`/blog/${slug}`}
        className={styles.blogListContainer}>
        <ShowImage width={480} height={320} url={hasAsset(heroImage) ? imageUrl(heroImage, POST_IMAGE_WIDTH) : undefined} />
        <div className={styles.contantContainer}>
          <div>
            <h2>{title}</h2>
            <div className={styles.readTime}>
              <CalculateReadTime minutes={readingMinutes({ text: post.readingText, codeTexts: post.codeTexts })} fullText={false} />
              <small>{moment(stegaClean(publishDate) ?? undefined).format("MMMM DD, YYYY")}</small>
            </div>
            <p>{intro}</p>
          </div>

          {/* A styled span, not a Button/Link, because the whole card above
              is already an <a> and <a> cannot contain another interactive
              element such as a nested <a> or <button>. */}
          <span className={cn(buttonVariants({ variant: "secondary" }), "bg-white text-black hover:bg-white/90")}>
            Read More
          </span>
        </div>
      </Link>
    );
}
