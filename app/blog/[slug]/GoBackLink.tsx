'use client'

import { motion } from "framer-motion";

export function GoBackLink({ href }: any) {

  return (
    <motion.a
      href={href}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.9 }}
    >
      <u>{"<<< Go back"}</u>
    </motion.a>
  );
}
