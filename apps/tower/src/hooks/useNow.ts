import { useEffect, useState } from "react";

/** A slow clock so age badges keep ticking on a static TV between 60s polls —
 * without it a frozen Wall would never cross the amber threshold on screen. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
