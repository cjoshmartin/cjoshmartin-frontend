'use client'
import { createContext, useContext, useState, useEffect, useMemo, Suspense } from "react";
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

    const commitFocusChange = (focusMode: FocusModes) => {
        setFocusMode(focusMode);
        localStorage.setItem('cjoshmartin_focusMode', focusMode);
        const params = new URLSearchParams(window.location.search);
        params.set('project_audience', focusMode);
        window.location.assign(`?${params.toString()}`);

    }

    return (
        <FocusStateContext.Provider value={{ focusMode, commitFocusChange }}>
            <Suspense fallback={null}>
                <FocusModeUrlSync setFocusMode={setFocusMode} />
            </Suspense>
            {children}
        </FocusStateContext.Provider>
    );
};

// useSearchParams() requires a Suspense boundary, so the URL-syncing logic
// lives in its own subtree rather than gating {children} on it.
function FocusModeUrlSync({ setFocusMode }: { setFocusMode: (focusMode: FocusModes) => void }) {
    const searchParams = useSearchParams();
    const router = useRouter();

    // Get the project audience from the search params
    const projectAudience = useMemo(() => searchParams.get('project_audience') as FocusModes, [searchParams]);

    useEffect(() => {
        // check if focus mode has been set in local storage
        const focusModeStorage = localStorage?.getItem('cjoshmartin_focusMode');
        // if search params has a project audience, set the focus mode to the project audience
        if (projectAudience ) {
            setFocusMode(projectAudience as FocusModes);
            localStorage.setItem('cjoshmartin_focusMode', projectAudience);
            // if the focus mode is set in the local storage, add it to the search params
        } else  if (focusModeStorage) {
            const params = new URLSearchParams(searchParams.toString());
            params.set('project_audience', focusModeStorage);
            router.replace(`?${params.toString()}`);
            router.refresh();
        } else if (!focusModeStorage && !projectAudience) {
            localStorage.setItem('cjoshmartin_focusMode', FocusModes.Developer);
            const params = new URLSearchParams(searchParams.toString());
            params.set('project_audience', FocusModes.Developer);
            router.replace(`?${params.toString()}`);
            router.refresh();
        }
    }, [projectAudience, router, searchParams, setFocusMode]);

    return null;
}


export const useFocusState = () => {
    const context = useContext(FocusStateContext);
    if (!context) {
      throw new Error('useFocusState must be used within a FocusStateProvider');
    }
    return context;
};