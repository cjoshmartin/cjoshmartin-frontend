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
      <Link
        href={{
          pathname: "/projects",
          query: { ...searchParams, project_type: undefined },
        }}
        className={!searchParams?.project_type ? styles.activeLink : undefined}
      >
        <motion.span
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.9 }}
          style={{
            padding: "1rem 0",
          }}
        >
          All (
          {projectTypeCounts[ProjectType.Client] +
            projectTypeCounts[ProjectType.Personal]}
          ) Projects
        </motion.span>
      </Link>

      <Link
        href={{
          pathname: "/projects",
          query: { ...searchParams, project_type: ProjectType.Client },
        }}
        className={
          searchParams?.project_type === ProjectType.Client
            ? styles.activeLink
            : undefined
        }
      >
        <motion.span
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.9 }}
          style={{
            padding: "1rem 0",
          }}
        >
          Client ({projectTypeCounts[ProjectType.Client]}) Projects
        </motion.span>
      </Link>

      <Link
        href={{
          pathname: "/projects",
          query: { ...searchParams, project_type: ProjectType.Personal },
        }}
        className={
          searchParams?.project_type === ProjectType.Personal
            ? styles.activeLink
            : undefined
        }
      >
        <motion.span
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.9 }}
          style={{
            padding: "1rem 0",
          }}
        >
          Personal ({projectTypeCounts[ProjectType.Personal]}) Projects
        </motion.span>
      </Link>
    </div>
  );
}
