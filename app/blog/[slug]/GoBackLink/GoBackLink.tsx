'use client'

import { motion } from "framer-motion";
import styles from './GoBackLink.module.css'

export function GoBackLink({ href }: any) {

  return (
    <div 
    className={styles.container} 
    >
    <motion.a
      href={href}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.9 }}
      style={{
        paddingTop: '0.7rem',
      }}

    >
      <u>{"<<< Go back"}</u>
    </motion.a>
</div>
  );
}
