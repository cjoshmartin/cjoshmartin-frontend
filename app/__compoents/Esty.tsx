import { FocusModes } from "../components/Context/FocusMode";

const focusMode: FocusModes = FocusModes.Developer;

export function Esty() {

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
