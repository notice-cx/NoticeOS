import { useQuery } from '@tanstack/react-query';
import { useTowerApi } from '@/lib/browser-context';

/** Reads the saved briefing; polling never invokes the model. */
export function usePortfolioBrief() {
  const { fetchPortfolioBrief } = useTowerApi();
  return useQuery({
    queryKey: ['portfolio-brief'],
    queryFn: ({ signal }) => fetchPortfolioBrief(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
