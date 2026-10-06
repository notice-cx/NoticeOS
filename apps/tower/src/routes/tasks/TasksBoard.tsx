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
  WORK_HISTORY_MIN_POINTS,
  WORK_POLL_CADENCE_HOURS,
  sumWorkHistory,
  priorityLabel,
} from "@shared/work";
import type { SeriesPoint } from "@shared/wall";
import { ageMs, formatAge } from "@shared/freshness";
import { AgeBadge } from "@/components/AgeBadge";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { EmptyState } from "@/components/EmptyState";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ReadFailed } from "@/components/ReadFailed";
import { TaskComposer } from "@/components/TaskComposer";
import { FilterBar } from "@/components/surface/FilterBar";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
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
 * THE TASK BOARD — doc 21's index template, on two surfaces.
 *
 * `/tasks` renders it across every project (`TasksRoute`); an asset page's
 * **Tasks** tab renders the same component with `project` fixed to that asset.
 * One rendering of the task database, two surfaces, differing by one prop.
 *
 * WHY IT WAS REBUILT (2026-09-05, bead `ro-78qo.12`). The old board drew one
 * bordered section per project, each with its own headline panel, its own
 * "Next up" list, one card per epic, a parked lane and a closed lane. Every
 * section was individually reasonable and the page was **32,495px tall at 1440
 * and 132,918px on a phone, with 430 controls under the 44px thumb floor** —
 * the single worst surface in `surface:audit`'s baseline, on the page an
 * operator opens to decide what to do next. Doc 21's diagnosis applies exactly:
 * everything, all at once, in the same size.
 *
 * WHAT IT IS NOW, top to bottom:
 *   · the filter row — five controls, all URL state, so a narrowed board is a link;
 *   · a `KpiStrip` that is NOT selectable: the six counts an operator opens this
 *     page to read, over the whole board rather than over the current filter,
 *     each riding its own daily sparkline (db/0032, bead `ro-78qo.23`);
 *   · `Waiting on you` as a `ListPanel` at five rows, the rest disclosed in
 *     place — the only rows here the OS physically cannot move, each answered
 *     on its own row (Approve, or Answer / Dismiss);
 *   · every OTHER task as ONE `Table`, 25 rows at a time, each row one line
 *     that expands in place for its claim / close / defer.
 *
 * NO PARAGRAPHS (bead `ro-ujb9.96.6.11`, doc 21 principle 3a). The board used
 * to end in an About of six paragraphs and carry three banners that could be
 * open at once. Each fact is now shown by the state that owns it, once: a
 * read-only build is one `Read-only snapshot` banner; projects that could not
 * be read are one warn banner with their names and a Retry; a local read still
 * loading is a spinner beside the age badge; a count that is missing a project
 * is a lower bound (`12+`) rather than a caption repeated on six tiles.
 *
 * PAGED, NOT VIRTUALISED. Doc 21's acceptance asks for one or the other and for
 * the reason to be written down. Paging keeps three things honest that a
 * windowed list does not: the browser's own find-in-page still reaches every
 * rendered row, a deep link to `/tasks/:id` never depends on a scroll offset
 * being restored first, and the row count under the filters is a fact about the
 * DOM rather than about a virtualiser's estimate. 25 rows is ~1,050px — the
 * whole page fits doc 21's 2,400px budget — and `Load more` costs one press
 * where virtualisation would have cost a scroll container that has to be told
 * how tall its own rows are.
 *
 * TWO READS, ONE BOARD, unchanged. Live, each project's rows come from the OS's
 * local read of the task database — untruncated, with labels, blocker-aware
 * `ready`, and gate metadata. Without it they come from the once-a-minute
 * photograph, whose lists are heads with counts over the whole. The sections
 * are identical either way and the age badge says which instant is being shown.
 *
 * AN AGENT still claims and closes with `bd` in the repository where the work
 * happens; this board is the operator's door onto the same command.
 */

/** Rows per press. Doc 21's index template: "one Table paged 25 rows at a
 * time". 25 rows is about 1,050px, which is what leaves the page inside its
 * budget with the strip and the inbox above it. */
const PAGE_ROWS = 25;
/** The inbox opens at five rows (doc 21's Home template) and discloses the rest
 * through `ListPanel`'s own expander. The page does not slice first: a panel
 * that silently keeps five of nine is lying about the size of the queue. */
const INBOX_ROWS = 5;

/**
 * THE TWO REASONS A COUNT HAS NO TREND LINE YET, and they are different
 * sentences because they ask for different things (bead `ro-78qo.23`).
 *
 * The daily rollup behind the six counts is a table an OPERATOR has to create —
 * migrations here are operator-applied, forever (AGENTS.md HARD INVARIANTS) — so
 * the first reason is an instruction with the command in it. Once the table
 * exists it fills at one point a day, and until there are three of them a line
 * would be two dots joined by a segment: a shape the eye reads as a trend and
 * the data cannot support. That reason is a wait, not an action, and saying
 * "run migration 0032" to someone who already has would be the worse of the two
 * mistakes.
 */
const SHORT_HISTORY_REASON = `the daily history needs ${WORK_HISTORY_MIN_POINTS} days before it is a line`;

/** Location state that opens the board's composer without changing the URL. */
const COMPOSE_STATE = "newTask";

function composeRequested(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[COMPOSE_STATE] === true;
}

/**
 * FILE A TASK — one button, two surfaces.
 *
 * The press opens the board's composer IN PLACE: it sets location state, not
 * the query string, so the page the operator is on does not change under them
 * (bead `ro-ujb9.96.7.11` — a URL change with nothing entered on the page it
 * left was the file-task flow's one empty step). `?new=1` still opens it, so
 * "file something against example.com" can still be sent as a link. On an
 * asset's Tasks tab the board is already pinned to one project, and
 * `data-new-task-project` carries that id — the composer takes its project from
 * the board it opened on rather than asking a question the page has answered.
 *
 * Disabled without the live read, with what to do on hover: a deployed build
 * cannot run `bd`, and a button that looks live and then refuses is worse than
 * one that says why up front.
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
   * Scope the board to ONE project — the asset id the projects file maps to a
   * repository. `null` (the default) is every project, which is the index.
   *
   * A scoped board drops what the page around it already says: the project
   * control, the project column, the project name on each inbox row, and the
   * first-screen mark, which belongs to the tab rather than to the board inside
   * it. The filter is still pinned, so everything below counts and matches
   * exactly as it does on the index.
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

  // A scoped board's project is the PAGE, not a control: it comes from the
  // route rather than the query string, so it survives a Clear and cannot be
  // widened into a portfolio board from inside an asset.
  const projectFilter = scoped ? scope : (params.get("project") ?? "all");
  const statusFilter = params.get("status") ?? "all";
  const priorityFilter = params.get("priority") ?? "all";
  const labelFilter = params.get("label") ?? "";
  const assigneeFilter = params.get("assignee") ?? "all";
  const location = useLocation();
  const navigate = useNavigate();
  const composing = params.get("new") === "1" || composeRequested(location.state);

  // Narrowing the board starts it again at the first page. Without this a
  // reader who had pressed Load more four times would land on 125 rows of a
  // filter they have just applied, which is the opposite of narrowing.
  const filterKey = [projectFilter, statusFilter, priorityFilter, labelFilter, assigneeFilter].join("|");
  useEffect(() => {
    setShown(PAGE_ROWS);
  }, [filterKey]);

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    // The default never occupies the query string, so a cleared board is
    // `/tasks` and two operators who narrowed the same way produce one link.
    if (value === "all" || value === "") next.delete(name);
    else next.set(name, value);
    // `replace`: a filter is a view of one page, not a place — the back button
    // should leave Tasks, not walk backwards through every control touched.
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
    totals: readTotals, pendingProjects, counts: readCounts, countsComplete, missingProjects, closedSince, byId, broken,
    closedHistoryState,
  } = useTaskBoard(scope, {
    project: projectFilter, status: statusFilter, priority: priorityFilter,
    label: labelFilter, assignee: assigneeFilter,
  });

  // AN ANSWERED ROW LEAVES AT ONCE (bead `ro-ujb9.96.7.11`): it is out of the
  // list and out of the count while its Undo window runs, and stays out until a
  // read taken after the answer says what the hub now holds.
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

  // THE SIX SERIES, summed over the projects this board is showing — every
  // spoke on the index, one spoke on an asset's Tasks tab, so a scoped board's
  // lines are that project's own. The daily rollup is the ONLY source: the live
  // read answers "now" and has no yesterday in it.
  const history = sumWorkHistory(spokes);
  // The day the rollup is still accumulating, so every spark's endpoint cap goes
  // hollow (doc 21: "the latest day of any daily series is provisional until the
  // provider closes it"). It comes from the payload's own clock rather than the
  // browser's, because that is the clock the rows were bucketed on.
  const openDay = data ? data.generatedAt.slice(0, 10) : null;
  const seriesGap = SHORT_HISTORY_REASON;
  /**
   * A series, or the reason there is not one yet — never both, which `Kpi`
   * treats as a caller error.
   *
   * `sparkAverage={false}` because these are DAYS and the default smooths over
   * seven of them: a seven-point daily series averaged over a seven-day window
   * is one point, which is not a line. The raw days are the shape.
   */
  const series = (points: SeriesPoint[]) =>
    points.length >= WORK_HISTORY_MIN_POINTS
      ? { spark: points, sparkAverage: false, sparkProvisionalFrom: openDay }
      : { seriesUnavailable: seriesGap };

  /**
   * A COUNT THAT IS MISSING A PROJECT IS A LOWER BOUND, and says so in its own
   * digits: `12+`. It used to be a dash with "12 observed · 1 project
   * unavailable" under every one of the six tiles — the same fact six times,
   * when the banner above already names the project. `—` stays for a count the
   * read cannot bound at all: nothing measured it, or no project was read.
   */
  const anyRead = missingProjects < projects.length;
  const bounded = (complete: number | null, observed: number | null) =>
    complete ?? (observed === null || !anyRead ? "—" : `${observed}+`);
  /** Each count against the queue it is part of — `of 21 live` — which is a
   * different share on every tile, and wears the same `+` when a project is
   * missing. */
  const ofLive = anyRead ? `of ${totals.live}${countsComplete ? "" : "+"} unfinished` : undefined;

  const strip = (
    // The strip draws no boundary of its own (doc 21: a container must earn
    // one), so this page gives it the card it would otherwise share with the
    // chart it selects. There is no chart here — the question this page answers
    // is "what needs me", and six sparklines are the trend it needs.
    //
    // No `sparkLabel` on the five that plot the headline's own quantity: the
    // tile's label already names it, and the Kpi's line says "daily values".
    // Only Closed this week plots something else — a seven-day total over a
    // line of single days — so only it names its line.
    <KpiStrip columns={6} className="overflow-hidden rounded-[10px] border border-border max-sm:order-last">
      <Kpi
        label="Waiting on you"
        value={bounded(counts.waiting, totals.waiting)}
        valueTone={totals.waiting > 0 ? "warn" : "default"}
        improvement="down"
        caption={gates > 0 ? `${gates} approval ${gates === 1 ? "gate" : "gates"}` : ofLive}
        explanation={gates > 0 ? "Approval gates hold related work until you approve or decline them." : undefined}
        {...series(history.waiting)}
      />
      <Kpi
        label="Urgent"
        value={bounded(counts.urgent, totals.urgent)}
        // No red: an urgent task is a rank, not a failure (doc 14).
        improvement="down"
        caption={
          totals.urgent === null
            ? "not measured"
            : totals.blindUrgent > 0
              ? `${totals.blindUrgent} ${totals.blindUrgent === 1 ? "project" : "projects"} not measured`
              : ofLive
        }
        {...series(history.urgent)}
      />
      <Kpi
        label="Open"
        value={bounded(counts.open, totals.open)}
        improvement="down"
        caption={ofLive}
        {...series(history.open)}
      />
      <Kpi
        label="In progress"
        value={bounded(counts.inProgress, totals.inProgress)}
        improvement="none"
        caption={ofLive}
        {...series(history.inProgress)}
      />
      <Kpi
        label="Blocked"
        value={bounded(counts.blocked, totals.blocked)}
        valueTone={totals.blocked > 0 ? "warn" : "default"}
        improvement="down"
        caption={ofLive}
        {...series(history.blocked)}
      />
      <Kpi
        label="Closed this week"
        sparkLabel="Closed per day"
        // Complete, or a saved count the snapshot holds in full: the number.
        // A live board still waiting on a project's closings: a dash, whose
        // reason is the loading mark beside the age badge — not a lower bound,
        // because a saved and a live week are not the same seven days.
        value={!countsComplete ? bounded(null, totals.closed) : (counts.closed ?? "—")}
        // No green: a closing records a decision, not a proven outcome (doc 14,
        // bead ro-ujb9.202) — the same reason a closed row wears none.
        caption={closedSince ? `since ${closedSince} · UTC` : "last 7 days"}
        // The VALUE is a seven-day total and the LINE is one point per day, which
        // is the only pairing either read can defend: the photograph bounds the
        // total, and the rollup counts the closings. The hover readout says which
        // day each point is, so the two never have to be read as the same number.
        {...series(history.closed)}
      />
    </KpiStrip>
  );

  const panel = (
    <div data-waiting-list className="contents">
    <ListPanel
      title="Waiting on you"
      count={
        totals.waiting === 0
          ? undefined
          : `${totals.waiting}${countsComplete ? "" : "+"} ${totals.waiting === 1 ? "ask" : "asks"}${gates > 0 ? ` · ${gates} ${gates === 1 ? "gate" : "gates"}` : ""}`
      }
      limit={INBOX_ROWS}
      empty={countsComplete ? "Nothing is waiting on you." : "Waiting work is unknown for unread projects."}
      // NO RING. Doc 21 is one card style, and every row in here already leads
      // with a toned glyph: a warn-coloured border around them adds a second
      // encoding of urgency the panel does not own — the panel is a place, and
      // the rows are what is urgent.
    >
      {/* No row opens on arrival, deliberately. Doc 21's Overview template
          opens the first "What matters" row, and the same trick here is a lie
          waiting to happen: `ListRow` reads `defaultExpanded` once, at mount,
          and this panel mounts on the photograph and is then reordered by the
          live read — so the row that ends up first is whichever one happened to
          mount first, opened for no reason the operator can see. */}
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
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-3.5" data-tasks-board={scope ?? "all"}>
      {newTask ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <NewTaskButton project={scopeKey} />
        </div>
      ) : null}

      {/* Read-only is said ONCE, here, rather than on every disabled control:
          the lead is what happened, the line is what to do. It covers the
          sample too — a read-only board IS the saved snapshot. */}
      <div data-tasks-readonly={live ? undefined : ""}>
        <StatusBanner open={!live} severity="info" lead="Read-only snapshot" subject="tasks:snapshot">
          {READ_ONLY_TASKS_HINT}
        </StatusBanner>
      </div>

      {/* One composer, two ways in: New task opens it in place (location
          state, so the page does not change), and `?new=1` is a link that opens
          it, so "file something against example.com" can be sent rather than
          described. It inherits the PROJECT the board is showing and nothing
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
        // No board and nothing pending is a failed read, and it says so
        // (bead ro-ujb9.218) — the shared state Home, Sites and Alerts draw.
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

          {/* ONE banner for projects that could not be read — which, and a way
              to try again. Their rows stay on the board from the saved
              snapshot, without actions; the six counts carry a `+`. */}
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

          {/* THE FIRST SCREEN, and the whole of the page's one question: how big
              is the queue, and what in it cannot move without you. Everything
              below is the same rows in detail.

              A SCOPED BOARD MARKS IT TOO (bead `ro-78qo.32`). The asset Tasks
              tab used to declare the mark instead, with a wrapper around this
              whole component — but a wrapper can only span the board, so the
              audit measured the bottom of the 25-row table and reported the
              first screen 973px over. Only the board knows where its answer
              ends, so the board says. */}
          <div data-surface-hero className="flex flex-col gap-3.5">
            {strip}
            {panel}
          </div>

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

/** What a refusal says out loud: the local read hands back `bd`'s own stderr in
 * `detail`, and `ApiError.message` is that sentence. Never a sentence written
 * here over the top of one `bd` already wrote. */
function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message !== "") return err.message;
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters — the state is the URL, so a narrowed board is a link
// ─────────────────────────────────────────────────────────────────────────────

interface FilterValue {
  project: string;
  status: string;
  priority: string;
  label: string;
  assignee: string;
}

/**
 * FIVE CONTROLS, ONE ROW, and every one of them is
 * `?project=&status=&priority=&label=&assignee=`, so a narrowed view can be
 * bookmarked, pasted into a task, or linked from an asset page.
 *
 * WHY THEY ARE ALL SELECTS NOW. Status and priority were twelve chips carrying
 * a glyph and a count, and doc 14's rule at the time was right: a chip row
 * answers "how much is blocked?" without a click. Doc 21 gives that answer to
 * the `KpiStrip` two lines above, in 28px type, and a fact stated twice on one
 * screen is the duplicate doc 14 forbids — so the counts stay (each option
 * carries its own) and the twelve controls become two. That is 12 fewer boxes
 * under a thumb at 390 and one row instead of two on every width.
 *
 * A SCOPED board drops the project control entirely: its project is the page it
 * is on, so a select offering one option would be a control that cannot change
 * anything.
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
  // What the fold's one press carries on a phone (bead ro-ujb9.13): how many of
  // these are narrowing the board now.
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
      {/* One project is not a choice (bead ro-ujb9.130); a link that already
          narrows keeps its select so it can be cleared. */}
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

// ─────────────────────────────────────────────────────────────────────────────
// Waiting on you — the operator's own asks, five at a time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE ASK, ANSWERED ON ITS ROW (bead `ro-ujb9.96.7.11`, Linear Triage). It
 * leads the board rather than sitting inside each project, because these are
 * the only rows here the OS physically cannot move: a `human`-labelled task
 * that is claimable now, and an open gate, which matters more because it is
 * holding other work out of the claimable queue until it is released.
 *
 * ONE PRESS PER DECISION, without opening the row. A gate's verb is Approve
 * (`bd gate resolve` — releasing a wait condition is not answering a
 * question). An ask's verbs are Answer, which opens a box under the row where
 * Enter sends (`bd human respond`: the words become a comment and close it, so
 * an empty answer is never sent), and Dismiss (`bd human dismiss`, a permanent
 * decline). All three land after the Undo window (`lib/answer-queue.ts`), and
 * the row leaves at once. Opening the row shows what the ask says and its page.
 *
 * The register is **warn, never error, at every priority** (bead
 * `ro-ujb9.200`): the operator being the blocker is a call for attention, not a
 * failure, and a task's priority is not a severity (doc 14) — the inbox is
 * already ordered gate first, then priority. A project without a live read
 * offers no verbs at all — the Read-only snapshot banner says why, once.
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
  // The verbs and the answer box are the task page's too (bead ro-ujb9.243).
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
          {showProject ? `${project.name} · ` : null}
          <span className="font-mono">{task.id}</span>
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

// ─────────────────────────────────────────────────────────────────────────────
// The board — one table, 25 rows at a time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVERY TASK, ONE LINE EACH. The old board drew one card per project, one card
 * per epic inside it and one heading per lane inside that; this is the same
 * rows in one table with the grouping moved onto the row that expands.
 *
 * The epic is on the EXPANDED row rather than in a card of its own: "what is
 * this project trying to do" is a question about a task once you are looking at
 * it, and thirty containers stacked above the work was how the page reached
 * 32,495px.
 */
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
      {/* The desk's ONE eyebrow (bead `ro-78qo.39`). This header was the same
          three parts hand-rolled — an 11px tracked title and a quiet count —
          and a second copy of a vocabulary component is exactly what the
          registry exists to prevent. The card's own padding rides in through
          `className`, which is the pattern `ListPanel` already uses. */}
      <SectionLabel
        title="All tasks"
        caption={
          // The mark stays on the span the audit and the tests read, inside the
          // caption rather than instead of it.
          // A count, and against what when narrowed: `12 of 29`. Paging is the
          // Load more button's to say, and an incomplete board wears the same
          // `+` as the strip — the banner above says why, once.
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

/** Doc 21's mark set, chosen by what the row IS before what it is worth: a
 * finished or parked task wears its status glyph — the one its State cell and
 * its page wear (bead `ro-ujb9.202`) — and everything live carries its
 * priority mark, ink weight and never a severity hue (doc 14, bead
 * `ro-ujb9.200`). */
function RowMark({ task }: { task: BoardTask }) {
  return task.status === "closed" || task.status === PARKED
    ? <RestingMark status={task.status} className="self-start" />
    : <PriorityMark priority={task.priority} className="self-start" />;
}

/**
 * ONE ROW, one line, and every action behind the press that opens it.
 *
 * The row is a button rather than a link: opening it must not leave the board,
 * and the id beside it is the link for the reader who wants the task's own page.
 * On a phone the row folds to its summary line and unfolds with the same press,
 * which is what keeps 25 rows from becoming 150 labelled lines.
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
        {/* THE STATE, READ BEFORE THE WORD IS (doc 14): the glyph carries the
            state's shape and tone, the word carries the state, and both come
            from the one status face the task page uses. */}
        <TableCell label="State" foldWhenStacked className="whitespace-nowrap py-1">
          <TaskStatusMark status={task.status} />
        </TableCell>
        {/* The summary a folded phone row shows in place of its fields — the
            header row the desk has and a stacked card does not. It carries the
            state's own dot too: on a phone this line IS the row. */}
        <TableCell onlyWhenStacked className="py-0 text-[11px] text-muted-foreground">
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span className="font-mono">{task.id}</span>
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
 * WHAT AN OPEN ROW SHOWS: the facts a one-line row could not carry, then the
 * verbs.
 *
 * INLINE, NOT A DIALOG. Every one of these is a sentence the operator is
 * already looking at; a modal would hide the row the decision is about. The
 * reason on a close is REQUIRED because completion is evidence and the closer
 * cites what proves it — the local read refuses a reasonless close anyway, and
 * a field that will be refused should not be submittable.
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

/** An empty board's one way out: the page that fixes it, as a link, in place
 * of the paragraph that used to describe the fix. */
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
