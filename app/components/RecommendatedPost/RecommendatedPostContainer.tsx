"use client"    

import styles from "./RecommendatedPostContainer.module.css";

export function RecommendatedPostContainer({children}: {children: React.ReactNode}) { 

    return (
      <div className={`main ${styles.container}`} >
        {children}
      </div>
    );
}