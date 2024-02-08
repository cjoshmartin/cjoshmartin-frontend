'use client'

import { PageTypes } from "@/app/PageTypes";
import { ProjectType } from "@/app/components/PortfolioPreview/ProjectType";
import { useEffect, useState } from "react"
import styles from './ProjectShower.module.css'
import Testimonial from "@/app/components/Testimonial";
import { motion } from "framer-motion";

interface Meta {
    type: PageTypes,
    slug: string,
    seo_title: string,
    first_published_at: string,
    parent: any,
}

interface ImageShape {
    url: string,
    title: string,
    width: number,
    height: number
}

export interface Project {
    meta: Meta,
    title: string,
    body?: any[],
    date: string, 
    intro: string, 
    content_image?: ImageShape,
    preview_image?: ImageShape,
    project_type: ProjectType
    client: string,
    medium: string[],
    technologies: string[],
    testimonials?: object[],
}

interface ProjectShowerProps {
    projects: Project[]
}

export default function ProjectShower(props: ProjectShowerProps) {
    const [currentProject, setCurrentProject] = useState<Project | undefined>();
    const [currentIndex, setCurrentIndex] = useState<number>(0);
    useEffect(() => { 
        setTimeout(() => {
            console.log("Changing State: ", currentProject?.title)
            setCurrentProject(props.projects[currentIndex])
            const nextIndex = (currentIndex + 1) % props.projects.length;
            setCurrentIndex(nextIndex);
        }, 5000)

    }, [currentIndex, currentProject?.title, props.projects])

    if (!currentProject){
        return (
            <div>
                <h1>Oh no, something is wrong...</h1>
            </div>
        )
    }

    return (
      <motion.div 
        initial={{opacity: 0, y: 40}} 
        animate={{opacity: 1, y: 0}} 
      key={currentProject.title} className={styles.container}>
        <div className={styles.projectInfo}>
            <h2>{currentProject?.title}</h2>
            {/* {currentProject?.client && <h3 style={{ fontWeight: "400" }}>Client: {currentProject?.client}</h3>} */}
            <h4>Medium: {currentProject?.medium?.join(', and ')}</h4>
            <h5>Technologies: {currentProject?.technologies.join(", ")}</h5>
        </div>
        <div className={styles.placeHolderImage}>
          <h2 className={styles.placeHolderText} >
            Preview Image
          </h2>
        </div> 
        {currentProject?.testimonials &&
          currentProject?.testimonials.length > 0 && (
            <Testimonial
              testimonial={currentProject?.testimonials[0]?.testimonial}
              shouldHideImage={true}
            />
          )}
      </motion.div>
    );
}