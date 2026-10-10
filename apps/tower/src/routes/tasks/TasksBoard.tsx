import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { READ_ONLY_TASKS_HINT, TASK_PROJECTS_PATH, taskWritesAvailable, taskActorLabel } from "@shared/tasks";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';
import {
  PRIORITY_BANDS,
  WORK_POLL_CADENCE_HOURS,
  priorityLabel,
} from "@shared/work";
import { ageMs, formatAge } from "@shared/freshness";
import { AgeBadge } from "@/components/AgeBadge";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { EmptyState } from "@/components/EmptyState";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ReadFailed } from "@/components/ReadFailed";
import { TaskComposer } from "@/components/TaskComposer";
import { FilterBar } from "@/components/surface/FilterBar";
import { FinishLine } from "@/components/surface/FinishLine";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillControlClass } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/useNow";
import {
  useClaimTask,
  useCloseTask,
  useTasksLive,
  useUpdateTask,
} from "@/hooks/useTasks";
import { useOwnerAnswers } from "@/lib/browser-context";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { PARKED, TASK_STATUSES, askVerb, isGate, type BoardTask, type BoardProject } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";
import { taskPath } from '@/lib/task-path';
import { taskFieldAvailable, taskOperationAvailable } from '@shared/tasks';
import { useAskActions } from "./ask-actions";
import { PriorityMark, RestingMark, TaskStatusMark, askFace } from "./task-face";

/**
 * The task board: `/tasks` across every project, an asset's Tasks tab with
 * `project` fixed. Paged, not virtualised: find-in-page reaches every rendered
 * row and a deep link never depends on a scroll offset. Rows come from the
 * live task database, else the once-a-minute snapshot (heads with counts).
 */

/** Rows per press: about 1,050px, which keeps the page inside its budget. */
const PAGE_ROWS = 25;
/** The inbox opens at five rows and discloses the rest through `ListPanel`'s
 * own expander. The page does not slice first: a panel that silently keeps
 * five of nine is lying about the size of the queue. */
const INBOX_ROWS = 5;


/** Location state that opens the board's composer without changing the URL. */
const COMPOSE_STATE = "newTask";

function composeRequested(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[COMPOSE_STATE] === true;
}

/**
 * File a task. The press opens the board's composer in place through location
 * state, not the query string, so the page does not change under the operator;
 * `?new=1` still opens it, so filing against a site can be sent as a link. On
 * an asset's Tasks tab `data-new-task-project` carries the pinned project.
 * Disabled without the live read, with what to do on hover.
 */
export function NewTaskButton({ project = null }: { project?: string | null }) {
  const demoReadonly = useDemoReadonly();
  const enabled = taskWritesAvailable(useTasksLive());
  const location = useLocation();
  const navigate = useNavigate();
  return (<>
    <Button
      type="button"
      disabled={!enabled}
      onClick={() => {
        const kept = typeof location.state === "object" && location.state !== null ? location.state : {};
        // `replace`: opening the composer is not a place the Back button should
        // have to walk through, the same rule the filters follow.
        navigate({ pathname: location.pathname, search: location.search }, {
          replace: true,
          state: { ...kept, [COMPOSE_STATE]: true },
        });
      }}
      data-new-task
      data-new-task-project={project ?? undefined}
    >
      New task
    </Button>
    {!enabled ? <InfoTooltip label="Why New task is unavailable">
      {!demoReadonly ? READ_ONLY_TASKS_HINT : DEMO_READ_ONLY}
    </InfoTooltip> : null}
  </>);
}

export interface TasksBoardProps {
  /**
   * Scope the board to one project, the asset id the projects file maps to a
   * repository. `null` (the default) is every project. A scoped board drops
   * what the page around it already says: the project control, the project
   * column and the project name on each inbox row.
   */
  project?: string | null;
  /**
   * Draw the board's own **New task** button above the filters. The index
   * leaves this off because its page header carries the page's one primary
   * action; a tab panel has no header of its own, so there the board draws it.
   */
  newTask?: boolean;
}

export function TasksBoard({ project: scope = null, newTask = false }: TasksBoardProps) {
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [shown, setShown] = useState(PAGE_ROWS);

  const scoped = scope !== null;

  // A scoped board's project comes from the route rather than the query
  // string, so it survives a Clear and cannot be widened from inside an asset.
  const projectFilter = scoped ? scope : (params.get("project") ?? "all");
  const statusFilter = params.get("status") ?? "all";
  const priorityFilter = params.get("priority") ?? "all";
  const labelFilter = params.get("label") ?? "";
  const assigneeFilter = params.get("assignee") ?? "all";
  const location = useLocation();
  const navigate = useNavigate();
  const composing = params.get("new") === "1" || composeRequested(location.state);

  // Narrowing the board starts it again at the first page.
  const filterKey = [projectFilter, statusFilter, priorityFilter, labelFilter, assigneeFilter].join("|");
  useEffect(() => {
    setShown(PAGE_ROWS);
  }, [filterKey]);

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    // A default never occupies the query string: one view, one link.
    if (value === "all" || value === "") next.delete(name);
    else next.set(name, value);
    // `replace`: Back should leave Tasks, not walk every control touched.
    setParams(next, { replace: true });
  }

  /** Closing drops whichever of the two opened it, and keeps the filters. */
  function closeComposer() {
    const next = new URLSearchParams(params);
    next.delete("new");
    const kept = typeof location.state === "object" && location.state !== null
      ? Object.fromEntries(Object.entries(location.state).filter(([key]) => key !== COMPOSE_STATE))
      : null;
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true, state: kept });
  }

  const queryClient = useQueryClient();
  const {
    data, scopeKey, isError, error, isFetching, refetch, live, spokes, projects, allTasks, shownAt,
    statusCounts, priorityCounts, assigneeCounts, projectCounts, rows, inbox: read,
    totals: readTotals, pendingProjects, counts: readCounts, countsComplete, missingProjects, byId, broken,
    closedHistoryState,
  } = useTaskBoard(scope, {
    project: projectFilter, status: statusFilter, priority: priorityFilter,
    label: labelFilter, assignee: assigneeFilter,
  });

  // An answered row leaves at once: out of the list and the count while its
  // Undo window runs, and until a read taken after the answer says what the
  // hub now holds.
  const { hides: answerHides } = useOwnerAnswers();
  const inbox = read.filter(({ project, task }) => !answerHides(task.id, project.readAt));
  const answered = read.length - inbox.length;
  const totals = { ...readTotals, waiting: Math.max(0, readTotals.waiting - answered) };
  const counts = { ...readCounts, waiting: readCounts.waiting === null ? null : Math.max(0, readCounts.waiting - answered) };
  const gates = inbox.filter(({ task }) => isGate(task)).length;

  // A pinned project is not a narrowing the operator can clear, so it does not
  // put the Clear link on screen and does not count as one.
  const narrowed =
    (!scoped && projectFilter !== "all") ||
    statusFilter !== "all" ||
    priorityFilter !== "all" ||
    labelFilter !== "" ||
    assigneeFilter !== "all";

  /** A count that is missing a project is a lower bound, `12+`. `—` is a count
   * the read cannot bound at all: nothing measured it, or no project was read. */
  const anyRead = missingProjects < projects.length;
  const bounded = (complete: number | null, observed: number | null) =>
    complete ?? (observed === null || !anyRead ? "—" : `${observed}+`);
  // One answer first: what waits on you, in a sentence, with the three counts
  // that change what you do next beside it.
  const waitingCount = bounded(counts.waiting, totals.waiting);
  const nothingWaits = totals.waiting === 0 && countsComplete;
  const answer = (
    <PageAnswer
      answer={nothingWaits ? "Nothing waits on you" : waitingCount === "—" ? "Couldn't read what waits on you" : `${waitingCount} ${totals.waiting === 1 && countsComplete ? "decision waits" : "decisions wait"} on you`}
      detail={gates > 0 ? `${gates} ${gates === 1 ? "needs" : "need"} your approval` : undefined}
      figures={[
        { label: "Urgent", value: String(bounded(counts.urgent, totals.urgent)), mark: "tasks-urgent" },
        { label: "Blocked", value: String(bounded(counts.blocked, totals.blocked)), mark: "tasks-blocked" },
        { label: "Closed this week", value: String(!countsComplete ? bounded(null, totals.closed) : (counts.closed ?? "—")), mark: "tasks-closed" },
      ]}
      marks={{ "data-tasks-answer": nothingWaits ? "clear" : "waiting" }}
    />
  );

  const panel = nothingWaits && inbox.length === 0 ? null : (
    <div data-waiting-list className="contents">
    <ListPanel
      title="Waiting on you"
      count={
        totals.waiting === 0
          ? undefined
          : `${totals.waiting}${countsComplete ? "" : "+"} ${totals.waiting === 1 ? "ask" : "asks"}`
      }
      limit={INBOX_ROWS}
      empty={countsComplete ? "Nothing is waiting on you." : "Waiting work is unknown for unread projects."}
      // No ring: every row in here already leads with a toned glyph, and the
      // panel is a place, not what is urgent.
    >
      {/* No row opens on arrival: `ListRow` reads `defaultExpanded` once, at
          mount, and this panel mounts on the snapshot and is then reordered by
          the live read, so the row that ends up first would be whichever one
          happened to mount first. */}
      {inbox.map(({ project, task }) => (
        <InboxRow
          key={task.id}
          project={project}
          task={task}
          actionable={project.actionable}
          nowMs={now}
          showProject={!scoped}
        />
      ))}
    </ListPanel>
    {/* A list the eye can finish. */}
    {inbox.length > 0 && countsComplete ? <FinishLine line="That's everything waiting on you." age={shownAt ? `read ${formatAge(ageMs(now, shownAt))} ago` : null} /> : null}
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-3.5" data-tasks-board={scope ?? "all"}>
      {newTask ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <NewTaskButton project={scopeKey} />
        </div>
      ) : null}

      {/* Read-only is said once, here, rather than on every disabled control.
          A read-only board is the saved snapshot. */}
      <div data-tasks-readonly={live ? undefined : ""}>
        <StatusBanner open={!live} severity="info" lead="Read-only snapshot" subject="tasks:snapshot">
          {READ_ONLY_TASKS_HINT}
        </StatusBanner>
      </div>

      {/* One composer, two ways in: New task (location state) and `?new=1`
          (a link). It inherits the project the board is showing and nothing
          else. Closing drops whichever opened it and keeps the filters. */}
      {composing ? (
        <TaskComposer
          open
          onClose={closeComposer}
          prefill={projectFilter === "all" ? null : { project: scopeKey ?? projectFilter }}
          projects={spokes}
        />
      ) : null}

      {!data ? (
        // No board and nothing pending is a failed read, and it says so with
        // the shared state Home, Sites and Alerts draw.
        isError ? (
          <ReadFailed title="Couldn't load tasks" subject="read:tasks" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">Loading…</div>
        )
      ) : spokes.length === 0 ? (
        // Missing projects are a setup/read problem, never proof of no tasks.
        !scoped ? <TaskHubUnavailable /> : <div className="rounded-[10px] border border-border bg-card p-4" data-tasks-unwired>
          <EmptyState
            title="No task project for this site"
            hint={<EmptyAction to={TASK_PROJECTS_PATH}>Add a task project</EmptyAction>}
          />
        </div>
      ) : (
        <>
          {/* The first screen: how big is the queue, and what in it cannot
              move without you. The board marks it, scoped or not, because only
              the board knows where its answer ends. */}
          <div data-surface-hero className="flex flex-col gap-3.5">
            {answer}
            {panel}
          </div>

          <Filters
            live={live}
            scoped={scoped}
            projects={projects}
            projectCounts={projectCounts}
            statusCounts={statusCounts}
            closedHistoryState={closedHistoryState}
            priorityCounts={priorityCounts}
            assigneeCounts={assigneeCounts}
            value={{
              project: projectFilter,
              status: statusFilter,
              priority: priorityFilter,
              label: labelFilter,
              assignee: assigneeFilter,
            }}
            narrowed={narrowed}
            age={
              <>
                {/* A local read still arriving: the saved rows show meanwhile,
                    without actions, and this mark is the whole of the notice. */}
                {live && pendingProjects.length > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    data-task-history-status="loading"
                    data-status-for="tasks:projects"
                    role="status"
                  >
                    <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
                    Loading
                  </span>
                ) : null}
                {shownAt ? <AgeBadge iso={shownAt} cadenceHours={WORK_POLL_CADENCE_HOURS} nowMs={now} /> : null}
              </>
            }
            onPick={setParam}
          />

          {/* One banner for projects that could not be read: which, and a way
              to try again. Their rows stay on the board from the saved
              snapshot, without actions; the counts carry a `+`. */}
          <StatusBanner
            open={broken.length > 0}
            subject="tasks:projects"
            severity="warn"
            lead={`${broken.length} ${broken.length === 1 ? "project" : "projects"} could not be read`}
            action={live ? { label: "Retry", onClick: () => void queryClient.invalidateQueries({ queryKey: ["tasks"] }) } : undefined}
          >
            <span data-lane-error>
              {broken.map((project, index) => (
                <span key={project.asset}>
                  {index > 0 ? ", " : ""}
                  <InfoTooltip label={`${project.name}: task read failed`} trigger={project.name}>
                    {project.laneError ?? project.error}
                  </InfoTooltip>
                </span>
              ))}
            </span>
          </StatusBanner>


          <Board
            rows={rows}
            shown={shown}
            onMore={() => setShown((count) => count + PAGE_ROWS)}
            total={allTasks.length}
            narrowed={narrowed}
            projects={byId}
            nowMs={now}
            showProject={!scoped}
            countsComplete={countsComplete}
          />
        </>
      )}

    </div>
  );
}

/** The local read hands back `bd`'s own stderr in `detail`, and
 * `ApiError.message` is that sentence; never a sentence written here over it. */
function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message !== "") return err.message;
  return fallback;
}

// --- Filters: the state is the URL, so a narrowed board is a link -----------

interface FilterValue {
  project: string;
  status: string;
  priority: string;
  label: string;
  assignee: string;
}

/**
 * Five controls, one row, every one of them
 * `?project=&status=&priority=&label=&assignee=`. Selects rather than chip
 * rows, because the counts are already stated above; each option carries its
 * own. A scoped board drops the project control: a select offering one option
 * cannot change anything.
 */
function Filters({
  live,
  scoped,
  projects,
  projectCounts,
  statusCounts,
  closedHistoryState,
  priorityCounts,
  assigneeCounts,
  value,
  narrowed,
  age,
  onPick,
}: {
  live: boolean;
  scoped: boolean;
  projects: BoardProject[];
  projectCounts: Map<string, number>;
  statusCounts: Map<string, number>;
  closedHistoryState: "complete" | "loading" | "sample";
  priorityCounts: Map<string, number>;
  assigneeCounts: Map<string, number>;
  value: FilterValue;
  narrowed: boolean;
  age: ReactNode;
  onPick: (name: string, value: string) => void;
}) {
  const assignees = [...assigneeCounts.keys()].sort();
  const assigneeNames = new Map<string, string>();
  for (const project of projects) for (const task of project.tasks) {
    if (task.assignee) assigneeNames.set(task.assignee, taskActorLabel(task.assignee, task.actors));
  }
  // What the fold's one press carries on a phone: how many of these are
  // narrowing the board now.
  const active = [scoped ? "all" : value.project, value.status, value.priority, value.assignee].filter((pick) => pick !== "all").length
    + (value.label === "" ? 0 : 1);
  return (
    <FilterBar
      active={active}
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
      marks={{ "data-tasks-filters": "" }}
      // How old the board is: a fact about the list, never folded.
      aside={age ? <span className="ms-auto inline-flex items-center gap-2">{age}</span> : null}
    >
      {/* One project is not a choice; a link that already narrows keeps its
          select so it can be cleared. */}
      {scoped || (projects.length < 2 && value.project === "all") ? null : (
        <>
          <label className="sr-only" htmlFor="tasks-project">
            Project
          </label>
          <select
            id="tasks-project"
            className={fieldClass}
            value={value.project}
            onChange={(event) => onPick("project", event.target.value)}
          >
            <option value="all">Every project</option>
            {projects.map((project) => (
              <option key={project.asset} value={project.asset}>
                {project.name} · {projectCounts.get(project.asset) ?? 0}
              </option>
            ))}
          </select>
        </>
      )}

      <label className="sr-only" htmlFor="tasks-status">
        Status
      </label>
      <select
        id="tasks-status"
        className={cn(fieldClass, "w-48")}
        value={value.status}
        onChange={(event) => onPick("status", event.target.value)}
        data-tasks-filter="status"
      >
        <option value="all">Any status</option>
        {TASK_STATUSES.map((status) => (
          <option key={status.key} value={status.key}>
            {status.key === "closed" ? "Closed this week" : status.label} ·{" "}
            {status.key === "closed" && closedHistoryState !== "complete"
              ? "—"
              : (statusCounts.get(status.key) ?? 0)}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="tasks-priority">
        Priority
      </label>
      <select
        id="tasks-priority"
        className={fieldClass}
        value={value.priority}
        onChange={(event) => onPick("priority", event.target.value)}
        data-tasks-filter="priority"
      >
        <option value="all">Any priority</option>
        {PRIORITY_BANDS.map((band) => (
          <option key={band} value={band}>
            {band} · {priorityCounts.get(band) ?? 0}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="tasks-assignee">
        Assignee
      </label>
      <select
        id="tasks-assignee"
        className={fieldClass}
        value={value.assignee}
        onChange={(event) => onPick("assignee", event.target.value)}
      >
        <option value="all">Anyone</option>
        {assignees.map((name) => (
          <option key={name} value={name}>
            {assigneeNames.get(name) ?? name} · {assigneeCounts.get(name) ?? 0}
          </option>
        ))}
      </select>

      {/* The saved snapshot carries no labels, so a read-only board offers no
          label filter — a field that can never match is not drawn. One that a
          link already set stays, so it can be seen and cleared. */}
      {live || value.label !== "" ? (
        <>
          <label className="sr-only" htmlFor="tasks-label">
            Label
          </label>
          <input
            id="tasks-label"
            type="search"
            className={cn(fieldClass, "w-40")}
            placeholder="Label…"
            value={value.label}
            onChange={(event) => onPick("label", event.target.value)}
          />
        </>
      ) : null}

      {narrowed ? (
        <Link
          to={{ search: "" }}
          replace
          className={cn(
            pillControlClass,
            "text-xs font-medium text-foreground underline-offset-4 hover:underline",
            "max-sm:inline-flex max-sm:items-center max-sm:px-2",
          )}
        >
          Clear filters
        </Link>
      ) : null}
    </FilterBar>
  );
}

// --- Waiting on you: the operator's own asks, five at a time ----------------

/**
 * One ask, answered on its row (`useAskActions`): a claimable `human`-labelled
 * task, or an open gate holding other work. Warn, never error, at every
 * priority: the operator being the blocker is not a failure.
 */
function InboxRow({
  project,
  task,
  actionable,
  nowMs,
  showProject,
}: {
  project: BoardProject;
  task: BoardTask;
  actionable: boolean;
  nowMs: number;
  showProject: boolean;
}) {
  // The verbs and the answer box are the task page's too.
  const capabilities = useTasksLive();
  const supported = taskOperationAvailable(capabilities, isGate(task) ? 'resolve' : 'respond');
  const { buttons, box } = useAskActions({ ask: askVerb(task), id: task.id, title: task.title, project: task.project, placement: "row",
    disabledReason: supported ? null : 'Unavailable in this workspace.' });
  const evidence = [task.description, task.acceptance].some((value) => (value ?? "").trim() !== "");

  return (
    <ListRow
      {...askFace(task)}
      title={task.title}
      caption={
        <>
          {/* The project and what the row asks, never the task's id, which is
              on the task's own page. */}
          {[showProject ? project.name : null, isGate(task) ? "needs your approval" : null].filter(Boolean).join(" · ") || null}
        </>
      }
      value={formatAge(ageMs(nowMs, task.updatedAt)) || "—"}
      valueLabel="waiting"
      marks={{ "data-inbox-row": task.id, "data-subject": `task:${task.id}` }}
      rowActions={actionable ? buttons : undefined}
      below={actionable ? box : null}
    >
      {evidence ? (
        <span className="grid gap-1" data-inbox-evidence>
          {task.description?.trim() ? <span className="whitespace-pre-line text-foreground">{task.description.trim()}</span> : null}
          {task.acceptance?.trim() ? (
            <span className="whitespace-pre-line">
              <span className="font-medium text-foreground">Done when </span>
              {task.acceptance.trim()}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-2">
        <OpenTaskLink id={task.id} project={task.project} />
      </span>
    </ListRow>
  );
}

// --- The board: one table, 25 rows at a time --------------------------------

/** Every task, one line each, with the grouping on the row that expands: the
 * epic is a question about a task once you are looking at it. */
function Board({
  rows,
  shown,
  onMore,
  total,
  narrowed,
  projects,
  nowMs,
  showProject,
  countsComplete,
}: {
  rows: BoardTask[];
  shown: number;
  onMore: () => void;
  total: number;
  narrowed: boolean;
  projects: Map<string, BoardProject>;
  nowMs: number;
  showProject: boolean;
  countsComplete: boolean;
}) {
  const page = rows.slice(0, shown);
  const remaining = rows.length - page.length;

  return (
    <section className="flex flex-col rounded-[10px] border border-border bg-card">
      {/* The desk's one eyebrow; the card's own padding rides in through
          `className`, as `ListPanel` does. */}
      <SectionLabel
        title="All tasks"
        caption={
          // The mark stays on the span the audit and the tests read. A count,
          // and against what when narrowed: `12 of 29`; an incomplete board
          // wears the same `+` as the strip.
          <span data-tasks-summary className="tabular-nums">
            {rows.length}
            {countsComplete ? "" : "+"}
            {narrowed ? ` of ${total}${countsComplete ? "" : "+"}` : ""}
          </span>
        }
        className="px-4 pb-2 pt-3"
      />

      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          {/* Unfiltered and empty with tasks on the board: every one of them
              is in Waiting on you above, which this table does not repeat. */}
          {!countsComplete ? "Task availability is unknown for unread projects." : total === 0 ? "Nothing is queued." : narrowed ? "No task matches these filters." : "Nothing else is queued."}
        </p>
      ) : (
        <div className="px-2 pb-1">
          <Table stacked>
            <TableHeader>
              <TableRow>
                {/* `w-full max-w-0` is what makes a truncating cell possible in
                    a table: the column takes every pixel the fixed ones leave,
                    and its content measures against zero rather than against
                    its own text, so a 120-character title cannot push the Age
                    and State columns off the right edge. From `sm` UP only —
                    below it the row has stacked into a card and every cell is a
                    full-width line, where a zero max-width collapses the title
                    to nothing at all. */}
                <TableHead className="sm:w-full sm:max-w-0">Task</TableHead>
                <TableHead className="whitespace-nowrap">Id</TableHead>
                {showProject ? (
                  <TableHead className="whitespace-nowrap">Project</TableHead>
                ) : null}
                <TableHead className="whitespace-nowrap text-right">Age</TableHead>
                <TableHead className="whitespace-nowrap">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.map((task) => (
                <BoardRow
                  key={task.id}
                  task={task}
                  project={projects.get(task.project) ?? null}
                  actionable={projects.get(task.project)?.actionable ?? false}
                  nowMs={nowMs}
                  showProject={showProject}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {remaining > 0 ? (
        <div className="border-t border-border/60 p-2">
          <Button type="button" variant="ghost" className="w-full" onClick={onMore} data-tasks-more>
            Load {Math.min(remaining, PAGE_ROWS)} more · {remaining} left
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The mark, chosen by what the row is before what it is worth: a finished or
 * parked task wears its status glyph, and everything live carries its priority
 * mark, ink weight and never a severity hue. */
function RowMark({ task }: { task: BoardTask }) {
  return task.status === "closed" || task.status === PARKED
    ? <RestingMark status={task.status} className="self-start" />
    : <PriorityMark priority={task.priority} className="self-start" />;
}

/**
 * One row, one line, and every action behind the press that opens it. The row
 * is a button rather than a link: opening it must not leave the board, and the
 * id beside it is the link to the task's own page. On a phone the row folds to
 * its summary line and unfolds with the same press.
 */
function BoardRow({
  task,
  project,
  actionable,
  nowMs,
  showProject,
}: {
  task: BoardTask;
  project: BoardProject | null;
  actionable: boolean;
  nowMs: number;
  showProject: boolean;
}) {
  const { pathname, search } = useLocation();
  const [open, setOpen] = useState(false);
  const epic = task.parent ? (project?.epicNames.get(task.parent) ?? null) : null;
  const columns = showProject ? 5 : 4;

  return (
    <>
      <TableRow foldedWhenStacked={!open} data-task-row={task.id}>
        <TableCell className="py-1 ps-1 sm:w-full sm:max-w-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              // `items-start` so a wrapped title keeps its mark on the first
              // line; centred on a phone, where the row has claimed its 44px
              // thumb target and top-aligned text leaves a hole under it.
              "flex w-full items-start gap-2.5 rounded-md p-1 text-left max-sm:items-center",
              pillControlClass,
              "hover:bg-muted/40 motion-safe:transition-colors",
            )}
          >
            <RowMark task={task} />
            <span className={cn("min-w-0 text-[13px] text-foreground", !open && "truncate")}>
              {task.title}
            </span>
          </button>
        </TableCell>
        <TableCell label="Id" foldWhenStacked className="whitespace-nowrap py-1">
          <Link
            to={`/tasks/${task.id}`}
            state={{ returnTo: `${pathname}${search}` }}
            className={cn(
              "font-mono text-[11px] tabular-nums text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
              pillControlClass,
              "max-sm:inline-flex max-sm:min-w-11 max-sm:items-center max-sm:-my-2.5",
            )}
          >
            {task.id}
          </Link>
        </TableCell>
        {showProject ? (
          <TableCell
            label="Project"
            foldWhenStacked
            className="max-w-[10rem] truncate whitespace-nowrap py-1 text-xs text-muted-foreground"
          >
            {project?.name ?? task.project}
          </TableCell>
        ) : null}
        <TableCell
          label="Age"
          foldWhenStacked
          className="whitespace-nowrap py-1 text-right text-xs tabular-nums text-muted-foreground"
        >
          {formatAge(ageMs(nowMs, task.updatedAt)) || "—"}
        </TableCell>
        {/* The glyph carries the state's shape and tone, the word carries the
            state, and both come from the one status face the task page uses. */}
        <TableCell label="State" foldWhenStacked className="whitespace-nowrap py-1">
          <TaskStatusMark status={task.status} />
        </TableCell>
        {/* The summary a folded phone row shows in place of its fields — the
            header row the desk has and a stacked card does not. It carries the
            state's own dot too: on a phone this line IS the row. */}
        <TableCell onlyWhenStacked className="py-0 text-[11px] text-muted-foreground">
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            {isGate(task) ? "needs your approval" : null}
            <span aria-hidden>·</span>
            <TaskStatusMark status={task.status} />
            <span aria-hidden>·</span>
            {formatAge(ageMs(nowMs, task.updatedAt)) || "—"}
          </span>
        </TableCell>
      </TableRow>
      {open ? (
        <tr data-task-detail={task.id}>
          <td colSpan={columns + 1} className="px-3 pb-2.5 max-sm:px-2">
            <RowDetail task={task} epic={epic} actionable={actionable} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * What an open row shows: the facts a one-line row could not carry, then the
 * verbs, inline rather than in a dialog that would hide the row the decision
 * is about. The reason on a close is required because completion is evidence;
 * the local read refuses a reasonless close anyway.
 */
function RowDetail({
  task,
  epic,
  actionable,
}: {
  task: BoardTask;
  epic: string | null;
  actionable: boolean;
}) {
  const toast = useOwnerToast();
  const capabilities = useTasksLive();
  const [mode, setMode] = useState<null | "close" | "defer">(null);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const claim = useClaimTask();
  const close = useCloseTask();
  const update = useUpdateTask();
  const busy = claim.isPending || close.isPending || update.isPending;
  const band = priorityLabel(task.priority);
  const done = task.status === "closed";

  async function act(what: "claim" | "close" | "defer") {
    if (!actionable) return;
    try {
      if (what === "claim") await claim.mutateAsync({ id: task.id, project: task.project });
      else if (what === "close") await close.mutateAsync({ id: task.id, reason, project: task.project });
      else await update.mutateAsync({ id: task.id, edit: { defer: until }, project: task.project });
    } catch (err) {
      toast.error(errorText(err, `Could not ${what} ${task.id}`));
      return;
    }
    toast.success(
      what === "claim"
        ? `Claimed ${task.id}`
        : what === "close"
          ? `Closed ${task.id}`
          : `Parked ${task.id} until ${until}`,
    );
    setReason("");
    setUntil("");
    setMode(null);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {epic ? <InfoTooltip label="Parent epic" trigger={`Part of ${epic}`}>
          The epic this task hangs off
        </InfoTooltip> : null}
        {band ? <span>Priority {band}</span> : null}
        {task.assignee ? <span>Claimed by {taskActorLabel(task.assignee, task.actors)}</span> : null}
        {task.deferUntil ? <span>Parked until {task.deferUntil.slice(0, 10)}</span> : null}
        {task.labels.length > 0 ? <span className="font-mono">{task.labels.join(" ")}</span> : null}
      </div>

      {mode === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {done ? null : (
            <>
              <Button
                type="button"
                size="sm"
                disabled={!actionable || busy || !taskFieldAvailable(capabilities, 'claim')}
                onClick={() => void act("claim")}
                data-task-action="claim"
              >
                Claim
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!actionable || busy || !taskOperationAvailable(capabilities, 'close')}
                onClick={() => setMode("close")}
                data-task-action="close"
              >
                Close…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!actionable || busy || !taskFieldAvailable(capabilities, 'defer')}
                onClick={() => setMode("defer")}
                data-task-action="defer"
              >
                Defer…
              </Button>
            </>
          )}
          <OpenTaskLink id={task.id} project={task.project} />
        </div>
      ) : null}

      {mode === "close" ? (
        <div className="flex flex-col gap-2" data-task-form="close">
          <input
            type="text"
            className={cn(fieldClass, "w-full")}
            aria-label={`Why ${task.id} is closed`}
            placeholder="Evidence — a commit, a link, what proves it"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!actionable || busy || reason.trim() === ""}
              onClick={() => void act("close")}
              data-task-confirm="close"
            >
              Close task
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "defer" ? (
        <div className="flex flex-col gap-2" data-task-form="defer">
          <input
            type="date"
            className={cn(fieldClass, "w-full")}
            aria-label={`Park ${task.id} until`}
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!actionable || busy || until === ""}
              onClick={() => void act("defer")}
              data-task-confirm="defer"
            >
              Park it
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** An empty board's one way out: the page that fixes it, as a link. */
function EmptyAction({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex items-center font-medium text-foreground underline-offset-4 hover:underline",
        pillControlClass,
      )}
    >
      {children} →
    </Link>
  );
}

/** Every row opens at its own task page; a row you cannot open is a dead end.
 * Drawn as a button-sized target rather than a word in a sentence, because it
 * sits in a row of verbs and a thumb has to be able to hit it. */
function OpenTaskLink({ id, project }: { id: string; project: string }) {
  const { pathname, search } = useLocation();
  const { projectSelection } = useTasksLive();
  return (
    <Link
      to={taskPath(id, projectSelection ? project : undefined)}
      state={{ returnTo: `${pathname}${search}` }}
      className={cn(
        "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
        pillControlClass,
      )}
      data-task-open={id}
    >
      Open task
    </Link>
  );
}

export default TasksBoard;
