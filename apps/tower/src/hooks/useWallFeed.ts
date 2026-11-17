import { useBrowserRuntime, useChangesPushed } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { WALL_FEED_POLL_MS, type WallFeedPayload } from "@shared/wall-feed";
import { ApiError } from '@/lib/api';


/**
 * The Wall's live feed, polled every 30 s. Its own
 * query rather than a field of `/api/wall`: the feed moves every half minute,
 * the rest of the TV every minute. A failed poll keeps the last rows (TanStack
 * never clears `data` on error) and the column says it is reconnecting.
 * While the change stream delivers it, it is read only when it changed.
 */
export function useWallFeed() {
  const runtime = useBrowserRuntime();
  const hosted = runtime.owner.mode === 'hosted';
  const pushed = useChangesPushed();
  const query = useQuery<WallFeedPayload>({
    queryKey: ["wall-feed"],
    queryFn: ({ signal }) => runtime.api.fetchWallFeed(signal),
    refetchInterval: hosted || pushed ? false : WALL_FEED_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnMount: hosted ? 'always' : true,
    refetchOnWindowFocus: hosted ? 'always' : true,
    placeholderData: keepPreviousData,
    staleTime: WALL_FEED_POLL_MS / 2,
    retry: 1,
  });
  const denied = hosted && query.error instanceof ApiError && (query.error.status === 401 || query.error.status === 403);
  return denied ? { ...query, data: undefined } : query;
}
