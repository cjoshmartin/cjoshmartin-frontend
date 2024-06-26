import { Metadata } from "next";
import { PageTypes } from "../PageTypes";
import BlogListItem from "./_compoents/BlogListItem";
import styles from './blog.module.css'
import { getPages } from "../components/api/pages";

async function getBlogPosts(){
    const getDate = ({meta}: any) => new Date(meta.first_published_at).getTime();
    const sortingFuncForDate = (a: any ,b: any) => getDate(b) - getDate(a);

    return getPages()
    .then((data) => data
    .filter(({meta}: any) =>  meta.type === PageTypes.BLOG_POST)
    .sort(sortingFuncForDate)
    )
    

}



export const metadata: Metadata = {
  title: 'Blog - Josh Martin\'s Website',
}

export default async function Blog(){
    const blogPosts = await getBlogPosts();

    return (
      <div className={styles.container}>
        <h1>Blog</h1>
        {blogPosts.map(({ id, meta, date, title, intro, content_visuals}: any) => (
          <BlogListItem
            key={id}
            title={title}
            slug={meta.slug}
            publishDate={date}
            intro={intro}
            content_visuals={content_visuals}
          />
        ))}
      </div>
    );
}