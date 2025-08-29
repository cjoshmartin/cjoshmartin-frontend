import { RecommendatedPostItem } from "./RecommendatedPostItem";
import styles from "./RecommendatedPost.module.css";
import { RecommendatedPostContainer } from "./RecommendatedPostContainer";
import { getPages } from "../api/pages";
import { PageTypes } from "@/app/PageTypes";

async function getBlogPosts(){
    const getDate = ({meta}: any) => new Date(meta.first_published_at).getTime();
    const sortingFuncForDate = (a: any ,b: any) => getDate(b) - getDate(a);

    return getPages()
    .then((data) => data
    .filter(({meta}: any) =>  meta.type === PageTypes.BLOG_POST)
    .sort(sortingFuncForDate)
    )
    

}

export default async function RecommendatedPost({slug}: {slug: string}) {
  const blogPosts = await getBlogPosts();

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