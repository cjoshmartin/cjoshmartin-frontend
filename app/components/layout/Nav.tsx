'use client';

import styles from './layout.module.css';
import { usePathname } from 'next/navigation';
import { generateClassList } from '@/app/projects/__components/generateClassList';
import { motion } from 'framer-motion';
import { FocusToggle } from '../FocusToggle/FocusToggle';
import { ProjectNavLink } from './ProjectNavLink';
interface NavLinkProps {
    title: string,
    link: string,
    external?: boolean
    isActive?: boolean
}

export function NavLink({title, link, external=false, isActive}: NavLinkProps ){
    return (
      <motion.span 
      whileHover={{ scale: 1.1, backgroundColor: '#85ffa7', color:'black', padding:'0.5rem' }}
      style={{
        cursor: 'pointer',
      }}
      >
        <a
          href={link}
          target={external ? "_blank" : undefined}
          className={generateClassList([
            "nav-link",
            isActive ? styles.activeLink : "",
          ])}
        >
          {isActive ? title : `[${title}]`}
        </a>
      </motion.span>
    );
}

function CTALink({title, link, external=false, isActive}: NavLinkProps ) {
    return (
      <motion.span 
      whileHover={{ scale: 1.1, color:'black', padding:'0.5rem' }}
      whileTap={{ scale: 0.9 }}
      style={{
        cursor: 'pointer',
        padding: '0.5rem'
      }}
      >
        <a
          href={link}
          target={external ? "_blank" : undefined}
          className={generateClassList([
            styles.ctaLink,
            // isActive ? styles.activeLink : "",
          ])}
        >
          {isActive ? title : `${title}`}
        </a>
      </motion.span>
    );
}

export default function Nav (props: any) {
    const pathName = usePathname();

    if (pathName.includes('screen')) {
      return null;
    }

    return (
      <header className={styles.header}>
        <motion.nav 
        className={styles.nav}
           initial={{opacity: 0, y: -20}} 
           animate={{opacity: 1, y: 0}} 
        >
          <NavLink link="/" title="Home" isActive={pathName === "/"} />
          {/* {
                pages
                .filter(({meta}: any) => meta.type == "flex.FlexPage")
                .map((page :any)  => <NavLink key={page.id} link={`/flex/${page.meta.slug}`} title={page.title} />)
            }  */}
            <ProjectNavLink />
            <NavLink
              key={"blog"}
              link={`/blog`}
              title={"Blog"}
              isActive={pathName.includes("blog")}
            />
          <FocusToggle />
        </motion.nav>
      </header>
    );
}