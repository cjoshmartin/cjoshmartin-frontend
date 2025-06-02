'use client'

import { useFocusState } from "../components/Context/FocusStateContext";
import { FocusModes } from "../components/Context/FocusMode";

export function Esty() {

    const { focusMode } = useFocusState();

    const isDeveloper = focusMode === FocusModes.Developer;

    if (isDeveloper) {
        return null;
    }

    return (
        <div>
            <h2>Esty</h2>
        </div>
    )
}