import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { type CSSProperties, type ReactNode, createContext, useContext, useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  ArrowLeft,
  CircleHelp,
  Layers,
  Lock,
  Pencil,
  Plus,
  Snowflake,
  X,
} from "lucide-react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";

import { ageMs, formatAge } from "@shared/freshness";
import {
  READ_ONLY_TASKS_HINT,
  taskWritesAvailable,
  taskFieldAvailable,
  taskOperationAvailable,
  taskActorLabel,
  claimedModel,
  closeAttribution,
  TASK_PROJECTS_PATH,
  TASKS_CLOSED_WINDOW_DAYS,
  type LiveEpic,
  type LiveTask,
  type TaskComment,
  type TaskDependency,
  type TaskActor,
  type LiveTasksPayload,
} from "@shared/tasks";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';
import { PRIORITY_BANDS, type WorkEpic, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";
import { AgentMark } from "@/components/AgentMark";
import { EmptyState } from "@/components/EmptyState";
import { FactChip, factChipClass, type FactChoice } from "@/components/FactChip";
import type { PageHeaderCrumb } from "@/components/PageHeader";
import { TaskTimeline, type TaskTimelineEntry } from "@/components/TaskTimeline";
import { DependencyGraph, type DependencyNode } from "@/components/viz/DependencyGraph";
import type { FlowEdgeState } from "@/components/viz/FlowGraph";
import { PageSkeleton } from "@/components/Skeleton";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { STATE_TONE } from "@/components/StateChip";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fieldClass } from "@/components/ui/field";
import { refusalMessage } from "@/hooks/useConfigSave";
import { useNow } from "@/hooks/useNow";
import {
  useClaimTask,
  useCloseTask,
  useCommentOnTask,
  useInboxAnswer,
  useTask,
  useTasks,
  useTasksLive,
  useTaskProjects,
  useUpdateTask,
} from "@/hooks/useTasks";
import { CloseNoteForm, RESOLUTION_GLYPH, ResolutionChips } from "@/components/CloseResolution";
import { closeNote } from "@/lib/close-as";
import { TASK_RESOLUTION_LABELS, type TaskResolution } from "@noticeos/contract/task-resolution";
import { useWork } from "@/hooks/useWork";
import { ApiError, type TaskEdit } from "@/lib/api";
import { cn } from "@/lib/utils";
import { taskPath } from '@/lib/task-path';
import { useOwnerAnswers } from "@/lib/browser-context";
import { TASK_STATUSES, askVerb, inboxAsk, liveRows, snapshotRows, type BoardTask } from "@/lib/task-board-read";
import { blockerEdgeState, epicDrawsGraph, epicTaskGroups, type EpicTaskGroup } from "@/lib/task-board-viz";
import { evidenceParts } from "@/lib/agent-work";
import { formatInt } from "@/lib/format";
import { EpicProgress, EpicTaskList, epicSegments, type EpicSegment } from "@/routes/tasks/epic-tasks";
import { ChoiceSummary, ClosedSummary, TaskHead, type TaskHeadFacts } from "@/routes/tasks/task-head";
import { SectionLabel as SectionLabelRow, eyebrowClass } from "@/components/surface/SectionLabel";
import { useAskActions } from "@/routes/tasks/ask-actions";
import { PriorityMark, TaskStatusGlyph, priorityFace, statusFace } from "@/routes/tasks/task-face";
import { GuideText, MarkdownText, TaskTextRefsProvider } from "@/routes/tasks/task-markdown";
import { taskRowSaid, type TaskRowFacts } from "@/routes/tasks/task-row";
import { taskMetadataValue, type TaskMetadataName } from "@noticeos/contract/task-metadata";
import { choiceName, type TaskChoiceKey } from "@noticeos/contract/task-choices";
import { ChoiceButtons } from "@/components/ChoiceButtons";

/**
 * `/tasks/:id`: one task, whole. Three reads: `useTask(id)`, the live task;
 * `useWork()`, the once-a-minute snapshot every deployment can serve, drawn
 * where there is no live lane; `useTasks(project)`, the live board, for what
 * this task blocks (`bd show` reports only outgoing edges). A closed task is
 * shipped, not proven, so nothing here is green.
 */
const TaskWritePermission = createContext(true);
/** The read-only banner a deployed build draws under the header, which the
 * header's disabled actions name as their reason. */
const READ_ONLY_REASON_ID = "task-read-only-reason";
const TaskActors = createContext<readonly TaskActor[] | undefined>(undefined);
function useFieldPermission(field: string): boolean {
  const writable = useContext(TaskWritePermission);
  return taskFieldAvailable(useTasksLive(), field) && writable;
}
function useTaskHref() {
  const [params] = useSearchParams();
  const capabilities = useTasksLive();
  const project = capabilities.projectSelection ? params.get('project') ?? undefined : undefined;
  return useCallback((id: string) => taskPath(id, project), [project]);
}

export function TaskRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const { state } = useLocation();
  const [params, setParams] = useSearchParams();
  const selectedProject = params.get('project') ?? undefined;
  const returnTo = taskReturnPath(state);
  const capability = useTasksLive();
  const { live } = capability;
  const writable = taskWritesAvailable(capability);
  const catalog = useTaskProjects();
  const detail = useTask(id, selectedProject);
  const snapshot = useWork();
  const now = useNow();

  const task = detail.data?.task ?? null;
  const project = detail.data?.project ?? null;

  // The board read is only worth spawning `bd` for once the detail read has
  // said which spoke the task belongs to.
  const board = useTasks(project);

  // What the snapshot alone can say — the whole page in a deployed build, and
  // the header while the live read is still in flight.
  const fromSnapshot = useMemo(() => capability.projectSelection && selectedProject === undefined ? null
    : findInSnapshot(snapshot.data, id, capability.projectSelection ? selectedProject : undefined), [snapshot.data, id, capability.projectSelection, selectedProject]);
  const spoke = fromSnapshot?.project ?? (capability.projectSelection ? null : projectByPrefix(snapshot.data, id));

  // Every row of the project's live read, epics included: this task's own
  // children and its siblings come from here.
  const read = useMemo(() => (board.data ? liveRows(board.data, { containers: true }) : []), [board.data]);
  const epicView = task && board.data
    ? liveEpicView(board.data, read, task, epicOf(board.data.epics, task.id))
    : !live && fromSnapshot ? snapshotEpicView(fromSnapshot.project, id, fromSnapshot.epic) : null;
  const siblings = task?.parent ? read.filter((row) => row.parent === task.parent && row.id !== task.id) : [];
  const nextReady = epicTaskGroups(siblings, read).find((group) => group.word === "Ready")?.tasks[0] ?? null;
  const actors = detail.data?.actors;
  const taskHref = useTaskHref();
  const parentEpic = task ? epicOf(board.data?.epics ?? null, task.parent) : null;
  // This task among its siblings, on the parent's bar: the board read holds
  // every unfinished one and a week of closes; the epic's count, the rest.
  const parentSegments = task && parentEpic && parentEpic.total > 0
    ? epicSegments({
        children: [...siblings, ...(read.find((row) => row.id === task.id) ? [read.find((row) => row.id === task.id)!] : [{ ...task, project: project ?? "" }])],
        self: task.id,
        next: nextReady?.id ?? null,
        closed: parentEpic.closed,
        total: parentEpic.total,
      })
    : null;
  const blockers = task ? blockerRows(task, board.data?.tasks ?? [], actors) : [];
  const blocked = task ? blockedByThis(board.data?.tasks ?? [], task.id).map((other) => taskRowFacts(other, actors)) : [];
  const textRefs = useMemo(() => ({
    prefixes: [...new Set([detail.data?.prefix, ...(snapshot.data?.projects ?? []).map((row) => row.prefix)].filter((prefix): prefix is string => Boolean(prefix)))],
    taskHref,
    repoUrl: /^https:\/\/\S+$/.test(detail.data?.repo ?? "") ? detail.data!.repo : null,
  }), [detail.data, snapshot.data, taskHref]);

  const head: TaskHeadFacts | null = task
    ? {
        title: task.title,
        issueType: task.issueType,
        awaitType: task.awaitType,
        status: task.status,
        priority: task.priority,
        holder: task.status !== "closed" && task.assignee
          ? { name: taskActorLabel(task.assignee, actors), model: claimedModel(task), since: task.startedAt }
          : null,
        ask: inboxAsk(task),
        progress: epicView?.progress ?? null,
        choices: task.choices ?? null,
        choice: task.choice ?? null,
      }
    : fromSnapshot
      ? {
          title: fromSnapshot.item.title,
          issueType: fromSnapshot.item.issueType,
          awaitType: fromSnapshot.item.issueType === "gate" ? "human" : null,
          status: fromSnapshot.item.status,
          priority: fromSnapshot.item.priority,
          holder: fromSnapshot.item.status !== "closed" && fromSnapshot.item.assignee
            ? { name: fromSnapshot.item.assignee, model: null, since: null }
            : null,
          // The photograph carries no labels, but its `waiting` list is the
          // poller's own answer to "is this in the operator's inbox".
          ask: fromSnapshot.waiting ? askVerb(fromSnapshot.item) : null,
          progress: epicView?.progress ?? null,
          choices: fromSnapshot.item.choices ?? null,
          choice: fromSnapshot.item.choice ?? null,
        }
      : null;

  // Where the page sits: the board (with the filters it was opened from), the
  // project's tasks, and the epic it hangs off.
  const projectKey = capability.projectSelection ? selectedProject ?? null : project ?? spoke?.asset ?? null;
  const projectName = (capability.projectSelection
    ? catalog.data?.find((row) => row.logicalKey === selectedProject)?.displayName
    : spoke?.name) ?? projectKey ?? "";
  const parentId = task ? task.parent : fromSnapshot?.item.parent ?? null;
  const parentTitle = parentId === null ? null
    : epicOf(board.data?.epics ?? null, parentId)?.title
      ?? read.find((row) => row.id === parentId)?.title
      ?? fromSnapshot?.project.epics?.find((epic) => epic.id === parentId)?.title
      ?? null;
  const crumbs: PageHeaderCrumb[] = [
    { label: "Tasks", to: returnTo.startsWith("/tasks") ? returnTo : "/tasks" },
    ...(projectKey ? [{
      label: projectName,
      to: `/tasks?${new URLSearchParams({ project: projectKey })}`,
      icon: <PropertyFavicon domain={projectKey} displayName={projectName} className="size-4" />,
    }] : []),
    ...(parentId ? [{ label: parentTitle ?? parentId, to: taskHref(parentId) }] : []),
  ];

  // A decision a pick closed carries the pick as its reason; the choice under
  // the header already states it, with who chose and when.
  const closedByPick = task?.choice ? task.closeReason?.trim() === `Chose ${choiceName(task.choice.option, task.choice.label)}` : false;
  const closedSummary = task?.status === "closed"
    ? closedByPick ? null : <LiveClosedSummary task={task} nowMs={now} />
    : !live && fromSnapshot?.item.status === "closed"
      ? <SnapshotClosedSummary item={fromSnapshot.item} project={fromSnapshot.project} nowMs={now} />
      : null;

  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  const laneError = live && detail.error !== null && !notFound;

  return (
    <TaskWritePermission.Provider value={writable}>
    <TaskActors.Provider value={actors}>
    {/* Every button on the page gives under a press, as the board's rows and
        the fact chips do; under reduced motion it holds still. */}
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6 motion-safe:[&_button:not(:disabled):active]:translate-y-px" data-task-page="">
      {/* The breadcrumb leads back to the board; a page opened from Home or a
          site keeps one link back to where it was opened. */}
      {returnTo.startsWith("/tasks") ? null : (
        <Link to={returnTo} className="inline-flex min-h-11 w-fit items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft className="size-4" aria-hidden />
          {returnTo.startsWith("/assets/") ? "Back to site" : "Back to Home"}
        </Link>
      )}
      <TaskHeader id={id} head={head} crumbs={crumbs} writable={writable} readAt={detail.data?.readAt ?? null} nowMs={now}>
        {closedSummary}
      </TaskHeader>
      {capability.projectSelection ? <select aria-label="Task project" value={selectedProject ?? ''}
        className={cn(fieldClass, 'w-fit max-w-full')} onChange={event => {
          const next = new URLSearchParams(params); next.set('project', event.target.value); setParams(next, { replace: true });
        }}>
        <option value="" disabled>Choose project</option>
        {(catalog.data ?? []).map(row => <option key={row.projectId} value={row.logicalKey}>{row.displayName}</option>)}
      </select> : null}

      {!live ? (
        <ReadOnly row={fromSnapshot?.item ?? null} project={spoke} epicView={epicView} />
      ) : notFound ? (
        <NotFound id={id} />
      ) : laneError ? (
        <LaneFailed error={detail.error} />
      ) : task === null ? (
        detail.isPending ? (
          <PageSkeleton subject={`task:${id}`} shape="form" />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">
            Waiting for the task database…
          </div>
        )
      ) : (
        // A laptop reads the work on the left and its facts on the right; a
        // phone reads the facts first, in the same order the keyboard visits.
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)] lg:items-start lg:gap-6">
          <Facts
            className="lg:col-start-2 lg:row-start-1"
            task={task}
            project={project}
            projectName={spoke?.name ?? project ?? ""}
            prefix={detail.data?.prefix ?? null}
            epic={parentEpic}
            parentSegments={parentSegments}
            epics={board.data?.epics ?? []}
            people={holders(read)}
            parentTitle={parentTitle}
            nextReady={nextReady}
            nowMs={now}
          />
          <TaskTextRefsProvider value={textRefs}>
            {/* The page's one content card, its sections divided inside it;
                the facts beside it are a rail, not a second box. */}
            <Card className="viz-arrive min-w-0 divide-y divide-border/70 shadow-raised lg:col-start-1 lg:row-start-1" style={{ "--viz-i": 1 } as CSSProperties} data-task-content="">
              <Body task={task} />
              {blockers.length > 0 || blocked.length > 0 ? (
                <Dependencies task={task} blockers={blockers} blocked={blocked} />
              ) : null}
              {epicView ? <EpicTasks view={epicView} className={CONTENT_SECTION} /> : null}
              <Activity task={task} comments={detail.data?.comments ?? []} nowMs={now} />
            </Card>
          </TaskTextRefsProvider>
        </div>
      )}
    </div>
    </TaskActors.Provider>
    </TaskWritePermission.Provider>
  );
}

export default TaskRoute;

export function taskReturnPath(state: unknown): string {
  if (typeof state !== "object" || state === null || !("returnTo" in state)) return "/tasks";
  const path = state.returnTo;
  return typeof path === "string" && /^\/(?:assets(?:\/|\?|$)|tasks(?:\?|$)|\?|$)/.test(path) ? path : "/tasks";
}

// --- The header: identity, state, and the actions, the primary one first ----

/**
 * A task waiting on the operator offers its inbox row's verbs
 * (`routes/tasks/ask-actions`), never Close: that would run `bd close` instead
 * of the command the gate or ask was waiting for. An ask that carries choices
 * draws them under the header, Answer and Dismiss under them. Once answered,
 * the header offers nothing until the task is read again (a pressed option
 * stays drawn as the pick); the toast holds the Undo. A recorded pick is a
 * fact under the header from then on. Otherwise Claim leads while nobody
 * holds the task, and Close leads once somebody does; a close where nothing
 * shipped hides them the same way while its Undo window runs.
 */
function TaskHeader({
  id,
  head,
  crumbs,
  writable,
  readAt,
  nowMs,
  children,
}: {
  id: string;
  head: TaskHeadFacts | null;
  crumbs: PageHeaderCrumb[];
  writable: boolean;
  /** When the live read the page shows was taken: an answer sent after it
   * hides the verbs until the next read. */
  readAt: string | null;
  nowMs: number;
  /** What sits directly under the header: a closed task's reason. */
  children?: ReactNode;
}) {
  const demoReadonly = useDemoReadonly();
  const capabilities = useTasksLive();
  const [closing, setClosing] = useState(false);
  const { hides: answerHides } = useOwnerAnswers();
  const reasonId = useId();
  const claimable = head !== null && head.status === "open" && head.holder === null;
  const closed = head?.status === "closed";
  const blocked = writable ? null : !demoReadonly ? READ_ONLY_TASKS_HINT : DEMO_READ_ONLY;
  const answered = answerHides(id, readAt);
  const waitsOnOperator = (head?.ask ?? null) !== null;
  const choosing = head?.ask === "choose";
  const unavailable = "Unavailable in this workspace.";
  const askReason = blocked ?? (taskOperationAvailable(capabilities, head?.ask === 'approve' ? 'resolve' : 'respond') ? null : unavailable);
  const chooseReason = blocked ?? (taskOperationAvailable(capabilities, 'choose') ? null : unavailable);
  const claimReason = blocked ?? (taskFieldAvailable(capabilities, 'claim') ? null : unavailable);
  // Why the actions are disabled, as text a reader sees beside them: a hover
  // title sits over the next button and never shows on a phone. A deployed
  // build's banner under the header already says it, so the buttons point at
  // that sentence instead of repeating it.
  const reason = waitsOnOperator ? (answered ? null : choosing ? chooseReason ?? askReason : askReason)
    : closed || !head || answered ? null : claimable ? claimReason : blocked;
  const describedBy = reason === null ? undefined : capabilities.live ? reasonId : READ_ONLY_REASON_ID;
  // The option pressed, drawn as the pick while its Undo window runs.
  const [picked, setPicked] = useState<TaskChoiceKey | null>(null);
  const actors = useContext(TaskActors);
  const ask = useAskActions({
    ask: answered ? null : (head?.ask ?? null),
    id,
    title: head?.title ?? id,
    choices: head?.choices ?? null,
    disabledReason: askReason,
    chooseDisabledReason: chooseReason,
    describedBy,
    placement: "header",
    onChosen: setPicked,
  });
  const recorded = head?.choice ?? null;
  const choiceRecord = recorded ? (
    <ChoiceSummary choice={recorded} choices={head?.choices ?? null} by={taskActorLabel(recorded.by, actors)} nowMs={nowMs} />
  ) : answered && choosing && picked !== null && head?.choices ? (
    <ChoiceButtons choices={head.choices} chosen={picked} />
  ) : null;

  return (
    <TaskHead
      id={id}
      facts={head}
      crumbs={crumbs}
      nowMs={nowMs}
      actions={
        <ActionArea reason={capabilities.live ? reason : null} reasonId={reasonId}>
          {waitsOnOperator ? (
            ask.buttons
          ) : answered ? null : (
            <>
              {claimable ? (
                <ClaimAction id={id} disabledReason={claimReason} describedBy={describedBy} />
              ) : null}
              {closed || !head ? null : (
                <Button
                  type="button"
                  variant={claimable ? "outline" : "default"}
                  size="sm"
                  disabled={blocked !== null}
                  aria-describedby={blocked === null ? undefined : describedBy}
                  aria-expanded={closing}
                  data-primary-action={claimable ? undefined : ""}
                  onClick={() => setClosing((open) => !open)}
                >
                  Close
                </Button>
              )}
            </>
          )}
        </ActionArea>
      }
    >
      {children}
      {choiceRecord}
      {waitsOnOperator ? ask.box : closing && !answered ? (
        <CloseForm id={id} title={head?.title ?? id} onDone={() => setClosing(false)} onCancel={() => setClosing(false)} />
      ) : null}
    </TaskHead>
  );
}

/** The actions, primary first, with the reason they are disabled written
 * under them. */
function ActionArea({ reason, reasonId, children }: { reason: string | null; reasonId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end" data-task-actions="">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {reason ? (
        <p id={reasonId} className="m-0 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-action-reason="">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {reason}
        </p>
      ) : null}
    </div>
  );
}

function ClaimAction({ id, disabledReason, describedBy }: { id: string; disabledReason: string | null; describedBy?: string }) {
  const toast = useOwnerToast();
  const claim = useClaimTask();
  return (
    <Button
      type="button"
      size="sm"
      data-primary-action=""
      disabled={disabledReason !== null || claim.isPending}
      aria-describedby={disabledReason === null ? undefined : describedBy}
      onClick={() => {
        claim.mutate(id, {
          onSuccess: () => toast.success(`Claimed — ${id}`),
          onError: (err) => toast.error(refusalMessage(err)),
        });
      }}
    >
      {claim.isPending ? "Claiming…" : "Claim"}
    </Button>
  );
}

/** Close, with the reason in front of it rather than behind a confirm, under
 * the five ways a close ends, Done first and picked. Done is evidence: the
 * shipped line is required, so the button that writes stays disabled until
 * there is something to write, and the close is sent at once. Any other is
 * one line, a Note (and for a duplicate the other task's id), sent through
 * the Undo window as a row's close is. */
function CloseForm({
  id,
  title,
  onDone,
  onCancel,
}: {
  id: string;
  title: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useOwnerToast();
  const [resolution, setResolution] = useState<TaskResolution>("done");
  const [byKey, setByKey] = useState(false);
  const [reason, setReason] = useState("");
  const close = useCloseTask();
  const answer = useInboxAnswer();
  const ready = reason.trim().length > 0;

  return (
    <div className="flex flex-col gap-2.5" data-task-form="close">
      <ResolutionChips value={resolution} onChange={(next, key) => { setResolution(next); setByKey(key); }} />
      {resolution !== "done" ? (
        <CloseNoteForm
          key={resolution}
          id={id}
          resolution={resolution}
          named={false}
          autoFocus={!byKey}
          onCancel={onCancel}
          onSend={(input) => {
            answer({ kind: "close", id, title, resolution, ...input });
            onDone();
          }}
        />
      ) : (
      <>
      <label htmlFor={`close-${id}`} className="text-sm font-medium">
        What shipped, and the commit
      </label>
      <textarea
        id={`close-${id}`}
        aria-label="Close reason"
        rows={2}
        value={reason}
        placeholder="Landed in 1a2b3c4 — the page renders the fields and the comments."
        onChange={(event) => setReason(event.target.value)}
        className={cn(fieldClass, "w-full py-1.5")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!ready || close.isPending}
          onClick={() => {
            close.mutate(
              { id, reason: reason.trim() },
              {
                onSuccess: () => {
                  toast.success(`Closed — ${id}`);
                  onDone();
                },
                onError: (err) => toast.error(refusalMessage(err)),
              },
            );
          }}
        >
          {close.isPending ? "Closing…" : "Close task"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      </>
      )}
    </div>
  );
}

// --- The left column: what the work is --------------------------------------

/** What the work is, both halves editable where they are read. An empty one
 * is its own "Add" button: the page runs the `bd` command, so it offers the
 * field instead of the instruction. */
function Body({ task }: { task: LiveTask }) {
  const save = useFieldSave(task.id);
  return (
    <div className={cn(CONTENT_SECTION, "gap-6")}>
      <LongTextField
        label="Description"
        addLabel="Add a description"
        value={task.description}
        onCommit={(next) =>
          save({ label: "the description", edit: { description: next }, undo: { description: task.description } })
        }
      />
      <LongTextField
        // The board's word for the same field (TasksBoard's "Done when").
        label="Done when"
        addLabel="Add when it is done"
        value={task.acceptance}
        onCommit={(next) =>
          save({ label: "the acceptance criteria", edit: { acceptance: next }, undo: { acceptance: task.acceptance } })
        }
      />
    </div>
  );
}

/** One section of the page's one content card; the card draws the dividers. */
const CONTENT_SECTION = "flex min-w-0 flex-col gap-3 p-4 md:p-5";

/** One Markdown field, read in place and edited in place: the rendered text
 * with a quiet Edit beside its eyebrow, or — when there is none — one Add
 * button where the text would be. Save writes and toasts an Undo, the same
 * contract as every field in the facts column. */
function LongTextField({
  label,
  addLabel,
  value,
  onCommit,
}: {
  label: string;
  addLabel: string;
  value: string;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const writable = useFieldPermission(label === 'Description' ? 'description' : 'acceptance');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const empty = value.trim() === "";
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  return (
    <section className="flex min-w-0 flex-col gap-2" data-task-field={label}>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {!empty && !editing ? (
          <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${label.toLowerCase()}`} disabled={!writable} onClick={() => setEditing(true)}>
            <Pencil aria-hidden /> Edit
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={label}
            rows={6}
            autoFocus
            value={draft}
            disabled={!writable || saving}
            onChange={(event) => setDraft(event.target.value)}
            className={cn(fieldClass, "w-full py-1.5 font-mono text-xs")}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!writable || saving || draft.trim() === value.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  if (await onCommit(draft.trim())) setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!writable || saving}
              onClick={() => {
                setDraft(value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : empty ? (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={!writable} onClick={() => setEditing(true)}>
          <Plus aria-hidden /> {addLabel}
        </Button>
      ) : label === "Description" ? (
        <GuideText source={value} />
      ) : (
        <MarkdownText source={value} checklist />
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <span className={eyebrowClass}>{children}</span>;
}

// --- What happened, and the next comment --------------------------------------

/**
 * Filing, the claim, every comment and the close on one time axis that ends
 * at now, then the same moments in order with who did each, and the box for
 * the next comment last. Every moment is dated, and an undated fact is not a
 * moment: a claim with no `started_at` would otherwise be dated by the last
 * edit. A comment nobody dated is still listed, last, and says so.
 */
function Activity({
  task,
  comments,
  nowMs,
}: {
  task: LiveTask;
  comments: TaskComment[];
  nowMs: number;
}) {
  const actors = useContext(TaskActors);
  const entries = useMemo(() => {
    const out: TaskTimelineEntry[] = [];
    if (task.createdAt) out.push({ id: "filed", at: task.createdAt, kind: "filed", label: "Filed", said: "Filed" });
    if (task.startedAt) {
      const name = task.assignee ? taskActorLabel(task.assignee, actors) : null;
      const model = claimedModel(task);
      out.push({
        id: "claimed",
        at: task.startedAt,
        kind: "claimed",
        who: name ? { name, model } : null,
        label: name ? <>Claimed by <b className="font-semibold">{name}</b>{model ? <span className="text-muted-foreground"> · {model}</span> : null}</> : "Claimed",
        said: name ? `Claimed by ${name}${model ? ` · ${model}` : ""}` : "Claimed",
      });
    }
    for (const entry of comments) {
      const name = taskActorLabel(entry.author, actors);
      out.push({
        id: `comment-${entry.id}`,
        at: entry.createdAt,
        kind: "comment",
        who: { name, model: null },
        label: <>Comment from <b className="font-semibold">{name}</b></>,
        said: `Comment from ${name}`,
        body: <MarkdownText source={entry.text} />,
      });
    }
    if (task.closedAt) {
      const closer = closeAttribution(task);
      const name = closer ? taskActorLabel(closer.by, actors) : null;
      const resolution = task.resolution ?? "done";
      // "Closed", or "Closed as Won't do" when nothing shipped; a duplicate names the other task.
      const closedAs = resolution === "done" ? "Closed"
        : `Closed as ${TASK_RESOLUTION_LABELS[resolution]}${task.duplicateOf ? ` of ${task.duplicateOf}` : ""}`;
      // The reason's sentence is the body; its commits and links are chips.
      const note = closeNote(task.closeReason, resolution, task.duplicateOf ?? null);
      const sentence = note ? evidenceParts(note).filter((part) => part.kind === "text").map((part) => part.text).join(" · ") : "";
      out.push({
        id: "closed",
        at: task.closedAt,
        kind: "closed",
        who: name ? { name, model: closer?.model ?? null } : null,
        label: name ? <>{closedAs} by <b className="font-semibold">{name}</b>{closer?.model ? <span className="text-muted-foreground"> · {closer.model}</span> : null}</> : closedAs,
        said: name ? `${closedAs} by ${name}${closer?.model ? ` · ${closer.model}` : ""}` : closedAs,
        body: sentence ? <MarkdownText source={sentence} /> : undefined,
        evidence: note,
        ...(resolution === "done" ? {} : { glyph: RESOLUTION_GLYPH[resolution], mark: "note" as const }),
      });
    }
    return out;
  }, [task, comments, actors]);

  return (
    <section className={CONTENT_SECTION} data-task-activity-section="">
      <SectionLabelRow title="Activity" caption={comments.length > 0 ? `${formatInt(comments.length)} ${comments.length === 1 ? "comment" : "comments"}` : undefined} />
      <TaskTimeline
        entries={entries}
        nowMs={nowMs}
        age={(at) => <Age iso={at} nowMs={nowMs} />}
        composer={<CommentBox id={task.id} />}
        ariaLabel="What happened to this task"
      />
    </section>
  );
}

/** The next comment. The operator's own answers to `human` tasks land in the
 * timeline above it. */
function CommentBox({ id }: { id: string }) {
  const toast = useOwnerToast();
  const permitted = useContext(TaskWritePermission);
  const writable = taskOperationAvailable(useTasksLive(), 'comment') && permitted;
  const [draft, setDraft] = useState("");
  const comment = useCommentOnTask();
  const ready = draft.trim().length > 0;

  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Add a comment"
        disabled={!writable}
        rows={2}
        value={draft}
        placeholder="What you found, decided, or need."
        onChange={(event) => setDraft(event.target.value)}
        className={cn(fieldClass, "w-full py-1.5")}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!writable || !ready || comment.isPending}
          onClick={() => {
            comment.mutate(
              { id, text: draft.trim() },
              {
                onSuccess: () => {
                  toast.success("Comment added");
                  setDraft("");
                },
                onError: (err) => toast.error(refusalMessage(err)),
              },
            );
          }}
        >
          {comment.isPending ? "Sending…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

// --- The right column: the facts, each drawn as its value and edited in place

function Facts({
  className,
  task,
  project,
  projectName,
  prefix,
  epic,
  epics,
  people,
  parentTitle,
  parentSegments,
  nextReady,
  nowMs,
}: {
  className?: string;
  task: LiveTask;
  project: string | null;
  projectName: string;
  /** The project's task id prefix, the hint for a typed parent id. */
  prefix: string | null;
  epic: LiveEpic | null;
  /** The project's open epics, offered as parents. */
  epics: readonly LiveEpic[];
  /** Who holds work in this project, offered as assignees where the read
   * carries no member list. */
  people: readonly string[];
  /** The parent's title from the board read, when it is not an epic the
   * board's progress read covers. */
  parentTitle: string | null;
  /** This task among its siblings, as the parent's bar draws them. */
  parentSegments: readonly EpicSegment[] | null;
  /** The first sibling ready to be claimed. */
  nextReady: BoardTask | null;
  nowMs: number;
}) {
  const save = useFieldSave(task.id);
  const actors = useContext(TaskActors);
  const taskHref = useTaskHref();
  const origin = handoffOrigin(task.metadata);
  const can = {
    status: useFieldPermission("status"),
    priority: useFieldPermission("priority"),
    assignee: useFieldPermission("assignee"),
    parent: useFieldPermission("parent"),
    labels: useFieldPermission("addLabels"),
    defer: useFieldPermission("defer"),
  };
  const saveAssignee = (next: string) => save({
    label: 'assignee',
    edit: { assignee: next },
    // A new holder owns an in-progress claim. `bd` refuses reversing that
    // handoff without the holder's coordination; never promise a forceful Undo.
    undo: task.status === 'in_progress' && next !== '' && next !== task.assignee
      ? undefined : { assignee: task.assignee ?? '' },
  });
  const status = statusFace(task.status);
  const StatusIcon = status.icon;
  const band = priorityFace(task.priority).band;
  const holder = task.assignee ? taskActorLabel(task.assignee, actors) : null;
  const model = task.assignee ? claimedModel(task) : null;
  const parked = (task.deferUntil ?? "").slice(0, 10);
  const parentName = epic?.title ?? parentTitle ?? task.parent;

  return (
    <aside
      aria-label="Facts"
      className={cn("viz-arrive min-w-0 px-1 max-lg:border-b max-lg:border-border/70 max-lg:pb-4 lg:border-s lg:border-border/70 lg:ps-5", className)}
      style={{ "--viz-i": 2 } as CSSProperties}
    >
        {/* A phone reads the facts as one wrapped row under the header; a
            laptop as a rail beside the work. */}
        <dl className="m-0 flex flex-wrap gap-x-5 gap-y-3 lg:flex-col lg:flex-nowrap lg:gap-0" data-task-facts>
          {project ? (
            <Fact label="Project">
              <FactChip label="Project" valueText={projectName || project} to={`/assets/${encodeURIComponent(project)}`}>
                <PropertyFavicon domain={project} displayName={projectName || project} className="size-4" />
                {projectName || project}
              </FactChip>
            </Fact>
          ) : null}

          <Fact label="Parent epic" wide>
            <FactChip
              label="Parent epic"
              valueText={parentName ?? "Hangs off nothing"}
              to={task.parent ? taskHref(task.parent) : undefined}
              quiet={!task.parent}
              readOnly={!can.parent}
              editor={{
                kind: "choice",
                value: task.parent ?? "",
                choices: [
                  ...epics.filter((row) => row.id !== task.id && row.status !== "closed").map((row) => ({
                    value: row.id, label: row.title, mark: <Layers className="size-3.5 text-muted-foreground" />,
                  })),
                  { value: "", label: "No epic" },
                ],
                other: { label: "Another task id", placeholder: prefix ? `${prefix}-…` : "A task id", mono: true },
              }}
              onSave={(next) => save({ label: "the parent", edit: { parent: next }, undo: { parent: task.parent ?? "" } })}
            >
              {task.parent ? <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
              <span className={cn(!epic && !parentTitle && task.parent && "font-mono")}>{parentName ?? "Hangs off nothing"}</span>
            </FactChip>
            {task.parent ? (
              <div className="flex basis-full flex-col gap-1.5 pt-0.5">
                {/* The epic's all-time child progress (`bd epic status`): the only
                    honest denominator, since a list read is a window. */}
                {epic ? <EpicProgress closed={epic.closed} total={epic.total} segments={parentSegments} /> : null}
                {nextReady ? (
                  <span className="text-xs text-muted-foreground" data-next-ready={nextReady.id}>
                    {/* The dot the bar marks this task with. */}
                    <span aria-hidden className="me-1.5 inline-block size-1 rounded-full bg-foreground align-middle" />
                    Next ready:{" "}
                    <Link to={taskHref(nextReady.id)} className="text-foreground underline-offset-4 hover:underline">
                      <span className="font-mono">{nextReady.id}</span> {nextReady.title}
                    </Link>
                  </span>
                ) : null}
              </div>
            ) : null}
          </Fact>

          <Fact label="Status">
            <FactChip
              label="Status"
              valueText={status.label}
              readOnly={!can.status}
              editor={{ kind: "choice", value: task.status, choices: STATUS_CHOICES }}
              onSave={(next) => save({ label: "status", edit: { status: next }, undo: { status: task.status } })}
            >
              <StatusIcon aria-hidden className={cn("size-3.5 shrink-0", STATE_TONE[status.tone].text)} />
              <span className={STATE_TONE[status.tone].text}>{status.label}</span>
            </FactChip>
          </Fact>

          <Fact label="Priority">
            <FactChip
              label="Priority"
              valueText={band}
              readOnly={!can.priority}
              editor={{ kind: "choice", value: String(task.priority), choices: PRIORITY_CHOICES }}
              onSave={(next) => save({ label: "priority", edit: { priority: Number(next) }, undo: { priority: task.priority } })}
            >
              <PriorityMark priority={task.priority} size="chip" hint={false} />
              {band}
            </FactChip>
          </Fact>

          <Fact label="Assignee">
            <FactChip
              label="Assignee"
              valueText={holder ?? "Nobody"}
              quiet={holder === null}
              readOnly={!can.assignee}
              editor={{
                kind: "choice",
                value: task.assignee ?? "",
                choices: assigneeChoices(task.assignee, actors, people),
                // A member list is the whole of who can hold a hosted task;
                // a local one takes any name an agent goes by.
                other: actors === undefined ? { label: "Someone else", placeholder: "A name or an agent" } : undefined,
              }}
              onSave={saveAssignee}
            >
              {holder ? <AgentMark name={holder} models={[model]} size="small" /> : null}
              <span>{holder ?? "Nobody"}</span>
              {holder && model ? <span className="font-normal text-muted-foreground">· {model}</span> : null}
            </FactChip>
          </Fact>

          <Fact label="Labels" wide>
            <Labels
              labels={task.labels}
              writable={can.labels}
              onAdd={(label) => save({ label: `label ${label}`, edit: { addLabels: [label] }, undo: { removeLabels: [label] } })}
              onRemove={(label) => save({ label: `label ${label}`, edit: { removeLabels: [label] }, undo: { addLabels: [label] } })}
            />
          </Fact>

          {/* "Parked", the board's own word for `deferred` — so the status chip,
              the board's state column and this fact name one state one way. */}
          <Fact label="Parked until">
            <FactChip
              label="Parked until"
              valueText={parked === "" ? "Not parked" : calendarDay(parked, nowMs)}
              quiet={parked === ""}
              readOnly={!can.defer}
              editor={{ kind: "date", value: parked, presets: parkPresets(nowMs), clearLabel: "Not parked" }}
              // The empty string is `--defer ""`: clearing is an edit, not an
              // absent one (the lane passes it through deliberately).
              onSave={(next) => save({ label: "the deferral", edit: { defer: next }, undo: { defer: parked } })}
            >
              {parked === "" ? null : <Snowflake aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="tabular-nums">{parked === "" ? "Not parked" : calendarDay(parked, nowMs)}</span>
            </FactChip>
          </Fact>

          {origin ? <CameFrom origin={origin} /> : null}

          <Fact label="Ages">
            <span className="text-xs text-muted-foreground">
              created <Age iso={task.createdAt} nowMs={nowMs} />
            </span>
            <span aria-hidden className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">
              updated <Age iso={task.updatedAt} nowMs={nowMs} />
            </span>
          </Fact>
        </dl>
    </aside>
  );
}

/** One fact: its eyebrow and its value, side by side on a laptop. A wide fact
 * takes the whole row when the facts wrap on a phone. */
function Fact({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 lg:grid lg:grid-cols-[6.5rem_minmax(0,1fr)] lg:items-baseline lg:gap-x-3",
        "lg:border-b lg:border-border/70 lg:py-2.5 lg:first:pt-0 lg:last:border-0 lg:last:pb-0",
        wide && "basis-full",
      )}
    >
      <dt className={eyebrowClass}>{label}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

/** Labels as chips, each with its own remove, and one more chip that adds. */
function Labels({
  labels,
  writable,
  onAdd,
  onRemove,
}: {
  labels: string[];
  writable: boolean;
  onAdd: (label: string) => Promise<boolean>;
  onRemove: (label: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {labels.length === 0 && !writable ? <span className="text-xs text-muted-foreground">No labels</span> : null}
      {labels.map((label) => (
        <span key={label} className={cn(factChipClass, "gap-1 font-normal", writable && "pe-1")} data-task-label={label}>
          {label}
          {writable ? (
            <button
              type="button"
              aria-label={`Remove label ${label}`}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onRemove(label).finally(() => setBusy(false));
              }}
              className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-sm:size-8"
            >
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </span>
      ))}
      {writable ? (
        <FactChip
          label="Add a label"
          valueText=""
          quiet
          className="border-dashed"
          editor={{ kind: "text", value: "", inputLabel: "New label", placeholder: "human, tower, ux…" }}
          onSave={(label) => onAdd(label)}
        >
          <Plus aria-hidden className="size-3.5 shrink-0" />
          Label
        </FactChip>
      ) : null}
    </>
  );
}

/** Where a task came from: the handoff metadata ties a task to the finding,
 * query or page decision that raised it, and this is that join, backwards. */
function CameFrom({ origin }: { origin: HandoffOrigin }) {
  return (
    <Fact label="Came from">
      <div className="flex flex-col gap-1">
        <Link to={origin.to} className="text-sm hover:underline">
          {origin.what} on {origin.asset}
        </Link>
        <span className="break-words font-mono text-xs text-muted-foreground" title={origin.key}>
          {origin.rule ? `${origin.rule} · ` : ""}
          {origin.key}
        </span>
      </div>
    </Fact>
  );
}

/**
 * Who blocks whom, drawn: what this task waits on to its left, what waits on
 * it to its right, each card in its task's own status glyph, because a closed
 * blocker is no longer in the way and a drawing that could not say so would
 * read as five things blocking work that only two of them block.
 */
function Dependencies({ task, blockers, blocked }: { task: LiveTask; blockers: TaskRowFacts[]; blocked: TaskRowFacts[] }) {
  const taskHref = useTaskHref();
  const node = (row: TaskRowFacts, edge: FlowEdgeState): DependencyNode => ({
    id: row.id,
    title: row.title,
    mark: row.status === null
      ? <CircleHelp role="img" className="size-3.5 shrink-0 text-muted-foreground/60" aria-label="State — unknown" />
      : <TaskStatusGlyph status={row.status} />,
    said: taskRowSaid(row),
    href: taskHref(row.id),
    edge,
  });
  return (
    <section className={CONTENT_SECTION} data-task-dependencies="">
      <DependencyGraph
        subject={{ id: task.id, caption: "This task", mark: <TaskStatusGlyph status={task.status} /> }}
        before={blockers.map((row) => node(row, blockerEdgeState(row.status)))}
        after={blocked.map((row) => node(row, blockerEdgeState(task.status)))}
        beforeLabel="Blocked by"
        afterLabel="Blocks"
        ariaLabel={`What ${task.id} waits on and what waits on it`}
      />
    </section>
  );
}

// --- Saving a fact: one write, and the toast carries the way back -----------

type FieldSave = (input: { label: string; edit: TaskEdit; undo?: TaskEdit }) => Promise<boolean>;

function useFieldSave(id: string): FieldSave {
  const toast = useOwnerToast();
  const writable = useContext(TaskWritePermission);
  const update = useUpdateTask();
  return useCallback<FieldSave>(
    async ({ label, edit, undo }) => {
      if (!writable) return false;
      try {
        await update.mutateAsync({ id, edit });
      } catch (err) {
        toast.error(refusalMessage(err));
        return false;
      }
      if (undo === undefined) {
        toast.success(`Saved — ${label}`);
        return true;
      }
      toast.success(`Saved — ${label}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await update.mutateAsync({ id, edit: undo });
              } catch (err) {
                toast.error(refusalMessage(err));
                return;
              }
              toast.success(`Reverted — ${label}`);
            })();
          },
        },
      });
      return true;
    },
    [id, update, writable],
  );
}

/**
 * When something on this page happened, as a distance ("3d ago") with the
 * absolute on hover. Absence is a phrase, not a dash: every place this renders
 * pairs it with a word ("created"), and a bare em-dash after it reads as a
 * rendering failure. A row with no time and a time we cannot parse both mean
 * "we do not know when", so the phrase is one thing and the title says which.
 */
function Age({ iso, nowMs }: { iso: string | null; nowMs: number }) {
  const ms = ageMs(nowMs, iso);
  if (ms === null) {
    const unreadable = iso !== null;
    return (
      <span
        className="text-xs text-muted-foreground"
        data-age={unreadable ? "unreadable" : "missing"}
        title={
          unreadable
            ? "The stored timestamp could not be read"
            : "No time is recorded for this"
        }
      >
        at an unknown time
      </span>
    );
  }
  return (
    <span className="text-xs tabular-nums text-muted-foreground" title={iso ?? undefined} data-age="aged">
      {formatAge(ms)} ago
    </span>
  );
}

// --- The states that are not a task -----------------------------------------

/**
 * A deployed build: the page renders whatever the once-a-minute snapshot holds
 * for this id under one Read-only banner. An id the snapshot does not carry
 * gets the door that could find it: its project's board, or the task projects
 * when no project uses its prefix.
 */
function ReadOnly({
  row,
  project,
  epicView,
}: {
  row: WorkItem | null;
  project: WorkProject | null;
  epicView: EpicView | null;
}) {
  const parent = row?.parent ? project?.epics?.find((epic) => epic.id === row.parent) ?? null : null;
  return (
    <div className="flex flex-col gap-4" data-task-readonly>
      <div id={READ_ONLY_REASON_ID}>
        <StatusBanner severity="info" lead="Read-only snapshot" subject="tasks:snapshot">
          {READ_ONLY_TASKS_HINT}
        </StatusBanner>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          {row === null ? (
            project ? (
              <EmptyState
                title="Not in the saved snapshot"
                hint={<DoorLink to={`/tasks?project=${encodeURIComponent(project.asset)}`}>{`Open ${project.name} tasks`}</DoorLink>}
              />
            ) : (
              <EmptyState
                title="No project uses this prefix"
                hint={<DoorLink to={TASK_PROJECTS_PATH}>Task projects</DoorLink>}
              />
            )
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Assignee</dt>
              <dd>{row.assignee ?? "nobody"}</dd>
              {row.parent ? (
                <>
                  <dt className="text-muted-foreground">Parent</dt>
                  {parent ? (
                    <dd className="flex flex-col gap-1">
                      <span>{parent.title}</span>
                      {parent.total > 0 ? <EpicProgress closed={parent.closed} total={parent.total} /> : null}
                    </dd>
                  ) : (
                    <dd className="font-mono text-xs">{row.parent}</dd>
                  )}
                </>
              ) : null}
              {row.deferUntil ? (
                <>
                  <dt className="text-muted-foreground">Parked until</dt>
                  <dd className="tabular-nums">{row.deferUntil.slice(0, 10)}</dd>
                </>
              ) : null}
            </dl>
          )}
        </CardContent>
      </Card>
      {epicView ? <EpicTasks view={epicView} /> : null}
    </div>
  );
}

/** A closed task's evidence from the live read: the closer NoticeOS recorded
 * for this close, and the reason. */
function LiveClosedSummary({ task, nowMs }: { task: LiveTask; nowMs: number }) {
  const actors = useContext(TaskActors);
  const closer = closeAttribution(task);
  const resolution = task.resolution ?? "done";
  const note = closeNote(task.closeReason, resolution, task.duplicateOf ?? null);
  return (
    <ClosedSummary by={closer ? taskActorLabel(closer.by, actors) : null} model={closer?.model ?? null} at={task.closedAt} nowMs={nowMs}
      resolution={resolution} duplicate={task.duplicateOf ? <TaskIdLink id={task.duplicateOf} /> : null}>
      {note ? (
        <MarkdownText source={note} />
      ) : resolution === "done" ? (
        <span className="text-sm text-muted-foreground">No close reason recorded</span>
      ) : null}
    </ClosedSummary>
  );
}

/** The same from the saved snapshot, whose recent closes carry their evidence. */
function SnapshotClosedSummary({ item, project, nowMs }: { item: WorkItem; project: WorkProject; nowMs: number }) {
  const close = project.recentWork?.find((event) => event.kind === "closed" && event.taskId === item.id) ?? null;
  const resolution = item.resolution ?? close?.resolution ?? "done";
  const note = close?.evidence ? closeNote(close.evidence, resolution, item.duplicateOf ?? null) : null;
  return (
    <ClosedSummary by={close?.by ?? null} model={close?.model ?? null} at={close?.at ?? item.closedAt} nowMs={nowMs}
      resolution={resolution} duplicate={item.duplicateOf ? <TaskIdLink id={item.duplicateOf} /> : null}>
      {note ? (
        <MarkdownText source={note} />
      ) : resolution === "done" ? (
        <span className="text-sm text-muted-foreground">Close reason not in the saved snapshot</span>
      ) : null}
    </ClosedSummary>
  );
}

/** Another task's id as a link to its page, in the project this page reads. */
function TaskIdLink({ id }: { id: string }) {
  const href = useTaskHref();
  return (
    <Link to={href(id)} className="font-mono text-xs text-foreground underline underline-offset-4 hover:text-primary" data-task-duplicate-of={id}>
      {id}
    </Link>
  );
}

/** The epic's task list, opening each task the way every link on this page
 * does. */
function EpicTasks({ view, className }: { view: EpicView; className?: string }) {
  const taskHref = useTaskHref();
  return (
    <EpicTaskList
      groups={view.groups}
      missing={view.missing}
      graphHref={view.graphHref}
      taskHref={taskHref}
      // Inside the content card a section; on its own (a deployed build) a card.
      frame={className ? "none" : "card"}
      className={className}
    />
  );
}

/** A dead end's one way out, as a link rather than a sentence about it. */
function DoorLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="inline-flex min-h-11 items-center font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0">
      {children} →
    </Link>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <EmptyState title="No task with this id" hint={<span className="font-mono">{id}</span>} />
      </CardContent>
    </Card>
  );
}

/** The lane answered, and it answered with a refusal. `bd`'s own stderr comes
 * back in `detail`, so it is shown rather than swallowed — the sentence is
 * usually the whole diagnosis. */
function LaneFailed({ error }: { error: Error | null }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <EmptyState
          title="The task database could not answer"
          hint={error ? refusalMessage(error) : "No reason came back."}
        />
      </CardContent>
    </Card>
  );
}

// --- Pure helpers -----------------------------------------------------------

/** The statuses `bd` ships with, in the board's own words and glyphs. Not
 * exhaustive by design — `bd` supports custom statuses, and the fact's editor
 * offers a stored one outside this list as itself. */
const STATUS_CHOICES: FactChoice[] = TASK_STATUSES.map((status) => {
  const face = statusFace(status.stored);
  const Icon = face.icon;
  return { value: status.stored, label: status.label, mark: <Icon className={cn("size-3.5", STATE_TONE[face.tone].text)} /> };
});

const PRIORITY_CHOICES: FactChoice[] = PRIORITY_BANDS.map((band, index) => ({
  value: String(index),
  label: band,
  mark: <PriorityMark priority={index} size="chip" hint={false} />,
}));

/** Who a task can be given to: a hosted workspace's members, else the names
 * that hold work in this project; the current holder always, and nobody. */
function assigneeChoices(current: string | null, actors: readonly TaskActor[] | undefined, people: readonly string[]): FactChoice[] {
  const named = actors === undefined
    ? people.map((name) => ({ value: name, label: name }))
    : actors.map((actor) => ({ value: actor.principalId, label: actor.displayName.trim() || "Unknown actor" }));
  const held = current && !named.some((choice) => choice.value === current)
    ? [{ value: current, label: taskActorLabel(current, actors) }] : [];
  return [
    ...[...named, ...held].map((choice) => ({ ...choice, mark: <AgentMark name={choice.label} size="small" /> })),
    { value: "", label: "Nobody" },
  ];
}

/** A calendar day in local time, `YYYY-MM-DD`, the form `--defer` takes. */
function localDay(ms: number, addDays = 0): string {
  const at = new Date(ms);
  at.setDate(at.getDate() + addDays);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The days a task is most often parked until. */
function parkPresets(nowMs: number): { label: string; value: string }[] {
  return [
    { label: "Tomorrow", value: localDay(nowMs, 1) },
    { label: "In a week", value: localDay(nowMs, 7) },
    { label: "In a month", value: localDay(nowMs, 30) },
  ];
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** `2026-10-20` as "Oct 20", with the year when it is not this one. */
function calendarDay(day: string, nowMs: number): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  const at = new Date(year, month - 1, date);
  return (year === new Date(nowMs).getFullYear() ? DAY_FORMAT : DAY_YEAR_FORMAT).format(at);
}

/** A task as a row: who holds open work, and the model they named. */
function taskRowFacts(task: LiveTask, actors: readonly TaskActor[] | undefined): TaskRowFacts {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    holder: task.status !== "closed" && task.assignee
      ? { name: taskActorLabel(task.assignee, actors), model: claimedModel(task) }
      : null,
  };
}

/** What this task waits on: its own read names each edge, and the board
 * read, where it holds the other task, adds its priority and holder. */
function blockerRows(task: LiveTask, known: readonly LiveTask[], actors: readonly TaskActor[] | undefined): TaskRowFacts[] {
  return task.dependencies
    .filter((dep) => dep.type !== "parent-child")
    .map((dep: TaskDependency) => {
      const other = known.find((row) => row.id === dep.id);
      return other ? taskRowFacts(other, actors) : { id: dep.id, title: dep.title, status: dep.status };
    });
}

/** Who holds work in a project's read, each name once. */
function holders(rows: readonly BoardTask[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.assignee ? [row.assignee] : [])))].sort((a, b) => a.localeCompare(b));
}

/** What this task blocks. `bd show` reports only the edges pointing out of a
 * task, so the reverse direction is read off the project's board. */
function blockedByThis(tasks: LiveTask[], id: string): LiveTask[] {
  return tasks.filter((task) =>
    task.dependencies.some((dep) => dep.id === id && dep.type !== "parent-child"),
  );
}

function epicOf(epics: LiveEpic[] | null, parent: string | null): LiveEpic | null {
  if (epics === null || parent === null) return null;
  return epics.find((epic) => epic.id === parent) ?? null;
}

/** The snapshot's lists leave epics out; its epic rollup carries them. */
function findInSnapshot(
  payload: WorkPayload | undefined,
  id: string,
  selectedProject?: string,
): { item: WorkItem; project: WorkProject; waiting: boolean; epic: WorkEpic | null } | null {
  if (!payload) return null;
  for (const project of payload.projects) {
    if (selectedProject !== undefined && project.asset !== selectedProject) continue;
    const lists = [
      project.waiting,
      project.ready,
      project.inProgress,
      project.deferred,
      project.recentlyClosed,
    ];
    for (const list of lists) {
      const found = list.find((item) => item.id === id);
      if (found) return { item: found, project, waiting: list === project.waiting, epic: null };
    }
    const epic = project.epics?.find((row) => row.id === id);
    if (epic) {
      return {
        item: {
          id: epic.id, title: epic.title, status: epic.status, priority: epic.priority, issueType: "epic",
          assignee: null, updatedAt: null, closedAt: null, parent: null, deferUntil: null,
        },
        project,
        waiting: false,
        epic,
      };
    }
  }
  return null;
}

/** An epic's place on its own page: its tasks by state, its closed of total,
 * the tasks the read leaves out, and the board's graph when it draws one. */
interface EpicView {
  groups: EpicTaskGroup[];
  /** Closed of total, and, from the live read, each task as a segment. */
  progress: { closed: number; total: number; segments?: readonly EpicSegment[] } | null;
  missing: string | null;
  graphHref: string | null;
}

/** From the live read. Every unfinished task is in it; closed ones only from
 * the closed window, so the epic's all-time count names the rest. */
function liveEpicView(payload: LiveTasksPayload, read: BoardTask[], task: LiveTask, epic: LiveEpic | null): EpicView | null {
  const children = read.filter((row) => row.parent === task.id);
  if (task.issueType !== "epic" && children.length === 0) return null;
  const earlier = epic ? Math.max(0, epic.total - children.length) : 0;
  const count = epic && epic.total > 0
    ? { closed: epic.closed, total: epic.total }
    : children.length > 0 ? { closed: children.filter((row) => row.status === "closed").length, total: children.length } : null;
  const groups = epicTaskGroups(children, read);
  return {
    groups,
    progress: count === null ? null : {
      ...count,
      segments: epicSegments({ children, next: groups.find((group) => group.word === "Ready")?.tasks[0]?.id ?? null, ...count }),
    },
    missing: earlier === 0 ? null
      : `${formatInt(earlier)} ${children.length > 0 ? "more" : earlier === 1 ? "task" : "tasks"}, closed over ${TASKS_CLOSED_WINDOW_DAYS} days ago`,
    graphHref: epic && epicDrawsGraph(liveRows(payload), task.id) ? `/tasks?epic=${encodeURIComponent(task.id)}` : null,
  };
}

/** From the saved snapshot: its capped lists name some of the epic's tasks,
 * and its waiting list, not labels, says which ask for the operator. */
function snapshotEpicView(project: WorkProject, id: string, epic: WorkEpic | null): EpicView | null {
  const rows = snapshotRows(project);
  const children = rows.filter((row) => row.parent === id);
  if (epic === null && children.length === 0) return null;
  const asks = new Set(project.waiting.map((item) => item.id));
  const unlisted = Math.max(0, (epic?.total ?? children.length) - children.length);
  return {
    groups: epicTaskGroups(children, rows, (row) => (asks.has(row.id) ? askVerb(row) : null)),
    progress: epic && epic.total > 0 ? { closed: epic.closed, total: epic.total } : null,
    missing: unlisted === 0 ? null
      : `${formatInt(unlisted)} ${children.length > 0 ? "more" : unlisted === 1 ? "task" : "tasks"} not in the saved snapshot`,
    graphHref: null,
  };
}

/** The spoke a task id belongs to, from its prefix, which is not derivable
 * from the asset and is why a saved task project records it. */
function projectByPrefix(payload: WorkPayload | undefined, id: string): WorkProject | null {
  const prefix = id.split("-")[0] ?? "";
  if (prefix === "") return null;
  return payload?.projects.find((project) => project.prefix === prefix) ?? null;
}

interface HandoffOrigin {
  asset: string;
  what: string;
  key: string;
  rule: string;
  to: string;
}

/** The `noticeos_*` handoff grammar, read backwards. The kind decides which
 * section of the asset page raised it; the page routes its own hashes. */
const ORIGIN_SECTIONS: Readonly<Record<string, { hash: string; what: string }>> = {
  finding: { hash: "#insights", what: "the findings" },
  query: { hash: "#query-visibility", what: "the query decisions" },
  page: { hash: "#page-decisions", what: "the page decisions" },
};

function handoffOrigin(metadata: Record<string, unknown> | null): HandoffOrigin | null {
  if (metadata === null) return null;
  // Either vintage of the handoff grammar, `noticeos_*` or `reindex_*`
  // (packages/contract/src/task-metadata.mts).
  const text = (field: TaskMetadataName) => {
    const value = taskMetadataValue(metadata, field);
    return typeof value === "string" ? value : "";
  };
  const asset = text("asset").trim();
  if (asset === "") return null;
  const kind = text("kind");
  const section = ORIGIN_SECTIONS[kind];
  return {
    asset,
    what: section?.what ?? "the site page",
    key: text("key"),
    rule: text("rule"),
    to: `/assets/${encodeURIComponent(asset)}${section?.hash ?? ""}`,
  };
}

