import { RecommendatedPostItem } from "./RecommendatedPostItem";
import styles from "./RecommendatedPost.module.css";
import { RecommendatedPostContainer } from "./RecommendatedPostContainer";
import { sanityFetch } from "@/sanity/lib/live";
import { RECOMMENDED_POSTS_QUERY } from "@/sanity/lib/queries";

/** The 3 newest listed blog posts other than the current one. */
async function getPosts(slug: string){
    const { data } = await sanityFetch({
      query: RECOMMENDED_POSTS_QUERY,
      params: { slug },
    })
    return data
}

interface RecommendatedPostProps {
  slug: string;
}

export default async function RecommendatedPost({slug}: RecommendatedPostProps) {
  const blogPosts = await getPosts(slug);

  // TODO: Find the tag with the most posts that is related to the slug
  // not only search blog post but search projects and clients as well

  return (
    <div className={styles.container}>
      <RecommendatedPostContainer>
        {blogPosts.map((post) => (
          <RecommendatedPostItem key={post._id} post={post} />
        ))}
      </RecommendatedPostContainer>
    </div>
  );
}
