'use client'

import { motion } from "framer-motion"

export default function AnimationContainer(props: any){

    return (
        <motion.div
           initial={{opacity: 0, y: 20}} 
           animate={{opacity: 1, y: 0}} 
           exit={{opacity: 0, y: 20}} 
        >
            {props.children}
        </motion.div>
    )
}
