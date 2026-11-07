import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOwnerMutation, useTowerApi } from '@/lib/browser-context';

/** Reads the saved briefing; polling never invokes the model. */
export function usePortfolioBrief() {
  const { fetchPortfolioBrief, runLocalJob } = useTowerApi();
  const client = useQueryClient();
  const refreshing = useIsMutating({ mutationKey: ['portfolio-brief-refresh'] });
  const refresh = useOwnerMutation({
    mutationKey: ['portfolio-brief-refresh'],
    mutationFn: () => runLocalJob('portfolio-brief'),
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: ['portfolio-brief'] }),
      client.invalidateQueries({ queryKey: ['workflows'] }),
    ]),
    retry: false,
  });
  const read = useQuery({
    queryKey: ['portfolio-brief'],
    queryFn: ({ signal }) => fetchPortfolioBrief(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  return { ...read, refresh: () => { if (client.isMutating({ mutationKey: ['portfolio-brief-refresh'] }) === 0) refresh.mutate(); }, isRefreshing: refreshing > 0,
    refreshError: refresh.isError ? refresh.error.message : refresh.data?.outcome === 'failed' ? refresh.data.detail ?? 'The refresh failed.' : null,
    refreshNotice: refresh.data?.outcome === 'skipped' ? refresh.data.detail ?? 'The refresh was skipped.' : null };
}
