"use client";

import { ProjectType } from "../components/PortfolioPreview/ProjectType";
import styles from "./projects.module.css";
import Link from "next/link";
import { motion } from "framer-motion";

/*
  three query parameters:
  1) type of clients
    * all
    * profrontal
    * personal
  2) Medium
    can all select one medium at a time
  3) Techologies
    can all select one techologies at a time
*/

export function ProjectTypeButtons({ searchParams, projectTypeCounts }: any) {
  return (
    <div className={styles.buttonGroup}>
      <motion.span
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.9 }}
        style={{
          padding: "1rem 0",
        }}
      >
        <Link
          href={{
            pathname: "/projects",
            query: { ...searchParams, project_type: undefined },
          }}
        >
          All (
          {projectTypeCounts[ProjectType.Client] +
            projectTypeCounts[ProjectType.Personal]}
          ) Projects
        </Link>
      </motion.span>
      <motion.span
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.9 }}
        style={{
          padding: "1rem 0",
        }}
      >
        <Link
          href={{
            pathname: "/projects",
            query: { ...searchParams, project_type: ProjectType.Client },
          }}
        >
          Client ({projectTypeCounts[ProjectType.Client]}) Projects
        </Link>
      </motion.span>
      <motion.span
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.9 }}
        style={{
          padding: "1rem 0",
        }}
      >
        <Link
          href={{
            pathname: "/projects",
            query: { ...searchParams, project_type: ProjectType.Personal },
          }}
        >
          Personal ({projectTypeCounts[ProjectType.Personal]}) Projects
        </Link>
      </motion.span>
    </div>
  );
}
