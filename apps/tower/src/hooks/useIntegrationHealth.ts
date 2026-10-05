import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { integrationStatus } from '@shared/integration-status';
import { useNow } from './useNow';

export const INTEGRATION_HEALTH_KEY = ['integration-health'];
/** Saved observations only; opening health never starts provider requests. */
export function useIntegrationHealth() {
  const { fetchIntegrationHealth } = useTowerApi();
  const query = useQuery({ queryKey: INTEGRATION_HEALTH_KEY, queryFn: ({ signal }) => fetchIntegrationHealth(signal),
    refetchInterval: 30_000, refetchIntervalInBackground: false, staleTime: 20_000, placeholderData: keepPreviousData, retry: 1 });
  const now = useNow(5_000);
  return { ...query, status: integrationStatus(query.data, query.isError, now) };
}
