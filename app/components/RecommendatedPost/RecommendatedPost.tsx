import { RecommendatedPostItem } from "./RecommendatedPostItem";
import styles from "./RecommendatedPost.module.css";
import { RecommendatedPostContainer } from "./RecommendatedPostContainer";
import { getPages } from "../api/pages";
import { PageTypes } from "@/app/PageTypes";

async function getPosts(type: PageTypes){
    const getDate = ({meta}: any) => new Date(meta.first_published_at).getTime();
    const sortingFuncForDate = (a: any ,b: any) => getDate(b) - getDate(a);

    return getPages()
    .then((data) => data
    .filter(({meta}: any) =>  meta.type === type)
    .sort(sortingFuncForDate)
    )
    

}

interface RecommendatedPostProps {
  slug: string;
  type?: PageTypes;
  tags?: string[];
  
}

export default async function RecommendatedPost({slug, type = PageTypes.BLOG_POST, tags}: RecommendatedPostProps) {
  const blogPosts = await getPosts(type);

  // TODO: Find the tag with the most posts that is related to the slug
  // not only search blog post but search projects and clients as well

  return (
    <div className={styles.container}>
      <RecommendatedPostContainer>
        {blogPosts.filter((post: any) => 
        post.meta.slug !== slug).slice(0, 3).map((post: any) => (
          <RecommendatedPostItem key={post.id} post={post} />
        ))}
      </RecommendatedPostContainer>
    </div>
  );
}