import { NavLink } from './Nav';

export function ProjectNavLink({ pathname }: { pathname: string }) {
    return (
        <NavLink
            link="/projects"
            title="Portfolio"
            isActive={pathname.includes("projects")}
        />
    )
}
