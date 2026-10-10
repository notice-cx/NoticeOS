import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { WallPayload } from "@shared/wall";


/**
 * Polling read for both routes. On a failed poll TanStack Query keeps the last
 * successful `data` and surfaces `error`: the UI ages its badges off
 * `data.generatedAt` and never blanks or spins. A hidden tab does not poll:
 * TanStack's "background" is `document.visibilityState === "hidden"`, not
 * window focus, so the TV keeps its 60s refresh while a desk tab left behind
 * another stops asking. Coming back refetches at once when the held payload
 * is older than `staleTime`.
 */
export function useWall() {
  const { fetchWall } = useTowerApi();
  return useQuery<WallPayload>({
    queryKey: ["wall"],
    queryFn: ({ signal }) => fetchWall(signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
