'use client'

import { usePathname } from 'next/navigation';
import { NavLink } from './Nav';
import { useFocusState, FocusModes } from '../Context/FocusStateContext';
export function ProjectNavLink() {
    const pathname = usePathname();
    const { focusMode  } = useFocusState();

    return (
        <NavLink
            link="/projects"
            title={ focusMode === FocusModes.Developer ? "Portfolio" : "Projects"}
            isActive={pathname.includes("projects")}
        />
    )
}