'use client'

import { useState } from "react";
import styles from './TestimonialProgress.module.css'
import type { FromAPI } from "@/app/components/Testimonial";

const TESTIMONIAL_CYCLE_DURATION_SECONDS = 30;

interface TestimonialProgressProps {
  all?: FromAPI[];
  onAdvance: (testimonial: FromAPI['testimonial']) => void;
}

export default function TestimonialProgress({ all, onAdvance }: TestimonialProgressProps) {
  const [testIndex, setTestIndex] = useState<number>(0);
  const [shownIndices, setShownIndices] = useState<Set<number>>(() => new Set([0]));

  const advanceToRandomTestimonial = () => {
    if (!all || all.length < 2) return;

    const shown = new Set(shownIndices);
    shown.add(testIndex);

    let candidates = all.map((_, i) => i).filter((i) => !shown.has(i));

    if (candidates.length === 0) {
      // every testimonial has had a turn - start a fresh cycle
      candidates = all.map((_, i) => i).filter((i) => i !== testIndex);
      shown.clear();
      shown.add(testIndex);
    }

    const newIndex = candidates[Math.floor(Math.random() * candidates.length)];
    shown.add(newIndex);

    setShownIndices(shown);
    setTestIndex(newIndex);
    onAdvance(all[newIndex].testimonial);
  };

  if (!all || all.length <= 1) {
    return null;
  }

  return (
    <div className={styles.testimonialProgressContainer}>
      <div className={styles.testimonialProgressTrack}>
        <div
          key={testIndex}
          className={styles.testimonialProgressFill}
          style={{ animationDuration: `${TESTIMONIAL_CYCLE_DURATION_SECONDS}s` }}
          onAnimationEnd={advanceToRandomTestimonial}
        />
      </div>
    </div>
  );
}
