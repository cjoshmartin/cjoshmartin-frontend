'use client'

import { useEffect, useState } from "react"
import styles from './ProjectShower.module.css'
import Testimonial, { type TestimonialView } from "@/app/components/Testimonial";
import ShowImage from "@/app/blog/_compoents/ShowImage/ShowImage";

import { motion } from "framer-motion";

/** A project on /screen, prepared on the server. */
export interface Project {
    key: string,
    title: string,
    /** The title without stega characters, for the image's alt attribute. */
    imageAlt: string,
    previewImageUrl?: string,
    medium: string[],
    technologies: string[],
    /** The project's first testimonial. */
    testimonial?: TestimonialView,
}

interface ProjectShowerProps {
    projects: Project[]
}

export default function ProjectShower(props: ProjectShowerProps) {
    const [currentIndex, setCurrentIndex] = useState<number>(0);
    const [currentProject, setCurrentProject] = useState<Project | undefined>(props.projects[3]);
    const [progress, setProgress] = useState<number>(0);
    
    const setTime = 15000;

    useEffect(() => { 
       const timeoutId = setTimeout(() => {
            console.log("Changing State: ", currentProject?.title)
            let nextIndex = Math.floor(Math.random() * props.projects.length);
            while (nextIndex == currentIndex){
              console.log("same index")
              nextIndex = Math.floor(Math.random() * props.projects.length)
            }
            setCurrentIndex(nextIndex);
            setCurrentProject(props.projects[currentIndex])
            setProgress(0);
        },setTime)
    return () => {
      clearTimeout(timeoutId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentProject?.title, props.projects ])

    useEffect(() =>{
      const increaseAmount = (setTime /50) + 100;
      const timeoutId = setTimeout(() =>{
        const nextProgress = progress + increaseAmount
        if (nextProgress < (setTime + 1)){
          setProgress(nextProgress);
        }
      }, increaseAmount)

      return () => {
        clearTimeout(timeoutId)
      }
    }, [progress])

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
        url={currentProject?.previewImageUrl}
        className={styles.placeHolderImage}
        alt={currentProject?.imageAlt}
        width={150}
        height={150}
      />
        {currentProject?.testimonial && (
            <Testimonial
              testimonial={currentProject.testimonial}
              shouldHideImage={true}
            />
          )}
        <motion.div style={{
          width: '100%',
          height: '20px',
          border: '1px soild black'
        }}>
          <motion.div 
          initial={{opacity: 0, y: 40, width: 0}}
          animate={{opacity: 1, y: 0, width: `${(progress/setTime) * 100}%`
          }}
          style={{backgroundColor: 'var(--primary-color)', height: '20px' }} />
        </motion.div>
      </motion.div>
    );
}