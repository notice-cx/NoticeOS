import { useDemoReadonly, useOwnerMutation as useMutation, useTowerApi } from '@/lib/browser-context';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { LiveTasksPayload, TasksCapabilities, TaskProject } from "@shared/tasks";
import type { NewTask } from "@/lib/api";

/**
 * The Tower's live reads and writes over the portfolio's task hub. Two boards,
 * one hub: `useWork()` reads the snapshot the runner files once a minute,
 * served in every deployment; these hooks read the hub itself through the
 * local lane. `useTasksLive()` decides which one a surface may offer actions
 * on. Every write invalidates the snapshot (`["work"]`, `["wall"]`), or the
 * board would keep showing a closed task as open until the next poll.
 */

/** Assumed absent until the answer arrives, and if the question fails — the
 * opposite default from `useConfigWritable`, and deliberately so. A field that
 * flashes disabled is a small lie; a Claim button that appears and then cannot
 * work is a write the operator believes happened. The snapshot board is always
 * correct to show, so it is what an unanswered question falls back to. */
const ASSUME_SNAPSHOT: TasksCapabilities = { live: false, reason: null };

/**
 * Can this deployment reach the task hub?
 *
 * Asked ONCE per session (`staleTime: Infinity`, no retry): the answer is a
 * fact about the build the browser loaded — a Tower the runner serves has the
 * lane, a deployed Worker cannot have it — and it cannot change under a running
 * page.
 */
export function useTasksLive(): TasksCapabilities {
  const demoReadonly = useDemoReadonly();
  const { data } = useTasksLiveRead();
  const capability = data ?? ASSUME_SNAPSHOT;
  return !demoReadonly ? capability : { ...capability, writable: false };
}

/** The capability read itself, for a page that draws only once it has answered. */
function useTasksLiveRead() {
  const { fetchTasksCapabilities } = useTowerApi();
  return useQuery<TasksCapabilities>({
    queryKey: ["tasks-live"],
    queryFn: ({ signal }) => fetchTasksCapabilities(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

/** Catalog names are presentation/selectors; each task request is admitted
 * anew. A standalone snapshot roster is never substituted for this catalog. */
export function useTaskProjects() {
  const { fetchTaskProjects } = useTowerApi();
  const { projectSelection } = useTasksLive();
  return useQuery<readonly TaskProject[]>({ queryKey: ['task-projects'],
    queryFn: ({ signal }) => fetchTaskProjects(signal), enabled: projectSelection === true, staleTime: 15_000 });
}
/**
 * One project's live board. Enabled only where the lane exists and a project is
 * named — a deployed build must never fire this and collect a 501 per mount.
 *
 * No polling interval: this read is already live, and every write from this
 * session invalidates it. A board that re-shelled `bd` across seven spokes on a
 * timer would spend the operator's machine on a question nothing asked.
 */
export function useTasks(project: string | null, status?: string) {
  const { fetchTasks } = useTowerApi();
  const { live } = useTasksLive();
  return useQuery<LiveTasksPayload>({
    queryKey: ["tasks", project, status ?? null],
    queryFn: ({ signal }) => fetchTasks(project as string, status, signal),
    enabled: live && project !== null && project !== "",
    staleTime: 15_000,
  });
}

/**
 * What every task write invalidates: the live board and task page it changed,
 * the snapshot board that has not heard yet, the Wall, whose counts are built
 * from the same snapshot, and the asset page, whose rows carry the
 * `HandoffBeadBadge` for the task just filed or closed. The badge itself still
 * arrives on the poller's own cadence; this buys the refetch, not the row.
 */
function useTaskRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all(
      [["tasks"], ["task"], ["work"], ["wall"], ["asset-detail"]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  }, [queryClient]);
}

/** File a task. Resolves with the id the hub minted, so a composer can link
 * straight to the page for what it just created. */
export function useCreateTask() {
  const { createTask } = useTowerApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: (input: NewTask) => createTask(input),
    onSuccess: () => refresh(),
  });
}
