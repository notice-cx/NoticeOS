import { useEffect, useRef, useState } from "react";

// A LIVE NUMBER THAT COUNTS TO ITS NEW READING (bead `ro-trai.19`, doc 25 §
// Site rows): the Wall's live users are one plain figure, and when a poll
// brings a new reading the figure counts from the old one to it in a moment
// rather than jumping — the change is seen without a split-flap's tiles. Under
// reduced motion the new reading simply appears.

/** How long a count takes. Long enough to see, short enough to be done well
 * before the next 30-second poll. */
export const TWEEN_MS = 700;

/** The figure `progress` (0–1) of the way from `from` to `to`, easing out so
 * the count settles rather than stops, rounded to a whole reading. */
export function tweenAt(from: number, to: number, progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  const eased = 1 - (1 - t) ** 3;
  return Math.round(from + (to - from) * eased);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** The value to draw now for a live `target`: the target itself on first
 * paint, then a short count whenever the target changes. */
export function useTweenedNumber(target: number, durationMs = TWEEN_MS): number {
  const [shown, setShown] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      current.current = target;
      setShown(target);
      return;
    }
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const value = tweenAt(from, target, (now - started) / durationMs);
      current.current = value;
      setShown(value);
      if (value !== target) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return shown;
}
