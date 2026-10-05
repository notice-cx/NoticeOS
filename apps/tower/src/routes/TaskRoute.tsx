import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { type ReactNode, createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Circle,
  CircleDot,
  CircleHelp,
  MessageSquare,
  Pencil,
  Plus,
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
  TASK_PROJECTS_PATH,
  type LiveEpic,
  type LiveTask,
  type TaskComment,
  type TaskDependency,
  type TaskActor,
} from "@shared/tasks";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';
import { PRIORITY_BANDS, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";
import { EmptyState } from "@/components/EmptyState";
import { Meter } from "@/components/Meter";
import { PageHeader } from "@/components/PageHeader";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { StateChip, type StateTone, type StatusSubject } from "@/components/StateChip";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fieldClass } from "@/components/ui/field";
import { refusalMessage } from "@/hooks/useConfigSave";
import { useNow } from "@/hooks/useNow";
import {
  useClaimTask,
  useCloseTask,
  useCommentOnTask,
  useTask,
  useTasks,
  useTasksLive,
  useTaskProjects,
  useUpdateTask,
} from "@/hooks/useTasks";
import { useWork } from "@/hooks/useWork";
import { ApiError, type TaskEdit } from "@/lib/api";
import { cn } from "@/lib/utils";
import { taskPath } from '@/lib/task-path';
import { useOwnerAnswers } from "@/lib/browser-context";
import { TASK_STATUSES, askVerb, inboxAsk, type InboxAsk } from "@/lib/task-board-read";
import { useAskActions } from "@/routes/tasks/ask-actions";
import { PriorityMark, TaskStatusChip, TaskStatusGlyph, priorityFace } from "@/routes/tasks/task-face";
import { taskMetadataValue, type TaskMetadataName } from "@noticeos/contract/task-metadata";

/**
 * `/tasks/:id` — one bead, whole (D19, bead `ro-l1ed.3`).
 *
 * Until this page a bead id was a monospace string the operator selected and
 * pasted into `bd show` in a terminal. Every surface that had one — a finding's
 * filing badge, a query or page decision row, an asset's timeline, the work
 * board — could name the task and then had nothing to offer. This is the page
 * those ids point at, and it is the shape a task tool is expected to have: what
 * the work is, what it is waiting on, what people have said about it, and the
 * two buttons that move it.
 *
 * THREE READS, EACH FOR A DIFFERENT REASON.
 *
 *  1. `useTask(id)` — the LIVE bead through the local lane: description,
 *     acceptance criteria, labels, dependencies, comments, handoff metadata.
 *     The page's subject. Exists only where `os:up` is serving.
 *  2. `useWork()` — the once-a-minute SNAPSHOT every deployment can serve. It
 *     is what a deployed build renders instead of an error (`live: false`), and
 *     it is also where the asset's display name comes from.
 *  3. `useTasks(project)` — the project's live board, for the two facts a
 *     single bead's own read cannot carry: what this task BLOCKS (`bd show`
 *     reports only outgoing edges) and the parent epic's all-time child
 *     progress (`bd epic status`, which the detail read does not run).
 *
 * ONE REPRESENTATION PER FACT (doc 14). Status and priority are the header's
 * glyph-led chips, so the editors in the facts panel are controls with no chip
 * of their own beside them — the control is where the value is *changed*, the
 * header is where it is *read*. The status chip, the dependency glyphs and the
 * board's State column all draw from one status face (`routes/tasks/task-face`,
 * bead `ro-ujb9.202`), so a closed blocker reads as out of the way rather than
 * as one more thing in it, and a task looks the same one click apart.
 *
 * A CLOSED TASK IS SHIPPED, NOT PROVEN (docs/playbooks/task-key-chain.md).
 * Nothing here is green and nothing says resolved: the outcome is read later in
 * a watch window carrying this bead id.
 *
 * NO PARAGRAPHS (bead `ro-ujb9.96.6.11`, doc 21 principle 3a). An empty
 * description is an "Add a description" button, not a sentence quoting the
 * `bd` flag that would fill it; a read-only build is one banner; the chips and
 * the editors carry their own state with no footnote under them.
 */
const TaskWritePermission = createContext(true);
const TaskActors = createContext<readonly TaskActor[] | undefined>(undefined);
function useFieldPermission(field: string): boolean {
  const writable = useContext(TaskWritePermission);
  return taskFieldAvailable(useTasksLive(), field) && writable;
}
function useTaskHref() {
  const [params] = useSearchParams();
  const capabilities = useTasksLive();
  const project = capabilities.projectSelection ? params.get('project') ?? undefined : undefined;
  return (id: string) => taskPath(id, project);
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

  // The board read is only worth spawning `bd` for once we know which spoke the
  // bead belongs to, which the detail read is what tells us.
  const board = useTasks(project);

  // What the snapshot alone can say — the whole page in a deployed build, and
  // the header while the live read is still in flight.
  const fromSnapshot = useMemo(() => capability.projectSelection && selectedProject === undefined ? null
    : findInSnapshot(snapshot.data, id, capability.projectSelection ? selectedProject : undefined), [snapshot.data, id, capability.projectSelection, selectedProject]);
  const spoke = fromSnapshot?.project ?? (capability.projectSelection ? null : projectByPrefix(snapshot.data, id));

  const head: HeadFacts | null = task
    ? { title: task.title, status: task.status, priority: task.priority, assignee: task.assignee, ask: inboxAsk(task) }
    : fromSnapshot
      ? {
          title: fromSnapshot.item.title,
          status: fromSnapshot.item.status,
          priority: fromSnapshot.item.priority,
          assignee: fromSnapshot.item.assignee,
          // The photograph carries no labels, but its `waiting` list is the
          // poller's own answer to "is this in the operator's inbox".
          ask: fromSnapshot.waiting ? askVerb(fromSnapshot.item) : null,
        }
      : null;

  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  const laneError = live && detail.error !== null && !notFound;

  return (
    <TaskWritePermission.Provider value={writable}>
    <TaskActors.Provider value={detail.data?.actors}>
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <Link to={returnTo} className="inline-flex min-h-11 w-fit items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" aria-hidden />
        {returnTo.startsWith("/assets/") ? "Back to site" : returnTo === "/" || returnTo.startsWith("/?") ? "Back to overview" : "Back to tasks"}
      </Link>
      <TaskHeader id={id} head={head} writable={writable} readAt={detail.data?.readAt ?? null} />
      {capability.projectSelection ? <select aria-label="Task project" value={selectedProject ?? ''}
        className={cn(fieldClass, 'w-fit max-w-full')} onChange={event => {
          const next = new URLSearchParams(params); next.set('project', event.target.value); setParams(next, { replace: true });
        }}>
        <option value="" disabled>Choose project</option>
        {(catalog.data ?? []).map(row => <option key={row.projectId} value={row.logicalKey}>{row.displayName}</option>)}
      </select> : null}

      {!live ? (
        <ReadOnly row={fromSnapshot?.item ?? null} project={spoke} />
      ) : notFound ? (
        <NotFound id={id} />
      ) : laneError ? (
        <LaneFailed error={detail.error} />
      ) : task === null ? (
        <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">
          {detail.isPending ? "Loading…" : "Waiting for the task database…"}
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
            <div className="flex min-w-0 flex-col gap-4">
              <Body task={task} />
              <Comments
                id={task.id}
                comments={detail.data?.comments ?? []}
                nowMs={now}
              />
            </div>
            <Facts
              task={task}
              project={project}
              projectName={spoke?.name ?? project ?? ""}
              epic={epicOf(board.data?.epics ?? null, task.parent)}
              blocks={blockedByThis(board.data?.tasks ?? [], task.id)}
              nowMs={now}
            />
          </div>
          <Activity task={task} comments={detail.data?.comments ?? []} nowMs={now} />
        </>
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

// ─────────────────────────────────────────────────────────────────────────────
// The header: identity, state, and the two primary actions
// ─────────────────────────────────────────────────────────────────────────────

interface HeadFacts {
  title: string;
  status: string;
  priority: number;
  assignee: string | null;
  /** What the operator's inbox asks of this task, or null when it is not
   * waiting on the operator. */
  ask: InboxAsk | null;
}

/**
 * A task waiting on the operator offers what its inbox row offers (bead
 * `ro-ujb9.243`): a human gate its one verb, Approve, and an ask Answer and
 * Dismiss — the same buttons, box and Undo (`routes/tasks/ask-actions`). Claim
 * and Close stay for everything else: claiming a gate assigned the operator to
 * a mechanism, and Close ran `bd close` instead of the command the gate or ask
 * was waiting for. Once answered, the header offers nothing until the task is
 * read again — the toast holds the Undo.
 */
function TaskHeader({
  id,
  head,
  writable,
  readAt,
}: {
  id: string;
  head: HeadFacts | null;
  writable: boolean;
  /** When the live read the page shows was taken: an answer sent after it
   * hides the verbs until the next read. */
  readAt: string | null;
}) {
  const demoReadonly = useDemoReadonly();
  const capabilities = useTasksLive();
  const [closing, setClosing] = useState(false);
  const { hides: answerHides } = useOwnerAnswers();
  const claimable = head !== null && head.status === "open" && head.assignee === null;
  const closed = head?.status === "closed";
  const blocked = writable ? null : !demoReadonly ? READ_ONLY_TASKS_HINT : DEMO_READ_ONLY;
  const answered = answerHides(id, readAt);
  const ask = useAskActions({
    ask: answered ? null : (head?.ask ?? null),
    id,
    title: head?.title ?? id,
    disabledReason: blocked ?? (taskOperationAvailable(capabilities, head?.ask === 'approve' ? 'resolve' : 'respond') ? null : 'Unavailable in this workspace.'),
    placement: "header",
  });
  const waitsOnOperator = (head?.ask ?? null) !== null;

  return (
    <PageHeader
      breadcrumb={[{ label: "Tasks", to: "/tasks" }]}
      title={
        <>
          <span className="min-w-0">{head?.title ?? "Task"}</span>
          {/* The id is beside the title, not above it: it is the string the
              operator quotes in a commit and types to `bd`, and it identifies
              this page as much as the sentence does. */}
          <span className="font-mono text-sm font-normal text-muted-foreground">{id}</span>
        </>
      }
      meta={
        head ? (
          <>
            <TaskStatusChip status={head.status} subject={`task:${id}`} />
            <PriorityChip priority={head.priority} subject={`task:${id}`} />
          </>
        ) : null
      }
      actions={
        waitsOnOperator ? (
          ask.buttons
        ) : (
          <>
            {claimable ? (
              <ClaimAction id={id} disabledReason={blocked ?? (taskFieldAvailable(capabilities, 'claim') ? null : 'Unavailable in this workspace.')} />
            ) : null}
            {closed || !head ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked !== null}
                title={blocked ?? undefined}
                onClick={() => setClosing((open) => !open)}
              >
                Close
              </Button>
            )}
          </>
        )
      }
    >
      {waitsOnOperator ? ask.box : closing ? (
        <CloseForm id={id} onDone={() => setClosing(false)} onCancel={() => setClosing(false)} />
      ) : null}
    </PageHeader>
  );
}

function ClaimAction({ id, disabledReason }: { id: string; disabledReason: string | null }) {
  const toast = useOwnerToast();
  const claim = useClaimTask();
  return (
    <Button
      type="button"
      size="sm"
      disabled={disabledReason !== null || claim.isPending}
      title={disabledReason ?? "Assign it to you and mark it in progress."}
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

/**
 * Close, with the reason in front of it rather than behind a confirm.
 *
 * The reason is REQUIRED because completion is evidence: the closer cites what
 * proves it, and a close with nothing in the box is the exact habit
 * `config/beads.README.md` exists to prevent. So the button that actually
 * writes stays disabled until there is something to write.
 */
function CloseForm({
  id,
  onDone,
  onCancel,
}: {
  id: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useOwnerToast();
  const [reason, setReason] = useState("");
  const close = useCloseTask();
  const ready = reason.trim().length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
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
          title={ready ? undefined : "A close carries its evidence — say what shipped."}
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority, on a chip — the status chip is the shared `TaskStatusChip`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Priority as the operator's word, led by the board row's own priority mark:
 * ink weight, never a severity hue (doc 14, bead `ro-ujb9.200`) — a top task is
 * not a failure. A single task page shows the default band too — on a board a
 * row saying "normal" is noise, but on the page for one task the absence of a
 * priority chip would read as a fact nobody recorded.
 */
function PriorityChip({ priority, subject }: { priority: number; subject: StatusSubject }) {
  const { band } = priorityFace(priority);
  const tone: StateTone = priority <= 2 ? "neutral" : "na";
  return (
    <StateChip
      tone={tone}
      glyph={<PriorityMark priority={priority} size="chip" />}
      label={`${band} priority`}
      title={`P${priority}`}
      subject={subject}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The left column: what the work is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE WORK IS, and both halves are editable where they are read (Linear's
 * inline description). An empty one is its own "Add" button rather than a
 * sentence quoting the `bd update --description` flag that would fill it: the
 * page runs that command, so it offers the field instead of the instruction.
 */
function Body({ task }: { task: LiveTask }) {
  const save = useFieldSave(task.id);
  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-4">
        <LongTextField
          label="Description"
          addLabel="Add a description"
          value={task.description}
          onCommit={(next) =>
            save({ label: "the description", edit: { description: next }, undo: { description: task.description } })
          }
        />
        <LongTextField
          label="Acceptance criteria"
          addLabel="Add acceptance criteria"
          value={task.acceptance}
          onCommit={(next) =>
            save({ label: "the acceptance criteria", edit: { acceptance: next }, undo: { acceptance: task.acceptance } })
          }
        />
      </CardContent>
    </Card>
  );
}

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
      ) : (
        <MarkdownText source={value} />
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The conversation, oldest first — a thread reads forward, and the composer sits
 * where the next line goes. The operator's own answers to `human` beads land
 * here, so this list is where a decision that was made in a comment stays
 * findable.
 */
function Comments({
  id,
  comments,
  nowMs,
}: {
  id: string;
  comments: TaskComment[];
  nowMs: number;
}) {
  const actors = useContext(TaskActors);
  const toast = useOwnerToast();
  const permitted = useContext(TaskWritePermission);
  const writable = taskOperationAvailable(useTasksLive(), 'comment') && permitted;
  const [draft, setDraft] = useState("");
  const comment = useCommentOnTask();
  const ready = draft.trim().length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
          Comments
          {comments.length > 0 ? (
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {comments.length}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* No comments is no list — the box below is where the first one goes,
            and the header's missing count already says there are none. */}
        {comments.length === 0 ? null : (
          <ol className="flex flex-col gap-3" data-task-comments>
            {comments.map((entry) => (
              <li key={entry.id} className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium">{taskActorLabel(entry.author, actors)}</span>
                  <Age iso={entry.createdAt} nowMs={nowMs} />
                </div>
                <MarkdownText source={entry.text} className="text-sm" />
              </li>
            ))}
          </ol>
        )}

        <div className={cn("flex flex-col gap-2", comments.length > 0 && "border-t border-border pt-3")}>
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
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The right column: the facts, most of them editable in place
// ─────────────────────────────────────────────────────────────────────────────

function Facts({
  task,
  project,
  projectName,
  epic,
  blocks,
  nowMs,
}: {
  task: LiveTask;
  project: string | null;
  projectName: string;
  epic: LiveEpic | null;
  blocks: LiveTask[];
  nowMs: number;
}) {
  const save = useFieldSave(task.id);
  const actors = useContext(TaskActors);
  const taskHref = useTaskHref();
  const blockedBy = task.dependencies.filter((dep) => dep.type !== "parent-child");
  const origin = handoffOrigin(task.metadata);
  const saveAssignee = (next: string) => save({
    label: 'assignee',
    edit: { assignee: next },
    // A new holder owns an in-progress claim. Beads refuses reversing that
    // handoff without the holder's coordination; never promise a forceful Undo.
    undo: task.status === 'in_progress' && next !== '' && next !== task.assignee
      ? undefined : { assignee: task.assignee ?? '' },
  });

  return (
    <Card className="lg:sticky lg:top-4">
      <CardContent className="flex flex-col pt-4" data-task-facts>
        {project ? (
          <Fact label="Project">
            <Link
              to={`/assets/${encodeURIComponent(project)}`}
              className="inline-flex min-w-0 items-center gap-1.5 text-sm hover:underline"
            >
              <PropertyFavicon domain={project} displayName={projectName || project} />
              <span className="truncate">{projectName || project}</span>
            </Link>
          </Fact>
        ) : null}

        <Fact label="Type">
          <span className="text-sm">{task.issueType}</span>
          {task.awaitType ? (
            <span className="ml-2 text-xs text-muted-foreground">
              waits on {task.awaitType}
            </span>
          ) : null}
        </Fact>

        <Fact label="Status">
          <SelectEditor
            name="Status"
            value={task.status}
            options={STATUS_OPTIONS}
            onCommit={(next) =>
              save({ label: "status", edit: { status: next }, undo: { status: task.status } })
            }
          />
        </Fact>

        <Fact label="Priority">
          <SelectEditor
            name="Priority"
            value={String(task.priority)}
            options={PRIORITY_BANDS.map((band, index) => ({
              value: String(index),
              label: band,
            }))}
            onCommit={(next) =>
              save({
                label: "priority",
                edit: { priority: Number(next) },
                undo: { priority: task.priority },
              })
            }
          />
        </Fact>

        <Fact label="Assignee">
          {actors === undefined ? <TextEditor
            name="Assignee"
            value={task.assignee ?? ""}
            placeholder="Nobody"
            onCommit={saveAssignee}
          /> : <SelectEditor
            name="Assignee"
            value={task.assignee ?? ""}
            options={[
              { value: '', label: 'Nobody' },
              ...actors.map(actor => ({ value: actor.principalId, label: actor.displayName.trim() || 'Unknown actor' })),
              ...(task.assignee && !actors.some(actor => actor.principalId === task.assignee)
                ? [{ value: task.assignee, label: taskActorLabel(task.assignee, actors) }] : []),
            ]}
            onCommit={saveAssignee}
          />}
        </Fact>

        <Fact label="Labels">
          <LabelsEditor
            labels={task.labels}
            onAdd={(label) =>
              save({
                label: `label ${label}`,
                edit: { addLabels: [label] },
                undo: { removeLabels: [label] },
              })
            }
            onRemove={(label) =>
              save({
                label: `label ${label}`,
                edit: { removeLabels: [label] },
                undo: { addLabels: [label] },
              })
            }
          />
        </Fact>

        {/* "Parked", the board's own word for `deferred` — so the status chip,
            the board's state column and this field name one state one way. */}
        <Fact label="Parked until">
          <DateEditor
            name="Parked until"
            value={(task.deferUntil ?? "").slice(0, 10)}
            onCommit={(next) =>
              save({
                label: "the deferral",
                edit: { defer: next },
                undo: { defer: (task.deferUntil ?? "").slice(0, 10) },
              })
            }
          />
        </Fact>

        <Fact label="Parent epic">
          {epic ? (
            <div className="flex flex-col gap-1">
              <Link
                to={taskHref(epic.id)}
                className="text-sm hover:underline"
              >
                {epic.title}
              </Link>
              {/* The epic's ALL-TIME child progress (`bd epic status`) — the only
                  honest denominator, since a list read is a window. */}
              <Meter
                value={epic.closed}
                max={epic.total}
                ariaLabel={`${epic.closed} of ${epic.total} children closed`}
              />
              <span className="text-xs tabular-nums text-muted-foreground">
                {epic.closed} of {epic.total} closed
              </span>
            </div>
          ) : task.parent ? (
            <Link
              to={taskHref(task.parent)}
              className="font-mono text-sm hover:underline"
            >
              {task.parent}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">Hangs off nothing</span>
          )}
          <div className="mt-1.5">
            <TextEditor
              name="Parent epic"
              value={task.parent ?? ""}
              placeholder="A task id, or empty to un-parent"
              mono
              onCommit={(next) =>
                save({
                  label: "the parent",
                  edit: { parent: next },
                  undo: { parent: task.parent ?? "" },
                })
              }
            />
          </div>
        </Fact>

        {blockedBy.length > 0 ? (
          <Fact label="Blocked by">
            <DependencyList items={blockedBy.map((dep) => dependencyRow(dep))} />
          </Fact>
        ) : null}

        {blocks.length > 0 ? (
          <Fact label="Blocks">
            <DependencyList
              items={blocks.map((other) => ({
                id: other.id,
                title: other.title,
                status: other.status,
              }))}
            />
          </Fact>
        ) : null}

        {origin ? <CameFrom origin={origin} /> : null}

        <Fact label="Ages">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              created <Age iso={task.createdAt} nowMs={nowMs} />
            </span>
            <span className="text-muted-foreground">
              updated <Age iso={task.updatedAt} nowMs={nowMs} />
            </span>
          </div>
        </Fact>
      </CardContent>
    </Card>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-2.5 first:pt-0 last:border-0">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Where a task came from, in the direction nobody could travel before: the
 * handoff metadata already tied a bead to the finding, query or page decision
 * that raised it (`config/beads.README.md` §Handoff metadata), and only the
 * asset page could read it. This is the same join, backwards. */
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

function DependencyList({ items }: { items: { id: string; title: string | null; status: string | null }[] }) {
  const taskHref = useTaskHref();
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item.id} className="flex min-w-0 items-start gap-1.5">
          <DependencyGlyph status={item.status} />
          <Link
            to={taskHref(item.id)}
            className="min-w-0 text-sm hover:underline"
          >
            <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
            {item.title ? <span className="ml-1.5">{item.title}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A blocker's own status, as the lifecycle glyph the board and the header
 * draw. A CLOSED blocker is the one that matters most here: it is no longer in
 * the way, and a list that could not say so would read as five things blocking
 * work that only two of them block. A list read that carried no status is its
 * own quiet question mark. */
function DependencyGlyph({ status }: { status: string | null }) {
  if (status === null) {
    return (
      <CircleHelp
        role="img"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60"
        aria-label="status unknown"
      />
    );
  }
  return <TaskStatusGlyph status={status} className="mt-0.5" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// The editors — KnobEditor's idiom: buffer a draft, Save writes it, the toast
// carries the way back (docs/15 principle 5: undo over confirm)
// ─────────────────────────────────────────────────────────────────────────────

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

function TextEditor({
  name,
  value,
  placeholder,
  mono,
  onCommit,
}: {
  name: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const writable = useFieldPermission(name === 'Title' ? 'title' : name === 'Assignee' ? 'assignee' : 'parent');
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  // The hub moved underneath us (a write from this session, a poll): the field
  // follows reality rather than holding a value typed against an older one.
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        aria-label={name}
        value={draft}
        placeholder={placeholder}
        disabled={!writable || saving}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(
          fieldClass,
          "min-w-0 flex-1",
          mono && "font-mono text-xs",
        )}
      />
      <SaveButton
        name={name}
        dirty={draft !== value}
        saving={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onCommit(draft);
          } finally {
            setSaving(false);
          }
        }}
      />
    </div>
  );
}

function SelectEditor({
  name,
  value,
  options,
  onCommit,
}: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  onCommit: (next: string) => Promise<boolean>;
}) {
  const writable = useFieldPermission(name === 'Status' ? 'status' : name === 'Assignee' ? 'assignee' : 'priority');
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);

  // `bd` accepts values this build has never heard of; a stored one outside the
  // list is offered as itself rather than silently reset by the control.
  const known = options.some((option) => option.value === value);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={name}
        value={draft}
        disabled={!writable || saving}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(fieldClass, "min-w-0 flex-1")}
      >
        {known ? null : <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <SaveButton
        name={name}
        dirty={draft !== value}
        saving={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onCommit(draft);
          } finally {
            setSaving(false);
          }
        }}
      />
    </div>
  );
}

function DateEditor({
  name,
  value,
  onCommit,
}: {
  name: string;
  value: string;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const writable = useFieldPermission('defer');
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        aria-label={name}
        value={draft}
        disabled={!writable || saving}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(fieldClass, "min-w-0")}
      />
      <SaveButton
        name={name}
        dirty={draft !== value}
        saving={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onCommit(draft);
          } finally {
            setSaving(false);
          }
        }}
      />
      {value === "" ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!writable || saving}
          onClick={async () => {
            setSaving(true);
            try {
              // The empty string is `--defer ""` — "clear this" is an edit, not
              // an absent one (the lane passes it through deliberately).
              await onCommit("");
            } finally {
              setSaving(false);
            }
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

function LabelsEditor({
  labels,
  onAdd,
  onRemove,
}: {
  labels: string[];
  onAdd: (label: string) => Promise<boolean>;
  onRemove: (label: string) => Promise<boolean>;
}) {
  const writable = useFieldPermission('addLabels');
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const value = draft.trim();
    if (value === "") return;
    setBusy(true);
    try {
      if (await onAdd(value)) setDraft("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {labels.length === 0 ? (
        <span className="text-sm text-muted-foreground">No labels</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs"
            >
              {label}
              <button
                type="button"
                aria-label={`Remove label ${label}`}
                disabled={!writable || busy}
                onClick={() => {
                  setBusy(true);
                  void onRemove(label).finally(() => setBusy(false));
                }}
                className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="Add a label"
          value={draft}
          placeholder="human, tower, ux…"
          disabled={!writable || busy}
          onChange={(event) => setDraft(event.target.value)}
          className={cn(fieldClass, "min-w-0 flex-1")}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!writable || busy || draft.trim() === ""}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/** The Save every field shares — one word, one disabled rule (nothing to
 * write), one pending label, so "did that save?" never depends on which kind of
 * field it was. Named per field so a page of them stays addressable. */
function SaveButton({
  name,
  dirty,
  saving,
  onClick,
}: {
  name: string;
  dirty: boolean;
  saving: boolean;
  onClick: () => void;
}) {
  const writable = useContext(TaskWritePermission);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Save ${name}`}
      disabled={!writable || !dirty || saving}
      onClick={onClick}
    >
      {saving ? "Saving…" : "Save"}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity timeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What happened to this bead, in `Timeline`'s grammar — a glyph node, a
 * connecting rule, a label, and a relative age with the absolute on hover.
 *
 * It is NOT the `Timeline` component: that renders `annotations` (deploy, model
 * change, incident, external), a different vocabulary over a different table,
 * and bending its `AnnotationKind` to mean "claimed" would make one component
 * answer two questions. It is one route's layout over one payload and stays
 * here until a second surface needs it (REGISTRY.md).
 *
 * Every node is DATED, and an undated fact is simply not a node: a claim with
 * no `started_at` would otherwise be dated by the last edit, quietly redating
 * history every time somebody changed a label.
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
  const events = useMemo(() => {
    const out: { key: string; at: string; icon: typeof Circle; label: string; note: string | null }[] =
      [];
    if (task.createdAt) {
      out.push({ key: "created", at: task.createdAt, icon: Circle, label: "Filed", note: null });
    }
    if (task.startedAt) {
      out.push({
        key: "claimed",
        at: task.startedAt,
        icon: CircleDot,
        label: task.assignee ? `Claimed by ${taskActorLabel(task.assignee, actors)}` : "Claimed",
        note: null,
      });
    }
    for (const entry of comments) {
      if (!entry.createdAt) continue;
      out.push({
        key: `comment-${entry.id}`,
        at: entry.createdAt,
        icon: MessageSquare,
        label: `Comment from ${taskActorLabel(entry.author, actors)}`,
        note: entry.text,
      });
    }
    if (task.closedAt) {
      out.push({
        key: "closed",
        at: task.closedAt,
        icon: Check,
        label: "Closed",
        note: task.closeReason,
      });
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [task, comments, actors]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <EmptyState title="Nothing dated yet" />
        ) : (
          <ol className="flex flex-col" data-task-activity>
            {events.map((event, index) => {
              const Icon = event.icon;
              const isLast = index === events.length - 1;
              return (
                <li key={event.key} className="flex gap-3 pb-3 last:pb-0">
                  <div className="flex flex-col items-center">
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
                      <Icon className="size-3" aria-hidden />
                    </span>
                    {isLast ? null : <span aria-hidden className="mt-1 w-px flex-1 bg-border" />}
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 pb-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{event.label}</span>
                      <Age iso={event.at} nowMs={nowMs} />
                    </div>
                    {event.note ? (
                      <span className="text-sm text-muted-foreground">{event.note}</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** Relative age with the absolute on hover (docs/15 principle 7). */
/**
 * When something on this page happened, always as a distance ("3d ago").
 *
 * ABSENCE IS A PHRASE, NOT A DASH (bead `ro-kukv.12`, doc 17 rule 6). All four
 * places this renders pair it with a word that needs it — *created*, *updated*,
 * a comment's author, a timeline event's label — so it is a labelled value slot
 * on every one of them, not the dense table cell rule 6 exempts. A bare em-dash
 * after "created" reads as a rendering failure; "created at an unknown time"
 * reads as the fact. `formatAge` keeps its own dash, for the reason
 * `shared/freshness.ts` records: fifteen call sites interpolate it as
 * "{age} ago", and a word there would read "never ago".
 *
 * ONE PHRASE, TWO TITLES, deliberately. Rule 6 asks which absence this is, and
 * here the honest answer is in the cause rather than in the word: a row with no
 * time and a time we cannot parse both mean *we do not know when*, and neither
 * is **never** — the comment was written, the task was created. So the title
 * says which and the phrase stays one thing the eye can learn.
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

// ─────────────────────────────────────────────────────────────────────────────
// The states that are not a task
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deployed build. The snapshot board is always correct to show, so the page
 * renders whatever the once-a-minute photograph holds for this id under ONE
 * Read-only banner — what happened, then what to do — rather than an error,
 * and rather than pretending an empty page is an empty task. An id the
 * photograph does not carry gets the door that could find it: its project's
 * board, or the task projects when no project uses its prefix.
 */
function ReadOnly({
  row,
  project,
}: {
  row: WorkItem | null;
  project: WorkProject | null;
}) {
  return (
    <div className="flex flex-col gap-4" data-task-readonly>
      <StatusBanner severity="info" lead="Read-only snapshot" subject="tasks:snapshot">
        {READ_ONLY_TASKS_HINT}
      </StatusBanner>
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
              <dt className="text-muted-foreground">Type</dt>
              <dd>{row.issueType}</dd>
              {row.parent ? (
                <>
                  <dt className="text-muted-foreground">Parent</dt>
                  <dd className="font-mono text-xs">{row.parent}</dd>
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
    </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The statuses `bd` ships with, in the board's own words. Not exhaustive by
 * design — `bd` supports custom statuses, and `SelectEditor` offers a stored one
 * outside this list as itself. */
const STATUS_OPTIONS = TASK_STATUSES.map((status) => ({ value: status.stored, label: status.label }));

function dependencyRow(dep: TaskDependency): { id: string; title: string | null; status: string | null } {
  return { id: dep.id, title: dep.title, status: dep.status };
}

/** What this task BLOCKS. `bd show` reports only the edges pointing OUT of a
 * bead, so the reverse direction is read off the project's board: every bead
 * that names this one as something it depends on. */
function blockedByThis(tasks: LiveTask[], id: string): LiveTask[] {
  return tasks.filter((task) =>
    task.dependencies.some((dep) => dep.id === id && dep.type !== "parent-child"),
  );
}

function epicOf(epics: LiveEpic[] | null, parent: string | null): LiveEpic | null {
  if (epics === null || parent === null) return null;
  return epics.find((epic) => epic.id === parent) ?? null;
}

function findInSnapshot(
  payload: WorkPayload | undefined,
  id: string,
  selectedProject?: string,
): { item: WorkItem; project: WorkProject; waiting: boolean } | null {
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
      if (found) return { item: found, project, waiting: list === project.waiting };
    }
  }
  return null;
}

/** The spoke a bead id belongs to, from its prefix — the half of an id that is
 * not derivable from the asset (`ex` is not example.com), which is
 * exactly why a saved task project records its prefix (Settings → Task
 * projects). */
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

/**
 * The `noticeos_*` grammar, read backwards (config/beads.README.md §Handoff
 * metadata). The kind decides which section of the asset page raised it; the
 * page routes its own hashes, so an anchor that moves is that page's problem
 * and not a broken link here.
 */
const ORIGIN_SECTIONS: Readonly<Record<string, { hash: string; what: string }>> = {
  finding: { hash: "#insights", what: "the findings" },
  query: { hash: "#query-visibility", what: "the query decisions" },
  page: { hash: "#page-decisions", what: "the page decisions" },
};

function handoffOrigin(metadata: Record<string, unknown> | null): HandoffOrigin | null {
  if (metadata === null) return null;
  // Either vintage of the handoff grammar: `noticeos_*`, or the `reindex_*` a
  // bead filed before the rename carries (packages/contract/src/task-metadata.mts).
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

// ─────────────────────────────────────────────────────────────────────────────
// Markdown, the safe subset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bead's description, acceptance criteria and comments are Markdown, written
 * by whoever filed them — an agent, the operator, a copied handoff. They have to
 * render as headings, lists and code rather than as one wall of text with
 * asterisks in it.
 *
 * NO DEPENDENCY, AND NO RAW HTML. The Tower ships no Markdown library and this
 * does not add one for a handful of block types. More importantly, the renderer
 * never builds a string of HTML: it parses into blocks and emits React
 * elements, so there is no `dangerouslySetInnerHTML` anywhere on the path and a
 * `<script>` in a bead's description is TEXT by construction rather than by a
 * sanitizer somebody has to keep correct. A link is rendered only when its href
 * is `http(s)`, `mailto:` or site-relative; anything else (a `javascript:` URL)
 * renders as the literal Markdown it was written as.
 */
export function MarkdownText({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading") {
          return (
            <h3
              key={key}
              className={cn(
                "font-semibold text-foreground",
                block.level <= 2 ? "text-base" : "text-sm",
              )}
            >
              {inline(block.text, key)}
            </h3>
          );
        }
        if (block.kind === "code") {
          return (
            <pre
              key={key}
              className="min-w-0 overflow-x-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-xs"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote
              key={key}
              className="border-l-2 border-border pl-3 text-muted-foreground"
            >
              {inline(block.text, key)}
            </blockquote>
          );
        }
        if (block.kind === "list") {
          const items = block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>
          ));
          return block.ordered ? (
            <ol key={key} className="ml-5 list-decimal space-y-0.5">
              {items}
            </ol>
          ) : (
            <ul key={key} className="ml-5 list-disc space-y-0.5">
              {items}
            </ul>
          );
        }
        return <p key={key}>{inline(block.text, key)}</p>;
      })}
    </div>
  );
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: (heading[1] ?? "#").length, text: (heading[2] ?? "").trim() });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = out[out.length - 1];
      if (last && last.kind === "quote") last.text = `${last.text} ${quote[1] ?? ""}`;
      else out.push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = bullet ? null : /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = bullet === null;
      const item = ((bullet ?? numbered)?.[1] ?? "").trim();
      const last = out[out.length - 1];
      if (last && last.kind === "list" && last.ordered === ordered) last.items.push(item);
      else out.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out;
}

/** Inline spans: code, bold, emphasis, links. Split on the token pattern so the
 * delimiters survive as their own parts, then each part becomes an element —
 * never a string of markup. */
const INLINE_TOKEN =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]*\]\([^)\s]+\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE_TOKEN).map((part, index) => {
    const key = `${keyPrefix}-i${index}`;
    if (part === "") return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (
      (part.startsWith("*") && part.endsWith("*") && part.length > 1) ||
      (part.startsWith("_") && part.endsWith("_") && part.length > 1)
    ) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const label = link[1] ?? "";
      const href = safeHref(link[2] ?? "");
      if (href === null) return <span key={key}>{part}</span>;
      if (href.startsWith("/")) {
        return (
          <Link key={key} to={href} className="underline underline-offset-2">
            {label}
          </Link>
        );
      }
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          {label}
        </a>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

/** An allowlist, not a denylist: three shapes are safe to put in an `href` and
 * everything else — `javascript:`, `data:`, a protocol-relative `//host` — is
 * not a link this page will make. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}
