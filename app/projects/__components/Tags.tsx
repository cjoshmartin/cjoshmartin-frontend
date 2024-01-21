'use client';
import styles from '../projects.module.css';

import Link from 'next/link';

function removeKey(params: object, key: string){
  const query = {...params};
  // @ts-ignore
  delete query[key];
  return query
}

export default function Tags({ title, tags, searchParams }: any) {
  const sortedTags = Object.keys(tags)
    .sort((a: string, b: string) => {

      return tags[b] - tags[a];
    });

  sortedTags.length = Math.min(sortedTags.length, 10);
  return (
    <div className={styles.mediaContainer}>
      <h3>{title}:</h3>
      <div className={styles.mediaLinkContainer}>
        <Link
          href={{
            pathname: "/projects",
            query: removeKey(searchParams, title.toLowerCase()),
          }}
        >
         All 
        </Link>
        {sortedTags.map((key) => (
          <Link
            href={{
              pathname: "/projects",
              query: { ...searchParams, [title.toLowerCase()]: key },
            }}
            key={key}
          >
            {key}({tags[key]})
          </Link>
        ))}
      </div>
    </div>
  );
}
