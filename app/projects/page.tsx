import styles from './projects.module.css'

import ShowImage from "../blog/_compoents/ShowImage";

import bad_idea from '@/public/projects_list_items/bad_ideas.png'
import miata_key from '@/public/personal_projects/miata_key.jpg'
import Link from 'next/link';

enum ProjectType {
    PERSONAL,
    CLIENT 
}

interface ProjectListingItemProps {
    type: ProjectType
    headerImage?: string
}


function generateClassList(classes: string[]){
    return classes.join(" ")
}

function ProjectListingItem({ type, headerImage }: ProjectListingItemProps) {

    return (
        <div
          className={generateClassList([
            styles.projectContainer,
            type === ProjectType.PERSONAL
              ? styles.personalProjectContainer
              : "",
          ])}
        >
          <ShowImage width={480} height={320} url={headerImage} />
          <div>
            <div className={styles.projectInfo}>
              <h2>Bad Ideas (Online Card Game)</h2>
              <h3 style={{ fontWeight: "400" }}>Client: Design Concentric</h3>
              <h4>Media: Web</h4>
              <h5>
                Technologies: Next.js(React.js), Framer Motion, Sanity CMS
              </h5>
            </div>
            <div>
              <p>
                Deploying to Google Cloud Platform (GCP) on Github actions has
                not been a straight forward process. The blog posts online are
                incomplete and hard to follow. So, hopefully I can help a little
                bit with what I found to make it easy to deploy this...
              </p>
              <Link href='/projects/fake-project'
                style={{ color: 'black', padding: '1rem' }}
              >Read More...</Link>
            </div>
          </div>
        </div>
    );
}

export default function Page() {

    return (
      <div className={styles.container}>
        <h1>(All) Project Page</h1>
        <div className={styles.buttonGroup}>
          <button>All (10) Projects</button>
          <button>Client (6) Projects</button>
          <button>Personal (4) Projects</button>
        </div>
        {/* <input
          type="text"
          className={styles.searchBox}
          autoComplete="search"
          placeholder="search projects"
        /> */}
        <div className={styles.mediaContainer}>
          <h3>Media:</h3>
            <div className={styles.mediaLinkContainer}>
               <a href='#'>Web(5)</a>
               <a href='#'>IoT(2)</a>
               <a href='#'>Mobile(3)</a>
               <a href='#'>3D Printing(2)</a>
               <a href='#'>CAD(1)</a>
               <a href='#'>Circuit Board Design(1)</a>
            </div>
        </div>
        <div className={styles.mediaContainer}>
            <h3>Technologies: </h3>
            <div className={styles.techLinkContainer}>
               <a href='#'>ReactJS(5)</a>
               <a href='#'>Framer Motion(2)</a>
               <a href='#'>Sanity CMS(3)</a>
               <a href='#'>Arduino(2)</a>
               <a href='#'>Redux(1)</a>
               <a href='#'>UI Kitten(1)</a>
            </div>
        </div>
        <div className={styles.listItems}>
          <ProjectListingItem type={ProjectType.CLIENT}  headerImage={bad_idea.src}/>
          <ProjectListingItem type={ProjectType.PERSONAL} headerImage={miata_key.src}/>
        </div>
      </div>
    );
}