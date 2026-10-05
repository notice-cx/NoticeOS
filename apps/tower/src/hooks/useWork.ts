import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { WorkPayload } from "@shared/work";


/**
 * Polling read for the work board (desk-only). Faster than the Wall's 60s
 * because the supply behind it moves faster: the runner photographs the task
 * hub every minute, so a 30s poll keeps the board within one snapshot of the
 * truth without ever being the reason it is stale. The last-good payload is
 * kept on a failed poll, so the board ages its age chip rather than blanking.
 *
 * `enabled: false` where the surface asking draws nothing without a task source
 * connected (D32), so an installation with none never polls for a board.
 */
export function useWork({ enabled = true }: { enabled?: boolean } = {}) {
  const { fetchWork } = useTowerApi();
  return useQuery<WorkPayload>({
    queryKey: ["work"],
    queryFn: ({ signal }) => fetchWork(signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
    enabled,
  });
}
