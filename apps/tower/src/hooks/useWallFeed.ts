import { useChangesPushed, useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { WALL_FEED_POLL_MS, type WallFeedPayload } from "@shared/wall-feed";


/**
 * The Wall's live feed, polled every 30 s. Its own
 * query rather than a field of `/api/wall`: the feed moves every half minute,
 * the rest of the TV every minute. A failed poll keeps the last rows (TanStack
 * never clears `data` on error) and the column says it is reconnecting.
 * While the change stream delivers it, it is read only when it changed.
 */
export function useWallFeed() {
  const { fetchWallFeed } = useTowerApi();
  const pushed = useChangesPushed();
  return useQuery<WallFeedPayload>({
    queryKey: ["wall-feed"],
    queryFn: ({ signal }) => fetchWallFeed(signal),
    refetchInterval: pushed ? false : WALL_FEED_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    staleTime: WALL_FEED_POLL_MS / 2,
    retry: 1,
  });
}
