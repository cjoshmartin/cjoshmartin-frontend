import styles from './layout.module.css';

interface NavLinkProps {
    title: string,
    link: string
}
function NavLink({title, link}: NavLinkProps ){
    return (
        <a href={link} target="_black" className="nav-link">[ {title} ]</a>
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