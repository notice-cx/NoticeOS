import { useChangesPushed, useTowerApi } from '@/lib/browser-context';
import { workspaceReadDenied } from '@/lib/api';
import { AppReleaseError } from '@/lib/app-release';
import { useQuery } from "@tanstack/react-query";
import type { WorkPayload } from "@shared/work";


/**
 * Polling read for the work board (desk-only). Faster than the Wall's 60s
 * because the supply behind it moves faster: the runner photographs the task
 * hub every minute, so a 30s poll keeps the board within one snapshot of the
 * truth without ever being the reason it is stale. The last-good payload is
 * kept on a failed poll, so the board ages its age chip rather than blanking.
 * While the change stream delivers it, it is read only when it changed.
 * Passive surfaces read on entry, return or task actions.
 *
 * `enabled: false` where the surface asking draws nothing without a task source
 * connected, so an installation with none never polls for a board.
 */
export function useWork({ enabled = true, watch = true }: { enabled?: boolean; watch?: boolean } = {}) {
  const { fetchWork } = useTowerApi();
  const pushed = useChangesPushed();
  const query = useQuery<WorkPayload>({
    queryKey: ["work"],
    queryFn: ({ signal }) => fetchWork(signal),
    refetchInterval: watch && !pushed ? 30_000 : false,
    staleTime: 15_000,
    enabled,
    ...(watch ? {} : {
      refetchOnWindowFocus: 'always' as const,
      retry: (count: number, error: Error) => !(error instanceof AppReleaseError) && !workspaceReadDenied(error) && count < 1,
    }),
  });
  return !watch && workspaceReadDenied(query.error) ? { ...query, data: undefined } : query;
}
