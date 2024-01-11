import styles from './layout.module.css';

interface NavLinkProps {
    title: string,
    link: string,
    external?: boolean
}
function NavLink({title, link, external=false}: NavLinkProps ){
    return (
        <a href={link} target={external? "_blank": undefined} className="nav-link">[ {title} ]</a>
    )
}

export default function Nav () {

    return (
        <header className={styles.header}>
            <nav className={styles.nav} >
            <NavLink link="/" title="Home" />
            </nav>
            </header>
    )
}