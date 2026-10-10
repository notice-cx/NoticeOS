import { useEffect, useState } from "react";

/** How long a copy control says "Copied" before returning to its own label. */
export const COPY_FLASH_MS = 1200;

/**
 * The brief "Copied" confirmation on a copy control, and the timer that clears
 * it. Owning the timer in an effect means React cancels it on unmount, and
 * each flash re-arms the window rather than inheriting the last one's
 * deadline; a bare `setTimeout` in a click handler would do neither.
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
