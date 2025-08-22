
import styles from './blogListItem.module.css'
import Link from 'next/link';
import moment from 'moment';
import ShowImage from '../ShowImage';
import { CalculateReadTime } from '@/app/components/CalculateReadTime/CalculateReadTime';

export default function BlogListItem(props: any){
    const {slug, title, publishDate, intro, content_visuals, body} = props
    const  {type, value} = content_visuals.length > 0 ? content_visuals[0] : {type: "", value: undefined};
    
    return (
      //@ts-ignore
      <div className={styles.blogListContainer}>
        <ShowImage width={480} height={320} url={value?.url} />
        <div className={styles.contantContainer}>
          <h2>{title}</h2>
          <div className={styles.readTime}>
            <CalculateReadTime body={body} fullText={false} />
            <small>{moment(publishDate).format("MMMM DD, YYYY")}</small>
          </div>
          <p>{intro}</p>

          <Link href={`/blog/${slug}`}>Read More</Link>
        </div>
      </div>
    );
}