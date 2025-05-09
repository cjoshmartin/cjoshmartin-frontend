import styles from "./FocusToggle.module.css";
import { FocusModes, useFocusState } from "../Context/FocusStateContext";

export function FocusToggle() {
    const { focusMode, setFocusMode } = useFocusState();
    return (
      <div className={styles.focusToggle}>
        <p>Josh as a {focusMode}</p>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={focusMode === FocusModes.Maker}
            onChange={() => {
              if (setFocusMode) {
                setFocusMode(
                  focusMode === FocusModes.Maker
                    ? FocusModes.Developer
                    : FocusModes.Maker
                )
              }
            }}
          />
          <span className={styles.slider} />
        </label>
      </div>
    );
}