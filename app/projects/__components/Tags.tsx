'use client';
import { motion } from 'framer-motion';
import styles from '../projects.module.css';

import Link from 'next/link';
import { generateClassList } from './generateClassList';

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
        <motion.span
          whileHover={{
            scale: 1.1,
            backgroundColor: "#85ffa7",
            color: "black",
            padding: "0.5rem",
          }}
        >
          <Link
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
          </Link>
        </motion.span>
        {sortedTags.map((key) => (
          <motion.span
            key={key}
            whileHover={{
              scale: 1.1,
              backgroundColor: "#85ffa7",
              color: "black",
              padding: "0.5rem",
            }}
          >
            <Link
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
            </Link>
          </motion.span>
        ))}
      </div>
    </div>
  );
}
