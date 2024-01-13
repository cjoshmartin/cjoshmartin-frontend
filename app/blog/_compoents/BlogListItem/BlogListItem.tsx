import Image from 'next/image'

import styles from './blogListItem.module.css'
import Link from 'next/link';
import moment from 'moment';

function ShowImage({url, alt, width, height}: any){

    if(url){
        return <Image src={url} alt={alt} width={width} height={height}/>;
    }

    return (
        <Image
            src={
                "https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?ixlib=rb-1.2.1&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1170&q=80"
            }
            alt="Default image for blog post when there is not an image to show"
            width={width}
            height={height}
        />
    )
}

export default function BlogListItem({slug, title, publishDate, intro}: any){
    return (
        <div className={styles.blogListContainer}>
        <ShowImage width={480} height={320}/> 
        <div className={styles.contantContainer}>
            <h2>{title}</h2>
            <small>{moment(publishDate).format("MMMM DD, YYYY")}</small>
            <p>{intro}</p>

            <Link href={`/blog/${slug}`}>Read More</Link>
        </div>

        </div>
    );
}