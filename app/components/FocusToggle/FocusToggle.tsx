'use client'

import styles from "./FocusToggle.module.css";
import { focusModeLabels, useFocusState } from "../Context/FocusStateContext";
import { FocusModes } from "../Context/FocusMode";

export function FocusToggle() {
    const { focusMode, commitFocusChange } = useFocusState();


    return (
      <div className={styles.focusToggle}>
        <p>Josh as a {focusModeLabels[focusMode ?? FocusModes.Developer]}</p>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={focusMode === FocusModes.Maker}
            onChange={() => {
              if (commitFocusChange) {
                const newFocusMode = focusMode === FocusModes.Maker
                    ? FocusModes.Developer
                    : FocusModes.Maker
                commitFocusChange(newFocusMode)
              }
            }}
          />
          <span className={styles.slider} />
        </label>
      </div>
    );
}