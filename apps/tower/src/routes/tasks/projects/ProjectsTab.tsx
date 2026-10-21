import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TASK_PROJECTS_PATH, taskActorLabel } from "@shared/tasks";
import { siteCount } from "@shared/site-noun";
import type { WorkProject, WorkWeeks } from "@shared/work";
import { EmptyState } from "@/components/EmptyState";
import { ReadFailed } from "@/components/ReadFailed";
import { SegmentBar } from "@/components/SegmentBar";
import { PageSkeleton } from "@/components/Skeleton";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { AGENTS_ROUTE } from "@/components/nav-items";
import { FinishLine } from "@/components/surface/FinishLine";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { pillChoiceClass, pillChoiceStateClass, pillControlClass, pillPickerStateClass } from "@/components/ui/pill";
import { LAST_WEEK_BY_TODAY, WorkWeekChip } from "@/components/viz/WorkFlow";
import { ProjectJourneys, type JourneyRow } from "@/components/viz/ProjectJourneys";
import { useNow } from "@/hooks/useNow";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { useTasksLive } from "@/hooks/useTasks";
import { useOwnerAnswers } from "@/lib/browser-context";
import { formatInt } from "@/lib/format";
import { IN_PROGRESS, PARKED, type BoardProject, type BoardTask } from "@/lib/task-board-read";
import { boardWorkRows } from "@/lib/task-board-viz";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";
import { PROJECT_STATE_TONE, SiteMark, projectStateLine } from "./project-face";
import { PROJECT_SORTS, allProjects, projectModel, sortSites, type ProjectRecord, type ProjectSort, type SiteProjects } from "./project-model";
import { SiteProjectCards, SiteRow, countWord } from "./SiteRow";

/** Every task on the board, unfiltered: the tab draws the shape of the work. */
const ALL = { project: "all", status: "all", priority: "all", label: "", assignee: "all" } as const;

const VIEWS = [
  { key: "cards", label: "Cards" },
  { key: "timeline", label: "Timeline" },
] as const;
type View = (typeof VIEWS)[number]["key"];

/**
 * The Projects tab: every epic as a project of its site, grouped by site, in
 * one order, as cards or on one time axis. The sentence counts the projects
 * that wait on the operator, are urgent or are blocked; the bar under it
 * splits the open work by state. A card's question is answered on the card
 * with the board's own verbs.
 */
export function ProjectsTab({ scope }: { scope: string | null }) {
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "timeline" ? "timeline" : "cards";
  const [sort, setSort] = useState<ProjectSort>("attention");
  const { projectSelection } = useTasksLive();
  const { hides } = useOwnerAnswers();
  const { data, drawn, isError, error, isFetching, refetch, spokes, projects: read, allTasks, weeks, countsComplete } = useTaskBoard(scope, ALL);

  function setView(next: View) {
    const search = new URLSearchParams(params);
    if (next === "cards") search.delete("view");
    else search.set("view", next);
    setParams(search, { replace: true });
  }

  if (!data || !drawn) {
    return isError && !data
      ? <ReadFailed title="Couldn't load tasks" subject="read:tasks" error={error} retrying={isFetching} onRetry={() => void refetch()} />
      : <PageSkeleton subject="read:tasks" shape="list" />;
  }
  if (spokes.length === 0) {
    return scope === null ? <TaskHubUnavailable /> : (
      <div className="rounded-[10px] border border-border bg-card p-4" data-tasks-unwired="">
        <EmptyState title="No task project for this site" hint={<Link to={TASK_PROJECTS_PATH} className="text-sm font-medium underline-offset-4 hover:underline">Add a task project</Link>} />
      </div>
    );
  }

  // An answered question leaves its card at once, while its Undo window runs.
  const projects: BoardProject[] = read.map((project) => ({
    ...project,
    waiting: project.waiting.filter((task) => !hides(task.id, project.readAt)),
  }));
  const sites = sortSites(projectModel({ projects, snapshots: spokes, now: new Date(now) }), sort);
  const records = allProjects(sites, "attention");
  const scoped = scope !== null;
  const scopeOf = (record: ProjectRecord) => (projectSelection ? record.site.asset : undefined);
  const cardHref = (record: ProjectRecord) => taskPath(record.id, scopeOf(record));
  const loose = sites.reduce((sum, site) => sum + site.loose, 0);
  const looseComplete = sites.every((site) => site.complete);

  return (
    <div className="flex w-full flex-col gap-5" data-tasks-projects={scope ?? "all"}>
      <div data-surface-hero className="flex flex-col gap-4">
        <PageAnswer answer={<ProjectSentence sites={sites} records={records} scoped={scoped} />} marks={{ "data-projects-answer": "" }} />
        <OpenWork projects={projects} snapshots={spokes} weeks={weeks} complete={countsComplete} tasks={scoped ? null : allTasks} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className={cn("m-0", eyebrowClass)}>Where the work sits</h2>
        <div role="group" aria-label="Order" className="flex flex-wrap items-center gap-1.5">
          {PROJECT_SORTS.map((option) => (
            <button key={option.key} type="button" aria-pressed={sort === option.key} onClick={() => setSort(option.key)}
              className={cn(pillChoiceClass, pillChoiceStateClass(sort === option.key), "motion-reduce:transition-none")} data-projects-sort={option.key}>
              {option.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="View" className="ms-auto inline-flex items-center gap-0.5 rounded-md border border-border p-0.5">
          {VIEWS.map((option) => (
            <button key={option.key} type="button" aria-pressed={view === option.key} onClick={() => setView(option.key)}
              className={cn("inline-flex items-center rounded-[5px] border px-2.5 py-1 text-xs", pillControlClass, pillPickerStateClass(view === option.key))} data-projects-view={option.key}>
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {view === "timeline" ? (
        <ProjectJourneys
          rows={records.map((record) => journeyRow(record, cardHref(record), scoped))}
          nowMs={now}
          weekStart={weeks?.weekStart ?? null}
          ariaLabel="Every project, four weeks back and four ahead"
        />
      ) : scoped ? (
        sites.map((site) => <SiteProjectCards key={site.site.asset} group={site} cardHref={cardHref} projectScope={projectSelection ? site.site.asset : undefined} />)
      ) : (
        <div className="flex flex-col border-b border-border" data-projects-sites="">
          {sites.map((site) => (
            <SiteRow key={site.site.asset} group={site} cardHref={cardHref} projectScope={projectSelection ? site.site.asset : undefined} />
          ))}
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        <FinishLine line="That's every project." className="min-h-0 w-full py-2.5" />
        {loose > 0 ? (
          <Link to={scoped ? `/tasks/all?${new URLSearchParams({ project: scope })}` : "/tasks/all"} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" data-projects-loose={loose}>
            {countWord(loose, looseComplete)} open {loose === 1 && looseComplete ? "task sits" : "tasks sit"} in no project →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** "3 sites, 12 projects. 2 wait on you, 1 urgent, 1 blocked." with the zero clauses dropped. */
function ProjectSentence({ sites, records, scoped }: { sites: readonly SiteProjects[]; records: readonly ProjectRecord[]; scoped: boolean }) {
  const of = (state: ProjectRecord["state"]) => records.filter((record) => record.state === state).length;
  const waits = of("needs-you");
  const urgent = of("urgent");
  const blocked = of("blocked");
  const projects = `${formatInt(records.length)} ${records.length === 1 ? "project" : "projects"}`;
  const head = scoped ? `${projects}.` : `${siteCount(sites.length)}, ${projects}.`;
  const clauses: ReactNode[] = [
    waits > 0 ? <span key="waits" className="text-warn" data-clause="waits">{formatInt(waits)} {waits === 1 ? "waits" : "wait"} on you</span> : null,
    urgent > 0 ? <span key="urgent" className="text-urgent" data-clause="urgent">{formatInt(urgent)} urgent</span> : null,
    blocked > 0 ? <span key="blocked" data-clause="blocked">{formatInt(blocked)} blocked</span> : null,
  ].filter(Boolean);
  return (
    <>
      {head}{" "}
      {clauses.length === 0 ? <span data-clause="clear">Nothing waits on you.</span> : (
        <>{clauses.map((clause, index) => <span key={index}>{index > 0 ? ", " : null}{clause}</span>)}.</>
      )}
    </>
  );
}

/** The open work split by state, with this week's done beside it, as one bar whose legend is the figures. */
function OpenWork({ projects, snapshots, weeks, complete, tasks }: {
  projects: readonly BoardProject[];
  snapshots: readonly WorkProject[];
  weeks: WorkWeeks | null;
  complete: boolean;
  /** Every task, for who is working now; null where the board leaves that out. */
  tasks: readonly BoardTask[] | null;
}) {
  const rows = boardWorkRows(projects);
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const parked = projects.map((project) => project.source === "live"
    ? project.tasks.filter((task) => task.status === PARKED).length
    : snapshots.find((row) => row.prefix === project.prefix)?.counts.deferred ?? null);
  const parkedKnown = parked.every((n) => n !== null);
  const parts = [
    { name: "done", label: "done this week", value: weeks?.done.now ?? null, fill: "bg-foreground/80" },
    { name: "in-progress", label: "in progress", value: sum((row) => row.inProgress), fill: "bg-healthy" },
    { name: "ready", label: "ready", value: sum((row) => row.ready), fill: "bg-muted-foreground/30" },
    { name: "blocked", label: "blocked", value: sum((row) => row.blocked), fill: "bg-warn" },
    { name: "parked", label: "parked", value: parked.reduce<number>((total, n) => total + (n ?? 0), 0), fill: "viz-hatch bg-viz-track text-muted-foreground" },
  ];
  const exact = (name: string) => complete && (name !== "parked" || parkedKnown);
  const shown = parts.filter((part): part is typeof part & { value: number } => part.value !== null);
  const spoken = shown.map((part) => `${countWord(part.value, exact(part.name))} ${part.label}`).join(", ");
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3" data-projects-open-work="">
      <div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-2">
        <SegmentBar segments={shown.map((part) => ({ name: part.name, value: part.value, fill: part.fill }))} ariaLabel={`Work by state: ${spoken}`} className="h-2" />
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs tabular-nums text-muted-foreground">
          {shown.map((part) => (
            <li key={part.name} className="inline-flex items-center gap-1.5" data-open-work={part.name}>
              <span aria-hidden className={cn("size-2 rounded-sm", part.fill)} />
              <span><b className="text-sm font-semibold text-foreground">{countWord(part.value, exact(part.name))}</b> {part.label}</span>
              {part.name === "done" && weeks?.done.move ? <WorkWeekChip move={weeks.done.move} against={LAST_WEEK_BY_TODAY} /> : null}
            </li>
          ))}
        </ul>
      </div>
      {tasks ? <WorkingNow tasks={tasks} /> : null}
    </div>
  );
}

/** Who holds work right now, busiest first, as the board's own line shows it. */
function WorkingNow({ tasks }: { tasks: readonly BoardTask[] }) {
  const counts = new Map<string, { name: string; n: number }>();
  for (const task of tasks) {
    if (task.status !== IN_PROGRESS || !task.assignee) continue;
    const entry = counts.get(task.assignee) ?? { name: taskActorLabel(task.assignee, task.actors), n: 0 };
    counts.set(task.assignee, { ...entry, n: entry.n + 1 });
  }
  const working = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (working.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-tasks-working="">
      <span className="text-muted-foreground">Working now</span>
      {working.map((entry) => (
        <span key={entry.name}><span className="font-medium text-foreground">{entry.name}</span> <span className="tabular-nums text-muted-foreground">{formatInt(entry.n)}</span></span>
      ))}
      <Link to={AGENTS_ROUTE} className={cn("font-medium text-foreground underline-offset-4 hover:underline", pillControlClass)}>Agents →</Link>
    </p>
  );
}

/** A project as a row on the time axis: its tasks' closes, starts, the open
 * question, what is held, what is parked and its kill date. A snapshot row
 * has no claim time, so its start is when it last moved. */
function journeyRow(record: ProjectRecord, href: string, scoped: boolean): JourneyRow {
  const started = (task: BoardTask) => (task as BoardTask & { startedAt?: string | null }).startedAt ?? task.updatedAt;
  const asked = record.ask ? record.ask.task.createdAt ?? record.ask.task.updatedAt : null;
  return {
    id: record.id,
    title: record.title,
    href,
    site: record.site.name,
    ...(scoped ? {} : { mark: <SiteMark asset={record.site.asset} name={record.site.name} className="size-4" /> }),
    state: { label: projectStateLine(record), tone: PROJECT_STATE_TONE[record.state] },
    done: record.tasks.flatMap((task) => (task.status === "closed" && task.closedAt ? [task.closedAt] : [])),
    inProgress: record.tasks.flatMap((task) => {
      const from = task.status === IN_PROGRESS ? started(task) : null;
      return from ? [{ title: task.title, from }] : [];
    }),
    waiting: record.ask && asked ? { title: record.ask.task.title, from: asked, verb: record.ask.verb } : null,
    blocked: record.counts.blocked,
    parked: record.tasks.flatMap((task) => (task.status === PARKED && task.deferUntil ? [{ title: task.title, until: task.deferUntil }] : [])),
    killDate: record.killDate,
  };
}
