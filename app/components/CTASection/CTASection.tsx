'use client';

import { motion } from "framer-motion";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import styles from './styles.module.css'

const MotionLink = motion(Link);

export default function CTASection() {
    return (
     <div
     className={styles.container}
     >
      <h2>Read Enough? Ready to Start a Project!</h2>
        <Button
          size="lg"
          className="text-lg capitalize"
          nativeButton={false}
          render={
            <MotionLink
              href="/start-a-project"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
            />
          }
        >
          Click here to get started
        </Button>
     </div>
    )
}