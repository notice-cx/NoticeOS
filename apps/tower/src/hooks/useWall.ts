import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { WallPayload } from "@shared/wall";


/**
 * Polling read for both routes. On a failed poll TanStack Query keeps the last
 * successful `data` (it never clears it on error) and surfaces `error` — that is
 * the "last-good value + aging badge" behavior doc 10 requires; the UI ages its
 * badges off `data.generatedAt` and never blanks or spins.
 *
 * A HIDDEN TAB DOES NOT POLL (bead `ro-ujb9.63`). TanStack's "background" is
 * `document.visibilityState === "hidden"`, not window focus, so the TV — on
 * screen and never clicked — keeps its 60s refresh, while a desk tab left
 * behind another stops asking the store for a page nobody can see. Coming back
 * refetches at once when the held payload is older than `staleTime`, rather
 * than waiting out the next tick.
 */
export function useWall() {
  const { fetchWall } = useTowerApi();
  return useQuery<WallPayload>({
    queryKey: ["wall"],
    queryFn: ({ signal }) => fetchWall(signal),
    refetchInterval: 60_000, // doc 10: 60s default
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
