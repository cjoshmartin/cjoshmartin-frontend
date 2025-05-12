'use client'
import { createContext, useContext, useState, useEffect } from "react";    
import { useRouter, useSearchParams } from 'next/navigation'
import { FocusModes } from "./FocusMode";


export const focusModeLabels = {
    [FocusModes.Developer]: "Developer",
    [FocusModes.Maker]: "Maker",
}

interface FocusStateContextState {
    focusMode?: FocusModes;
    commitFocusChange?: (focusMode: FocusModes) => void;

}

const FocusStateContext = createContext<FocusStateContextState>({});

export const FocusStateProvider = ({ children }: { children: React.ReactNode }) => {
    const searchParams = useSearchParams();
    const router = useRouter();

    const projectAudience = searchParams.get('project_audience') as FocusModes;

    const localStorageFocusMode = global?.window
      ? (localStorage?.getItem("cjoshmartin_focusMode") as FocusModes) ??
        FocusModes.Developer
      : FocusModes.Developer;
    const [focusMode, setFocusMode] = useState<FocusModes>(localStorageFocusMode);

    useEffect(() => {
        const focusMode = localStorage?.getItem('cjoshmartin_focusMode');
        if (projectAudience) {
            setFocusMode(projectAudience as FocusModes);
        } else if (focusMode) {
            router.push(`?project_audience=${focusMode}`);
        } 
    }, [projectAudience]);

    const commitFocusChange = (focusMode: FocusModes) => {
        setFocusMode(focusMode);
        localStorage.setItem('cjoshmartin_focusMode', focusMode);
        window.location.assign(`?project_audience=${focusMode}`);

    }

    return <FocusStateContext.Provider value={{ focusMode, commitFocusChange }}>{children}</FocusStateContext.Provider>;
};


export const useFocusState = () => {
    const context = useContext(FocusStateContext);
    if (!context) {
      throw new Error('useFocusState must be used within a FocusStateProvider');
    }
    return context;
};