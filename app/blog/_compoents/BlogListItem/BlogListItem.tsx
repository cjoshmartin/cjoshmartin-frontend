
import styles from './blogListItem.module.css'
import Link from 'next/link';
import moment from 'moment';
import ShowImage from '../ShowImage/ShowImage';
import { CalculateReadTime } from '@/app/components/CalculateReadTime/CalculateReadTime';
import { buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';

export default function BlogListItem(props: any){
    const {slug, title, publishDate, intro, content_visuals, body} = props
    const  {type, value} = content_visuals.length > 0 ? content_visuals[0] : {type: "", value: undefined};

    return (
      //@ts-ignore
      <Link
        href={`/blog/${slug}`}
        className={styles.blogListContainer}>
        <ShowImage width={480} height={320} url={value?.url} />
        <div className={styles.contantContainer}>
          <div>
            <h2>{title}</h2>
            <div className={styles.readTime}>
              <CalculateReadTime body={body} fullText={false} />
              <small>{moment(publishDate).format("MMMM DD, YYYY")}</small>
            </div>
            <p>{intro}</p>
          </div>

          {/* A styled span, not a Button/Link, because the whole card above
              is already an <a> and <a> cannot contain another interactive
              element such as a nested <a> or <button>. */}
          <span className={cn(buttonVariants({ variant: "secondary" }), "bg-white text-black hover:bg-white/90")}>
            Read More
          </span>
        </div>
      </Link>
    );
}
