'use client'

import { usePathname } from 'next/navigation';
import { NavLink } from './Nav';

export function ProjectNavLink() {
    const pathname = usePathname();

    return (
        <NavLink
            link="/projects"
            title="Portfolio"
            isActive={pathname.includes("projects")}
        />
    )
}
