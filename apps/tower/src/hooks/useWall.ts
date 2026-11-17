import { useBrowserContext, useChangesPushed } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { WallPayload } from "@shared/wall";
import { useEffect } from 'react';
import { ApiError } from '@/lib/api';
import { AppReleaseError } from '@/lib/app-release';

function accessLost(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * A hosted Wall reads on entry, return to the tab, or query invalidation.
 * Transient read failures retain the last result. An access refusal discards
 * it and rechecks the browser session.
 */
export function useWall() {
  const { runtime, refreshSession } = useBrowserContext();
  const hosted = runtime.owner.mode === 'hosted';
  const pushed = useChangesPushed();
  const query = useQuery<WallPayload>({
    queryKey: ["wall"],
    queryFn: ({ signal }) => runtime.api.fetchWall(signal),
    refetchInterval: query => hosted || (pushed && !query.state.error) ? false : 60_000,
    refetchIntervalInBackground: false,
    refetchOnMount: hosted ? 'always' : true,
    refetchOnWindowFocus: hosted ? 'always' : true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    ...(hosted ? { retry: (count: number, error: Error) => !(error instanceof AppReleaseError) && !accessLost(error) && count < 1 } : {}),
  });
  const denied = hosted && accessLost(query.error);
  useEffect(() => { if (denied) void refreshSession?.(); }, [denied, refreshSession]);
  return denied ? { ...query, data: undefined } : query;
}
