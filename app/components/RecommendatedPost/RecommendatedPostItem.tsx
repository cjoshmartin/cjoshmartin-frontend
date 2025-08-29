import ShowImage from "@/app/blog/_compoents/ShowImage/ShowImage";
import styles from "./RecommendatedPostItem.module.css";

export function RecommendatedPostItem({post}: {post: any}) {
  return (
    <a href={`/blog/${post.meta.slug}`} className={styles.container}>
      <ShowImage
        width={480}
        height={320}
        url={post.content_visuals[0]?.value?.url}
        className={styles.image}
      />
      <div className={styles.content}>
        <h3>{post.title}</h3>
        <p>{post.intro.trim()}</p>
      </div>
    </a>
  );
}