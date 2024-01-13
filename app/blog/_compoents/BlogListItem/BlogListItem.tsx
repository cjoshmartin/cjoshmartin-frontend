
import styles from './blogListItem.module.css'
import Link from 'next/link';
import moment from 'moment';
import ShowImage from '../ShowImage';

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