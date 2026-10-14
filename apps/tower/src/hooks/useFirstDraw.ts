import { useEffect, useState } from "react";

/** What a first draw needs to know of a read: whether it has answered. */
export interface DrawnRead {
  isPending: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
}

/** A read has answered with data or a failure; a read not in flight
 * (disabled, not needed by this page, or paused offline) has nothing to wait for. */
export const answered = (read: DrawnRead) => !read.isPending || read.fetchStatus !== "fetching";

/**
 * Whether a page may draw: once every read it draws from has answered, or
 * `maxWaitMs` after it started waiting, whichever comes first. A page drawn
 * from reads that land one by one changes its numbers under the reader; one
 * drawn from all of them changes only when the data does. It latches, so a
 * refetch never takes the page back to its loading state.
 */
export function useFirstDraw(reads: readonly DrawnRead[], maxWaitMs = 4_000): boolean {
  const ready = reads.every(answered);
  const [late, setLate] = useState(false);
  const [drawn, setDrawn] = useState(ready);
  useEffect(() => {
    if (drawn) return;
    if (ready || late) { setDrawn(true); return; }
    const timer = setTimeout(() => setLate(true), maxWaitMs);
    return () => clearTimeout(timer);
  }, [drawn, ready, late, maxWaitMs]);
  return drawn || ready || late;
}
