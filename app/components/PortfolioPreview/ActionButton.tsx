'use client'
import { motion } from "framer-motion";
import Link from "next/link";

export default function ActionButton({className, href, children}: any){

    return (
      <div
        style={{
          padding: "1rem",
          width: "100%",
          display: "flex",
        }}
      >
        <motion.span whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.9 }}>
          <Link className={className} href={href}>
            {children}
          </Link>
        </motion.span>
      </div>
    );
}