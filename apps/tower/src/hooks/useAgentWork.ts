import { useQuery } from '@tanstack/react-query';
import { useTowerApi } from '@/lib/browser-context';
import { useTasksLive } from './useTasks';

/** One aggregate read, invalidated with task writes. No board, snapshot,
 * actor catalog or per-project task history is fetched for this page. */
export function useAgentWork() {
  const { live } = useTasksLive();
  const { fetchAgentStats } = useTowerApi();
  const query = useQuery({
    queryKey: ['tasks', 'agent-stats'],
    queryFn: ({ signal }) => fetchAgentStats(signal),
    enabled: live,
    staleTime: 15_000,
  });
  const data = query.data;
  return {
    live,
    projects: data?.projects ?? 0,
    complete: data !== undefined && data.broken.length === 0 && !query.isError,
    pending: live && query.isPending,
    broken: data?.broken ?? [],
    failed: query.isError,
    work: data && (data.projects === 0 || data.broken.length < data.projects) ? data.stats : null,
  };
}
