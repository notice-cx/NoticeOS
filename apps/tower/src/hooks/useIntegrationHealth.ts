import { useChangesPushed, useTowerApi } from '@/lib/browser-context';
import { ApiError } from '@/lib/api';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { integrationStatus } from '@shared/integration-status';
import type { ConnectionHealthSnapshot } from '@shared/connection-status';
import { HOSTED_WALL_REFRESH_MS } from '@shared/wall';
import { useNow } from './useNow';

export const INTEGRATION_HEALTH_KEY = ['integration-health'];
function accessLost(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
/** Saved observations only; opening health never starts provider requests. */
export function useIntegrationHealth(watch = true) {
  const { fetchIntegrationHealth } = useTowerApi();
  const pushed = useChangesPushed();
  const query = useQuery({ queryKey: INTEGRATION_HEALTH_KEY, queryFn: ({ signal }) => fetchIntegrationHealth(signal),
    refetchInterval: pushed ? false : watch ? 30_000 : HOSTED_WALL_REFRESH_MS,
    refetchIntervalInBackground: false, refetchOnWindowFocus: !watch,
    staleTime: 20_000, placeholderData: keepPreviousData, retry: (count, error) => !accessLost(error) && count < 1 });
  const now = useNow(watch ? 30_000 : false);
  const data = accessLost(query.error) ? undefined : query.data;
  // The Wall shows what the read established when it arrived. Live surfaces
  // still judge the same observation against the advancing clock.
  const status = integrationStatus(data, query.isError || (!watch && data?.available !== true),
    watch ? now : query.dataUpdatedAt);
  const snapshot: ConnectionHealthSnapshot | undefined = watch ? undefined : {
    checkedAt: data && Number.isFinite(Date.parse(data.generatedAt)) ? data.generatedAt : null,
    state: query.isError ? 'error' : data?.available !== true ? 'unknown' : status.current ? 'saved' : 'stale',
  };
  return { ...query, data, status, snapshot };
}
