'use client'

import { PageTypes } from "@/app/PageTypes";
import { ProjectType } from "@/app/components/PortfolioPreview/ProjectType";
import { useEffect, useState } from "react"
import styles from './ProjectShower.module.css'
import Testimonial from "@/app/components/Testimonial";
import ShowImage from "@/app/blog/_compoents/ShowImage";

import TestImage from '@/public/personal_projects/gun.gif';
import TestImage1 from '@/public/personal_projects/hat.gif';
import TestImage2 from '@/public/preview/bad_ideas.png';

const images = [TestImage, TestImage1, TestImage2]

import { motion } from "framer-motion";
import { FromAPI } from "@/app/components/Testimonial/Testimonial";

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
    testimonials?: FromAPI[],
}

interface ProjectShowerProps {
    projects: Project[]
}

export default function ProjectShower(props: ProjectShowerProps) {
    const [currentProject, setCurrentProject] = useState<Project | undefined>(props.projects[0]);
    const [currentIndex, setCurrentIndex] = useState<number>(0);
    const [image, setImage] = useState<typeof TestImage>();
    useEffect(() => { 
        setTimeout(() => {
            console.log("Changing State: ", currentProject?.title)
            setCurrentProject(props.projects[currentIndex])
            setImage(images[currentIndex % images.length])
            const nextIndex = (currentIndex + 1) % props.projects.length;
            setCurrentIndex(nextIndex);
        }, 15000)
    }, [currentIndex, currentProject?.title, props.projects ])

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
            <h5>Technologies: {currentProject?.technologies.join(", ")}</h5>
            <h4>Medium: {currentProject?.medium?.join(', and ')}</h4>
        </div>

      <ShowImage 
        url={currentProject?.preview_image?.url}
        className={styles.placeHolderImage}
        alt={currentProject?.title}
        width={150}
        height={150}
      />
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