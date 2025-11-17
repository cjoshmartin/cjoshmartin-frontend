'use client';

import { motion } from "framer-motion";
import styles from './styles.module.css'



export default function CTASection() {
    return (
     <div
     className={styles.container}
     >
      <h2>Read Enough? Ready to Start a Project!</h2>
        <motion.a
          style={{
              textDecoration: 'none',
              textTransform: 'capitalize',
              backgroundColor: 'var(--primary-color)',
              color: 'black',
              padding: '1rem',
              fontSize: '1.2rem',
              fontWeight: 700,
              borderRadius: '5%'
          }}
          href="/start-a-project"
          whileHover={{ scale: 1.1, color:'black'}}
          whileTap={{ scale: 0.9 }}
        >
            Click here to get started
        </motion.a>
     </div>
    )
}