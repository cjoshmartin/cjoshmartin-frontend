'use client';

import Link from 'next/link';
import styles from './layout.module.css';
import { PageTypes } from '@/app/PageTypes';
import { usePathname } from 'next/navigation';
import { generateClassList } from '@/app/projects/__components/generateClassList';

interface NavLinkProps {
    title: string,
    link: string,
    external?: boolean
    isActive?: boolean
}

function NavLink({title, link, external=false, isActive}: NavLinkProps ){
    generateClassList
    return (
      <Link
        href={link}
        target={external ? "_blank" : undefined}
        className={generateClassList([
          "nav-link",
          isActive ? styles.activeLink : "",
        ])}
      >
          {isActive ? title : `[${title}]`}
      </Link>
    );
}

export default function Nav (props: any) {
    const pathName = usePathname();

    return (
      <header className={styles.header}>
        <nav className={styles.nav}>
          <NavLink link="/" title="Home" isActive={pathName === "/"} />
          {/* {
                pages
                .filter(({meta}: any) => meta.type == "flex.FlexPage")
                .map((page :any)  => <NavLink key={page.id} link={`/flex/${page.meta.slug}`} title={page.title} />)
            }  */}
          <NavLink
            link="/projects"
            title="Projects"
            isActive={pathName.includes("projects")}
          />
          {props.count[PageTypes.BLOG_POST] > 0 && (
            <NavLink
              key={"blog"}
              link={`/blog`}
              title={"Blog"}
              isActive={pathName.includes("blog")}
            />
          )}
        </nav>
      </header>
    );
}