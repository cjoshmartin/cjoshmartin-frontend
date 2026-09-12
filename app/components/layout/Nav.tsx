import { headers } from 'next/headers';
import styles from './layout.module.css';
import { generateClassList } from '@/app/projects/__components/generateClassList';
import { ProjectNavLink } from './ProjectNavLink';

interface NavLinkProps {
    title: string,
    link: string,
    external?: boolean
    isActive?: boolean
}

export function NavLink({title, link, external=false, isActive}: NavLinkProps ){
    return (
      <a
        href={link}
        target={external ? "_blank" : undefined}
        style={{
          cursor: 'pointer',
          padding: '0.5rem',
          display: 'inline-block',
        }}
        className={generateClassList([
          "nav-link",
          isActive ? styles.activeLink : "",
        ])}
      >
        {isActive ? title : `[${title}]`}
      </a>
    );
}

export default async function Nav () {
    const pathname = (await headers()).get('x-pathname') ?? '/';

    if (pathname.includes('screen')) {
      return null;
    }

    return (
      <header className={styles.header}>
        <nav className={styles.nav}>
          <NavLink link="/" title="Home" isActive={pathname === "/"} />
            <ProjectNavLink pathname={pathname} />
            <NavLink
              key={"blog"}
              link={`/blog`}
              title={"Blog"}
              isActive={pathname.includes("blog")}
            />
        </nav>
      </header>
    );
}
