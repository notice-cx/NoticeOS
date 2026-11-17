import { useBrowserRuntime } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from '@tanstack/react-query';


export function useWorkflows(runId?: string) {
  const runtime = useBrowserRuntime();
  const hosted = runtime.owner.mode === 'hosted';
  return useQuery({ queryKey: ["workflows", runId ?? null], queryFn: ({ signal }) => runtime.api.fetchWorkflows(runId, signal),
    placeholderData: keepPreviousData, refetchInterval: query => !hosted || query.state.data?.workflows.some(workflow => workflow.active)
      ? 5_000 : 30_000, refetchOnWindowFocus: hosted, retry: false });
}
