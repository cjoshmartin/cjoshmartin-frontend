'use client'
import { createContext, useContext, useState, useEffect, useMemo } from "react";    
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

    // Get the project audience from the search params
    const projectAudience = useMemo(() => searchParams.get('project_audience') as FocusModes, [searchParams]);

    // Get the focus mode from the local storage
    const localStorageFocusMode = useMemo(
      () =>
        global?.window
          ? (localStorage?.getItem("cjoshmartin_focusMode") as FocusModes) ??
            FocusModes.Developer
          : FocusModes.Developer,
      []
    );

    // Set the focus mode to the local storage focus mode
    const [focusMode, setFocusMode] = useState<FocusModes>(localStorageFocusMode);

    useEffect(() => {
        // check if focus mode has been set in local storage
        const focusModeStorage = localStorage?.getItem('cjoshmartin_focusMode');
        // if search params has a project audience, set the focus mode to the project audience
        if (projectAudience ) {
            setFocusMode(projectAudience as FocusModes);
            localStorage.setItem('cjoshmartin_focusMode', projectAudience);
            // if the focus mode is set in the local storage, replace the search params with the focus mode
        } else  if (focusModeStorage) {
            router.replace(`?project_audience=${focusModeStorage}`);
        } else if (!focusModeStorage && !projectAudience) {
            localStorage.setItem('cjoshmartin_focusMode', FocusModes.Developer);
            router.replace(`?project_audience=${FocusModes.Developer}`);
        } 
    }, [projectAudience,  router]);

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