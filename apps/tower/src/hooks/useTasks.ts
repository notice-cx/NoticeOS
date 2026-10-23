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
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { LiveTaskDetail, LiveTasksPayload, TasksCapabilities, TaskProject } from "@shared/tasks";
import { choiceName, type TaskChoiceKey } from "@noticeos/contract/task-choices";
import { TASK_RESOLUTION_LABELS, type TaskResolution } from "@noticeos/contract/task-resolution";
import { chooseOnTask, closeTask, dismissTask, resolveGate, respondToTask, type CloseTaskOptions, type NewTask, type TaskEdit, type TowerApi } from "@/lib/api";

/** A close where nothing shipped. */
type NotDone = Exclude<TaskResolution, "done">;
import { UNDO_WINDOW_MS } from "@/lib/answer-queue";
import { closeAsReason } from "@/lib/close-as";
import { taskPath } from "@/lib/task-path";
import { useOwnerAnswers } from "@/lib/browser-context";
import { useOwnerMutation as useMutation } from '@/lib/browser-context';

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
export function useTasksLiveRead() {
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

/** One task and its comments, by id; the project comes from the id's prefix. */
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
 * from the same snapshot, and the asset page, whose rows carry the
 * `HandoffBeadBadge` for the task just filed or closed. The badge itself still
 * arrives on the poller's own cadence; this buys the refetch, not the row.
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
    mutationFn: ({ id, reason, project, resolution, duplicateOf }: { id: string; reason: string; project?: string } & Pick<CloseTaskOptions, "resolution" | "duplicateOf">) => {
      const ownerProject = selected(project);
      const options: CloseTaskOptions = {
        ...(ownerProject === undefined ? {} : { project: ownerProject }),
        ...(resolution === undefined || resolution === "done" ? {} : { resolution }),
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
      };
      return Object.keys(options).length === 0 ? closeTask(id, reason) : closeTask(id, reason, options);
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
 * The inbox's answers, approve a gate, answer an ask, pick one of its
 * choices, decline it, and a close where nothing shipped, each one call on the
 * lane: `bd gate resolve`, an answer, a pick, `bd human dismiss`, a close with
 * its resolution. Each is one press on its row, the row leaves at once, and
 * the call is made when the Undo window closes (`lib/answer-queue.ts`),
 * because none has an inverse the lane can run. An answer or a pick closes a
 * decision and hands any other task back to ready work with the human label
 * off; either way the task leaves the inbox, so each invalidates everything a
 * close does.
 */
export type InboxAnswer = (
  | { kind: "approve"; id: string; title: string }
  | { kind: "answer"; id: string; title: string; text: string }
  | { kind: "choose"; id: string; title: string; option: TaskChoiceKey; label?: string; note?: string }
  | { kind: "dismiss"; id: string; title: string }
  /** A close where nothing shipped, held by the same Undo window. A question
   * waiting on the operator is declined (`dismiss`) with the resolution; any
   * other task is closed with it. */
  | { kind: "close"; id: string; title: string; resolution: NotDone; note?: string; duplicateOf?: string; via?: "dismiss" }
) & { readonly project?: string };

/** The lane call for one answer. Only the page-leaving flush passes
 * `keepalive`. */
export function sendInboxAnswer(answer: InboxAnswer, keepalive = false,
  api: Pick<TowerApi, 'resolveGate' | 'respondToTask' | 'chooseOnTask' | 'dismissTask' | 'closeTask'> = { resolveGate, respondToTask, chooseOnTask, dismissTask, closeTask }): Promise<void> {
  const { resolveGate, respondToTask, chooseOnTask, dismissTask, closeTask } = api;
  const options = keepalive || answer.project !== undefined
    ? { ...(keepalive ? { keepalive: true } : {}), ...(answer.project === undefined ? {} : { project: answer.project }) } : undefined;
  if (answer.kind === "close") {
    const other = answer.duplicateOf === undefined ? {} : { duplicateOf: answer.duplicateOf };
    if (answer.via !== "dismiss") return closeTask(answer.id, closeAsReason(answer), { ...options, resolution: answer.resolution, ...other });
    // A plain Won't do is the dismissal it always was; another resolution rides with it.
    const note = answer.note?.trim() ? answer.note.trim() : undefined;
    const ended = { ...options, ...(answer.resolution === "wont-do" ? {} : { resolution: answer.resolution }), ...other };
    return Object.keys(ended).length > 0 ? dismissTask(answer.id, note, ended) : note === undefined ? dismissTask(answer.id) : dismissTask(answer.id, note);
  }
  if (answer.kind === "approve") {
    return options ? resolveGate(answer.id, undefined, options) : resolveGate(answer.id);
  }
  if (answer.kind === "answer") {
    return options ? respondToTask(answer.id, answer.text, options) : respondToTask(answer.id, answer.text);
  }
  if (answer.kind === "choose") {
    return options ? chooseOnTask(answer.id, answer.option, answer.note, options) : chooseOnTask(answer.id, answer.option, answer.note);
  }
  return options ? dismissTask(answer.id, undefined, options) : dismissTask(answer.id);
}

const ANSWERED: Record<InboxAnswer["kind"], string> = {
  approve: "Approved",
  answer: "Answered",
  choose: "Chosen",
  dismiss: "Dismissed",
  close: "Closed",
};

/** The toast's heading for one answer: a pick names its option and a close
 * its resolution, so Undo is offered against what was sent. */
function answeredAs(answer: InboxAnswer): string {
  if (answer.kind === "choose" && answer.label !== undefined) return `Chose ${choiceName(answer.option, answer.label)}`;
  if (answer.kind === "close") return `Closed as ${TASK_RESOLUTION_LABELS[answer.resolution]}`;
  return ANSWERED[answer.kind];
}

/** How many task ids a message names before it counts the rest. */
const NAMED = 3;
let batches = 0;

/** "ex-1, ex-2, ex-3 and 4 more". */
function nameIds(ids: readonly string[]): string {
  const more = ids.length > NAMED ? ` and ${ids.length - NAMED} more` : "";
  return `${ids.slice(0, NAMED).join(", ")}${more}`;
}

/** A toast's Open: the page of the one task it names. A toast that already
 * carries Undo keeps that as its one action. */
export function useOpenTaskAction(): (id: string, project?: string) => { label: string; onClick: () => void } {
  const navigate = useNavigate();
  return useCallback((id: string, project?: string) => ({ label: "Open", onClick: () => navigate(taskPath(id, project)) }), [navigate]);
}

/** The batch toast's heading: what was done and to how many, a close naming
 * its one resolution ("Closed as Won't do · 4"). */
function answeredMany(answers: readonly InboxAnswer[]): string {
  const first = answers[0]!;
  if (first.kind === "close") return `Closed as ${TASK_RESOLUTION_LABELS[first.resolution]} · ${answers.length}`;
  return `${ANSWERED[first.kind]} ${answers.length}`;
}

/**
 * Answer several inbox rows in one action, each with the call one row's own
 * press makes: one toast, one Undo for all of them, the calls one at a time
 * once the window closes, and one refresh when the last has settled. A row
 * whose call is refused returns, and the failure names it. Every answer in a
 * batch is the same verb, and a batch of closes has one resolution.
 * `closedAlready` names the selected tasks the action left out because they
 * were closed when it was taken.
 */
export function useInboxAnswers(): (answers: readonly InboxAnswer[], options?: { closedAlready?: readonly string[] }) => void {
  const toast = useOwnerToast();
  const { schedule: scheduleAnswer, undoGroup } = useOwnerAnswers();
  const refresh = useTaskRefresh();
  const api = useTowerApi();
  const selected = useTaskSelection();
  const open = useOpenTaskAction();
  return useCallback(
    (answers: readonly InboxAnswer[], { closedAlready = [] }: { closedAlready?: readonly string[] } = {}) => {
      const kinds = new Set(answers.map((answer) => answer.kind));
      const resolutions = new Set(answers.map((answer) => (answer.kind === "close" ? answer.resolution : null)));
      if (answers.length === 0 || kinds.size !== 1 || resolutions.size !== 1) return;
      batches += 1;
      const group = `inbox-batch-${batches}`;
      const titles = answers.length === 1 ? answers[0]!.title : `${answers[0]!.title} and ${answers.length - 1} more`;
      toast.success(answeredMany(answers), {
        id: group,
        description: closedAlready.length === 0 ? titles : `${titles} · ${nameIds(closedAlready)} closed already`,
        duration: UNDO_WINDOW_MS,
        action: { label: "Undo", onClick: () => undoGroup(group) },
      });
      const failed: { id: string; project: string | undefined; error: unknown }[] = [];
      let settled = 0;
      let undone = false;
      const settle = () => {
        settled += 1;
        if (settled < answers.length) return;
        toast.dismiss(group);
        void refresh();
        if (failed.length === 0) return;
        const reason = failed[0]!.error instanceof Error && failed[0]!.error.message !== "" ? failed[0]!.error.message : undefined;
        toast.error(`Not sent: ${nameIds(failed.map((entry) => entry.id))}`, {
          ...(reason === undefined ? {} : { description: reason }),
          ...(failed.length === 1 ? { action: open(failed[0]!.id, failed[0]!.project) } : {}),
        });
      };
      for (const answer of answers) {
        const captured: InboxAnswer = Object.freeze({ ...answer, project: selected(answer.project) });
        scheduleAnswer({
          id: answer.id,
          group,
          send: (keepalive) => sendInboxAnswer(captured, keepalive, api),
          onSent: settle,
          onFailed: (error) => { failed.push({ id: answer.id, project: captured.project, error }); settle(); },
          onUndo: () => {
            if (undone) return;
            undone = true;
            toast.dismiss(group);
          },
        });
      }
    },
    [refresh, api, selected, toast, scheduleAnswer, undoGroup, open],
  );
}

/**
 * Answer one inbox row. The toast names the task and carries Undo for the
 * window; the lane call follows; a refusal comes back in `bd`'s own words and
 * the row returns.
 */
export function useInboxAnswer(): (answer: InboxAnswer) => void {
  const toast = useOwnerToast();
  const { schedule: scheduleAnswer, undoGroup } = useOwnerAnswers();
  const refresh = useTaskRefresh();
  const api = useTowerApi();
  const selected = useTaskSelection();
  const open = useOpenTaskAction();
  return useCallback(
    (answer: InboxAnswer) => {
      // Capture the logical project before Undo/navigation can change selection.
      // The captured owner API still refuses dispatch after session retirement.
      const project = selected(answer.project);
      const captured: InboxAnswer = Object.freeze({ ...answer, project });
      // An exiting toast must never share the next answer's Undo lifecycle.
      const toastId = `inbox-answer-${crypto.randomUUID()}`;
      toast.success(answeredAs(answer), {
        id: toastId,
        description: answer.title,
        duration: UNDO_WINDOW_MS,
        action: { label: "Undo", onClick: () => undoGroup(toastId) },
      });
      scheduleAnswer({
        id: answer.id,
        group: toastId,
        send: (keepalive) => sendInboxAnswer(captured, keepalive, api),
        onSent: () => {
          // Undo goes the moment the call is made, even under a hovering
          // pointer that paused the toast's own timer.
          toast.dismiss(toastId);
          void refresh();
        },
        onFailed: (error) => {
          toast.dismiss(toastId);
          toast.error(error instanceof Error && error.message !== "" ? error.message : `Could not send ${answer.id}`, { action: open(answer.id, project) });
        },
        onUndo: () => toast.dismiss(toastId),
      });
    },
    [refresh, api, selected, toast, scheduleAnswer, undoGroup, open],
  );
}
