import Link from 'next/link';
import generateURL from '../generateURL';
import styles from './layout.module.css';

interface NavLinkProps {
    title: string,
    link: string,
    external?: boolean
}
function NavLink({title, link, external=false}: NavLinkProps ){
    return (
        <Link href={link} target={external? "_blank": undefined} className="nav-link">[ {title} ]</Link>
    )
}

async function getNav(){
    return fetch(generateURL('/api/pages/count'))
    .then((respone) => respone.json())
}

export default async function Nav () {
    const {count, pages} = await getNav();

    return (
        <header className={styles.header}>
            <nav className={styles.nav} >
            <NavLink link="/" title="Home" />
            {/* {
                pages
                .filter(({meta}: any) => meta.type == "flex.FlexPage")
                .map((page :any)  => <NavLink key={page.id} link={`/flex/${page.meta.slug}`} title={page.title} />)
            }  */}
            {
                count["blog.BlogPage"] > 0 && <NavLink key={"blog"} link={`/blog`} title={"Blog"} />
            }
            
            </nav>
            </header>
    )
}