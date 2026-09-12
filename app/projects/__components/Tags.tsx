'use client';
import { motion } from 'framer-motion';
import styles from '../projects.module.css';

import Link from 'next/link';
import { generateClassList } from './generateClassList';

const MotionLink = motion.create(Link);

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
      <div
        className={generateClassList(["tag-links", styles.mediaLinkContainer])}
      >
          <MotionLink
            whileHover={{
              scale: 1.1,
            }}
            href={{
              pathname: "/projects",
              query: removeKey(searchParams, searchKey),
            }}
            className={generateClassList([
              !searchParams[searchKey] ? styles.activeTagLink : "",
              "tag-links",
            ])}
          >
            All
          </MotionLink>
        {sortedTags.map((key) => (
            <MotionLink
              key={key}
              whileHover={{
                scale: 1.1,
              }}
              style={{
                padding: "0.5rem",
              }}
              href={{
                pathname: "/projects",
                query: { ...searchParams, [searchKey]: key },
              }}
              className={generateClassList([
                searchParams[searchKey] === key ? styles.activeTagLink : "",
                "tag-links",
              ])}
            >
              {key}({tags[key]})
            </MotionLink>
        ))}
      </div>
    </div>
  );
}
