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
  const searchKey = title.toLowerCase();

  return (
    <div className={styles.mediaContainer}>
      <h3>{title}:</h3>
      <div className={styles.mediaLinkContainer}>
        <Link
          href={{
            pathname: "/projects",
            query: removeKey(searchParams, searchKey),
          }}
          className={
            !searchParams[searchKey] ? styles.activeTagLink : undefined
          }
        >
          All
        </Link>
        {sortedTags.map((key) => (
          <Link
            href={{
              pathname: "/projects",
              query: { ...searchParams, [searchKey]: key },
            }}
            key={key}

          className={
            searchParams[searchKey] === key ? styles.activeTagLink : undefined
          }
          >
            {key}({tags[key]})
          </Link>
        ))}
      </div>
    </div>
  );
}
