import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import {
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { useSearchParams } from 'react-router-dom';

import type { LiveTaskDetail, LiveTasksPayload, TasksCapabilities, TaskProject } from "@shared/tasks";
import { dismissTask, resolveGate, respondToTask, type NewTask, type TaskEdit, type TowerApi } from "@/lib/api";
import { UNDO_WINDOW_MS } from "@/lib/answer-queue";
import { useOwnerAnswers } from "@/lib/browser-context";
import { useOwnerMutation as useMutation } from '@/lib/browser-context';

/**
 * The Tower's live reads and writes over the portfolio's task hub (D19, epic
 * `ro-l1ed`).
 *
 * TWO BOARDS, ONE HUB. `useWork()` reads the snapshot — a photograph the runner
 * files once a minute, served by the Worker in every deployment. These hooks
 * read the hub itself through the local lane, which only exists where `os:up`
 * is serving. `useTasksLive()` is the question that decides which one a surface
 * may offer actions on, and it is asked once.
 *
 * EVERY WRITE INVALIDATES THE SNAPSHOT. A close through this lane lands in the
 * hub instantly; the `/api/work` board would keep showing the bead as open
 * until the next poll, and the Wall's counts with it. Invalidating `["work"]`
 * and `["wall"]` after a write costs one read and removes a whole class of "I
 * closed that, why is it still there".
 *
 * `bd` remains the path an AGENT uses. Nothing here is for an agent.
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
 * fact about the build the browser loaded — a local `os:up` has the lane, a
 * deployed Worker cannot have it — and it cannot change under a running page.
 */
export function useTasksLive(): TasksCapabilities {
  const demoReadonly = useDemoReadonly();
  const { fetchTasksCapabilities } = useTowerApi();
  const { data } = useQuery<TasksCapabilities>({
    queryKey: ["tasks-live"],
    queryFn: ({ signal }) => fetchTasksCapabilities(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const capability = data ?? ASSUME_SNAPSHOT;
  return !demoReadonly ? capability : { ...capability, writable: false };
}

/** Catalog names are presentation/selectors; each task request is admitted
 * anew. A standalone snapshot roster is never substituted for this catalog. */
export function useTaskProjects() {
  const { fetchTaskProjects } = useTowerApi();
  const { projectSelection } = useTasksLive();
  return useQuery<readonly TaskProject[]>({ queryKey: ['task-projects'],
    queryFn: ({ signal }) => fetchTaskProjects(signal), enabled: projectSelection === true, staleTime: 15_000 });
}
function useTaskSelection() {
  const [params] = useSearchParams();
  const { projectSelection } = useTasksLive();
  return (project?: string): string | undefined => projectSelection ? project ?? params.get('project') ?? undefined : undefined;
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
 * EVERY named project's live board, in the order given — the Tasks index's read.
 *
 * `useTasks` above is the same read for one project, and this is deliberately
 * not a loop over it: a hook cannot be called a different number of times
 * between renders, and the project list arrives asynchronously with the
 * snapshot. `useQueries` is one hook whose ARRAY changes, and it builds the
 * exact query keys `useTasks` builds, so both share one cache entry per project
 * and a write invalidating `["tasks"]` refreshes whichever is mounted.
 *
 * `enabled` still comes from the lane's own answer, so a deployed build fires
 * none of these and the index falls back to the snapshot board.
 */
export function useTasksAcross(
  projects: string[],
): UseQueryResult<LiveTasksPayload, Error>[] {
  const { fetchTasks } = useTowerApi();
  const { live } = useTasksLive();
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ["tasks", project, null],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        fetchTasks(project, undefined, signal),
      enabled: live && project !== "",
      staleTime: 15_000,
    })),
  });
}

/** One bead and its comments, by id — the project comes from the id's prefix. */
export function useTask(id: string | null, project?: string) {
  const { fetchTask } = useTowerApi();
  const { live, projectSelection } = useTasksLive();
  const selected = useTaskSelection()(project);
  return useQuery<LiveTaskDetail>({
    queryKey: selected === undefined ? ["task", id] : ["task", selected, id],
    queryFn: ({ signal }) => selected === undefined ? fetchTask(id as string, signal) : fetchTask(id as string, signal, selected),
    enabled: live && (!projectSelection || selected !== undefined) && id !== null && id !== "",
    staleTime: 15_000,
  });
}

/**
 * What every task write invalidates: the live board and task page it changed,
 * the snapshot board that has not heard yet, the Wall, whose counts are built
 * from the same snapshot, and the ASSET page, whose findings, query rows and
 * page rows carry the `HandoffBeadBadge` for the bead that was just filed or
 * closed (bead `ro-l1ed.4`).
 *
 * The badge itself still arrives on the poller's own cadence — the marker is
 * read out of `beads_snapshots`, which the runner refreshes once a minute — so
 * this buys the refetch, not the row. That is the honest ceiling: the Tower
 * does not write the snapshot, and pretending the badge is instant would mean
 * rendering a bead the register has not photographed yet.
 */
export function useTaskRefresh(): () => Promise<void> {
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

/** Claim, defer, reprioritize, retitle, relabel, reparent — one mutation over
 * the lane's whole edit allowlist, because they are one `bd update`. */
export function useUpdateTask() {
  const { updateTask } = useTowerApi();
  const refresh = useTaskRefresh();
  const selected = useTaskSelection();
  return useMutation({
    mutationFn: ({ id, edit, project }: { id: string; edit: TaskEdit; project?: string }) => {
      const ownerProject = selected(project); return ownerProject === undefined ? updateTask(id, edit) : updateTask(id, edit, ownerProject);
    },
    onSuccess: () => refresh(),
  });
}

/** Claim is its own hook because it is the single most frequent write and takes
 * no arguments beyond the id — a row's button should not have to know the shape
 * of an edit to make one. */
export function useClaimTask() {
  const { updateTask } = useTowerApi();
  const refresh = useTaskRefresh();
  const selected = useTaskSelection();
  return useMutation({
    mutationFn: (input: string | { id: string; project: string }) => {
      const id = typeof input === 'string' ? input : input.id;
      const project = selected(typeof input === 'string' ? undefined : input.project);
      return project === undefined ? updateTask(id, { claim: true }) : updateTask(id, { claim: true }, project);
    },
    onSuccess: () => refresh(),
  });
}

export function useCloseTask() {
  const { closeTask } = useTowerApi();
  const refresh = useTaskRefresh();
  const selected = useTaskSelection();
  return useMutation({
    mutationFn: ({ id, reason, project }: { id: string; reason: string; project?: string }) => {
      const ownerProject = selected(project); return ownerProject === undefined ? closeTask(id, reason) : closeTask(id, reason, ownerProject);
    },
    onSuccess: () => refresh(),
  });
}

export function useCommentOnTask() {
  const { commentOnTask } = useTowerApi();
  const refresh = useTaskRefresh();
  const selected = useTaskSelection();
  return useMutation({
    mutationFn: ({ id, text, project }: { id: string; text: string; project?: string }) => {
      const ownerProject = selected(project); return ownerProject === undefined ? commentOnTask(id, text) : commentOnTask(id, text, ownerProject);
    },
    onSuccess: () => refresh(),
  });
}

/**
 * THE INBOX'S THREE ANSWERS (bead `ro-ujb9.96.7.11`) — approve a gate, answer
 * an ask, decline one — each ONE call on the lane the inbox has always used:
 * `bd gate resolve`, `bd human respond`, `bd human dismiss`. What changed is
 * WHEN: each is one press on its row, the row leaves at once, and the call is
 * made when the Undo window closes (`lib/answer-queue.ts`), because none of
 * the three has an inverse the lane can run. All three close the bead, so all
 * three invalidate everything a close does.
 */
export type InboxAnswer = (
  | { kind: "approve"; id: string; title: string }
  | { kind: "answer"; id: string; title: string; text: string }
  | { kind: "dismiss"; id: string; title: string }) & { readonly project?: string };

/** The lane call for one answer. Only the page-leaving flush passes
 * `keepalive`. */
export function sendInboxAnswer(answer: InboxAnswer, keepalive = false, api: Pick<TowerApi, 'resolveGate' | 'respondToTask' | 'dismissTask'> = { resolveGate, respondToTask, dismissTask }): Promise<void> {
  const { resolveGate, respondToTask, dismissTask } = api;
  const options = keepalive || answer.project !== undefined
    ? { ...(keepalive ? { keepalive: true } : {}), ...(answer.project === undefined ? {} : { project: answer.project }) } : undefined;
  if (answer.kind === "approve") {
    return options ? resolveGate(answer.id, undefined, options) : resolveGate(answer.id);
  }
  if (answer.kind === "answer") {
    return options ? respondToTask(answer.id, answer.text, options) : respondToTask(answer.id, answer.text);
  }
  return options ? dismissTask(answer.id, undefined, options) : dismissTask(answer.id);
}

const ANSWERED: Record<InboxAnswer["kind"], string> = {
  approve: "Approved",
  answer: "Answered",
  dismiss: "Dismissed",
};

/**
 * Answer one inbox row. The toast names the task and carries Undo for the
 * window; the lane call follows; a refusal comes back in `bd`'s own words and
 * the row returns.
 */
export function useInboxAnswer(): (answer: InboxAnswer) => void {
  const toast = useOwnerToast();
  const { schedule: scheduleAnswer, undo: undoAnswer } = useOwnerAnswers();
  const refresh = useTaskRefresh();
  const api = useTowerApi();
  const selected = useTaskSelection();
  return useCallback(
    (answer: InboxAnswer) => {
      // Capture the logical project before Undo/navigation can change selection.
      // The captured owner API still refuses dispatch after session retirement.
      const project = selected(answer.project);
      const captured: InboxAnswer = Object.freeze({ ...answer, project });
      const toastId = `inbox-answer-${answer.id}`;
      toast.success(ANSWERED[answer.kind], {
        id: toastId,
        description: answer.title,
        duration: UNDO_WINDOW_MS,
        action: { label: "Undo", onClick: () => undoAnswer(answer.id) },
      });
      scheduleAnswer({
        id: answer.id,
        send: (keepalive) => sendInboxAnswer(captured, keepalive, api),
        onSent: () => {
          // Undo goes the moment the call is made, even under a hovering
          // pointer that paused the toast's own timer.
          toast.dismiss(toastId);
          void refresh();
        },
        onFailed: (error) => {
          toast.dismiss(toastId);
          toast.error(error instanceof Error && error.message !== "" ? error.message : `Could not send ${answer.id}`);
        },
        onUndo: () => toast.dismiss(toastId),
      });
    },
    [refresh, api, selected, toast, scheduleAnswer, undoAnswer],
  );
}
