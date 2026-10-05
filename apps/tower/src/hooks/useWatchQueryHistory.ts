import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";


/**
 * Bounded R2-backed history for the exact query a watch composer is showing.
 * Disabled for site-wide composers, so the normal asset read never pays the
 * archive cost. Changing query or metric keeps the prior row only while the new
 * key loads; the caller checks the echoed query/metric before using it.
 */
export function useWatchQueryHistory(
  asset: string,
  query: string | null,
  metric: string,
) {
  const { fetchWatchQueryHistory } = useTowerApi();
  return useQuery({
    queryKey: ["watch-query-history", asset, query, metric],
    queryFn: ({ signal }) => fetchWatchQueryHistory(asset, query!, metric, signal),
    enabled: query !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
}
