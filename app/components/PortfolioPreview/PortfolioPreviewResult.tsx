'use client'

import { FocusModes, useFocusState } from "../Context/FocusStateContext";
import { ProjectItem } from "./ProjectItem";
import ActionButton from "./ActionButton";
import styles from './PortfolioPreview.module.css'

import { AnimatePresence, motion } from "framer-motion";

export function PortfolioPreviewResult({projects}: {projects: any[]}){
  const { focusMode } = useFocusState();
  if (projects.length < 1) {
    return null;
  }

  const showProjects = focusMode === FocusModes.Developer;

  return (
    <AnimatePresence initial={false}>
      {showProjects && (
        <motion.div
          className={styles.container}
          key="projects"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
        >
          <div>
            <h2 style={{ paddingLeft: "1rem" }}> Recent (Client) Projects</h2>
            {/* <p>
            These are the projects I have found to pay my bills so far and you
            can look at the kind of work I can help you with in the future
          </p> */}
          </div>
          <br />
          <div className={styles.profileContainer}>
            {projects
              .filter((project: any) => !project.is_unlisted)
              .slice(0, 3)
              .map((project: any, i: number) => (
                <ProjectItem
                  key={project.title}
                  previewImage={project?.preview_image?.url}
                  projectName={project.title}
                  client={project.client}
                  media={project.medium}
                  technologies={project.technologies}
                  slug={project.meta.slug}
                  website={project.website}
                  body={project.body}
                />
              ))}
          </div>
          <ActionButton
            className={styles.readMoreClient}
            href="/projects?project_type=CLI"
          >
            See More (Client) Projects
          </ActionButton>
        </motion.div>
      )}
    </AnimatePresence>
  );
}