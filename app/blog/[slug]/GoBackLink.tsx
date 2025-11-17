'use client'

import { motion } from "framer-motion";

export function GoBackLink({ href }: any) {

  return (
    <div
      style={{
        position: 'sticky',
        top: '0',
        zIndex: 4,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: '2rem',
        paddingLeft: '2rem',
        // height: '90px',
      }}
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
