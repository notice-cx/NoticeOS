import { useEffect, useState } from "react";

/** How long a copy control says "Copied" before returning to its own label. */
export const COPY_FLASH_MS = 1200;

/**
 * The brief "Copied" confirmation on a copy control, and the timer that clears
 * it (bead `ro-ogc7`).
 *
 * Four components had grown the same three lines — `setCopied(true)` and then a
 * bare `setTimeout` inside the click handler — and that timer belonged to
 * nobody. It survived the component: a row unmounted inside the window still
 * had a callback pointed at its dead state. And because nothing cancelled the
 * first one, a second copy inside the window was cleared by the FIRST copy's
 * timer, so the confirmation an operator had just earned vanished early.
 *
 * Owning the timer in an effect makes both go away: React cancels it on
 * unmount, and each flash re-arms the window rather than inheriting the last
 * one's deadline. It also makes the flash something a test can DRIVE with fake
 * timers instead of race against the wall clock, which is the bug this hook was
 * extracted for.
 */
export function useCopyFlash(): readonly [boolean, () => void] {
  // A counter rather than a boolean: re-copying while the confirmation is up
  // has to change state, or the effect would not re-run and the window would
  // not restart.
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    if (flash === 0) return;
    const timer = setTimeout(() => setFlash(0), COPY_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  return [flash > 0, () => setFlash((count) => count + 1)] as const;
}
