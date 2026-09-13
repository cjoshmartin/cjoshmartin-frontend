"use client";

import { ProjectType } from "../components/PortfolioPreview/ProjectType";
import styles from "./projects.module.css";
import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";

const MotionLink = motion(Link);

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
      <Button
        variant={!searchParams?.project_type ? "default" : "outline"}
        nativeButton={false}
        render={
          <MotionLink
            href={{
              pathname: "/projects",
              query: { ...searchParams, project_type: undefined },
            }}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
          />
        }
      >
        All (
        {projectTypeCounts[ProjectType.Client] +
          projectTypeCounts[ProjectType.Personal]}
        ) Projects
      </Button>

      <Button
        variant={
          searchParams?.project_type === ProjectType.Client ? "default" : "outline"
        }
        nativeButton={false}
        render={
          <MotionLink
            href={{
              pathname: "/projects",
              query: { ...searchParams, project_type: ProjectType.Client },
            }}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
          />
        }
      >
        Client ({projectTypeCounts[ProjectType.Client]}) Projects
      </Button>

      <Button
        variant={
          searchParams?.project_type === ProjectType.Personal ? "default" : "outline"
        }
        nativeButton={false}
        render={
          <MotionLink
            href={{
              pathname: "/projects",
              query: { ...searchParams, project_type: ProjectType.Personal },
            }}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
          />
        }
      >
        Personal ({projectTypeCounts[ProjectType.Personal]}) Projects
      </Button>
    </div>
  );
}
