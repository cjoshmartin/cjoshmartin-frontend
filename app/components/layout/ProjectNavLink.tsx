'use client'

import { usePathname } from 'next/navigation';
import { NavLink } from './Nav';
import { useFocusState } from '../Context/FocusStateContext';
import { FocusModes } from '../Context/FocusMode';
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