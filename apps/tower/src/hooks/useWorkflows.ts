import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from '@tanstack/react-query';


export function useWorkflows(runId?: string) {
  const { fetchWorkflows } = useTowerApi();
  return useQuery({ queryKey: ["workflows", runId ?? null], queryFn: ({ signal }) => fetchWorkflows(runId, signal),
    placeholderData: keepPreviousData, refetchInterval: 5_000, retry: false });
}
