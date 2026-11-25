import { Metadata } from "next";
import BlogListItem from "./_compoents/BlogListItem";
import styles from './blog.module.css'
import { sanityFetch } from "@/sanity/lib/live";
import { BLOG_LIST_QUERY } from "@/sanity/lib/queries";

/** Every listed (not unlisted) blog post, newest first. */
async function getBlogPosts(){
    const { data } = await sanityFetch({ query: BLOG_LIST_QUERY })
    return data
}



export const metadata: Metadata = {
  title: 'Blog - Josh Martin\'s Website',
}

export default async function Blog(){
    const blogPosts = await getBlogPosts();

    return (
      <div className={styles.container}>
        <h1>
          <span className="bg-black">
            Blog
          </span>
        </h1>
        {blogPosts.map((post) => (
          <BlogListItem
            key={post._id}
            post={post}
          />
        ))}
      </div>
    );
}
