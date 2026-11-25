import ShowImage from "@/app/blog/_compoents/ShowImage/ShowImage";
import styles from "./RecommendatedPostItem.module.css";
import { CalculateReadTime } from "../CalculateReadTime/CalculateReadTime";
import { readingMinutes } from "@/lib/portableText";
import { hasAsset, imageUrl } from "@/sanity/lib/image";
import type { RECOMMENDED_POSTS_QUERY_RESULT } from "@/sanity.types";
import type { StegaBranded } from "@sanity/client/stega";

/** Widest rendition of a recommended post's image (shown at most 480px wide). */
const POST_IMAGE_WIDTH = 960

type RecommendedPost = StegaBranded<RECOMMENDED_POSTS_QUERY_RESULT>[number]

export function RecommendatedPostItem({post}: {post: RecommendedPost}) {
  return (
    <a href={`/blog/${post.slug}`} className={styles.container}>
      <ShowImage
        width={480}
        height={320}
        url={hasAsset(post.heroImage) ? imageUrl(post.heroImage, POST_IMAGE_WIDTH) : undefined}
        className={styles.image}
        wrapperClassName={styles.imageWrapper}
      />
      <div className={styles.content}>
        <h3>{post.title}</h3>
        <CalculateReadTime minutes={readingMinutes({ text: post.readingText, codeTexts: post.codeTexts })} />
        <div className={styles.introWrapper}>
          <p>{(post.intro ?? "").trim()}</p>
        </div>
      </div>
    </a>
  );
}
