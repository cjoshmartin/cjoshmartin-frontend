'use client'
import { createContext, useContext, useState, useEffect } from "react";    

export enum FocusModes {
    Developer = "Developer",
    Maker = "Maker",
}

interface FocusStateContextState {
    focusMode?: FocusModes;
    setFocusMode?: (focusMode: FocusModes) => void;
}

const FocusStateContext = createContext<FocusStateContextState>({});

export const FocusStateProvider = ({ children }: { children: React.ReactNode }) => {
    const [focusMode, setFocusMode] = useState<FocusModes>(
      (localStorage.getItem("cjoshmartin_focusMode") as FocusModes) ??
        FocusModes.Developer
    );

    useEffect(() => {
        const focusMode = localStorage.getItem('cjoshmartin_focusMode');
        if (focusMode) {
            setFocusMode(focusMode as FocusModes);
        } 
    }, []);

    useEffect(() => {
        if (focusMode) {
            localStorage.setItem('cjoshmartin_focusMode', focusMode);
        }
    }, [focusMode]);

    return <FocusStateContext.Provider value={{ focusMode, setFocusMode }}>{children}</FocusStateContext.Provider>;
};


export const useFocusState = () => {
    const context = useContext(FocusStateContext);
    if (!context) {
      throw new Error('useFocusState must be used within a FocusStateProvider');
    }
    return context;
};