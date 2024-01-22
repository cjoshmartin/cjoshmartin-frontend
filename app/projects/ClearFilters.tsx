'use client';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import styles from './projects.module.css';
import { faCircleXmark } from '@fortawesome/free-solid-svg-icons';
import { motion } from 'framer-motion';

export default function ClearFilters({ searchParams }: any) {
  if (!!searchParams && Object.keys(searchParams).length > 0) {
    return (
      <motion.a
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
        whileHover={{ scale: 1.02 }}
        href="/projects"
        className={styles.clearFiltersLink}
      >
        <FontAwesomeIcon
          icon={faCircleXmark}
          className={styles.clearFiltersIcon}
        />
        Clear Filters
      </motion.a>
    );
  }

  return null;
}
