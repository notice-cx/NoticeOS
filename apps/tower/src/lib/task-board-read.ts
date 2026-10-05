import type { LiveTask, LiveTasksPayload, TasksCapabilities, TaskProject, TaskActor } from "@shared/tasks";
import { PRIORITY_BANDS, type WorkItem, type WorkProject, type WorkPayload } from "@shared/work";

export const IN_PROGRESS = "in_progress";
export const PARKED = "deferred";
export const TASK_STATUSES = [
  { key: "open", label: "Open", stored: "open" },
  { key: "in-progress", label: "In progress", stored: IN_PROGRESS },
  { key: "blocked", label: "Blocked", stored: "blocked" },
  { key: "parked", label: "Parked", stored: PARKED },
  { key: "closed", label: "Closed", stored: "closed" },
] as const;
const STORED_TO_KEY = new Map<string, string>(TASK_STATUSES.map(s => [s.stored, s.key]));

/**
 * One row on the board, from either read.
 *
 * `LiveTask` already extends `WorkItem`; this is the same widening applied to a
 * photographed row, so every renderer below takes ONE type and neither read
 * gets a private code path. What the photograph cannot know is stated as an
 * absence (`labels: []`), never invented.
 */
export interface BoardTask extends WorkItem {
  actors?: readonly TaskActor[];
  /** The asset id of the project this row was read from. */
  project: string;
  labels: string[];
  /** Claimable now — `bd ready`'s blocker-aware answer, never re-derived. */
  ready: boolean;
  awaitType: string | null;
  /** What the live read says the task asks for; the photograph carries
   * neither, so an inbox row built from it has no evidence to open. */
  description?: string;
  acceptance?: string;
}

/** What one project contributes to the board's six counts. `urgent` is `null`
 * where the read that wrote it did not measure it — a different fact from zero,
 * and the strip says so rather than quietly summing it as one. */
interface ProjectStats {
  open: number;
  urgent: number | null;
  inProgress: number;
  blocked: number;
  closed: number;
}

export interface BoardProject {
  asset: string;
  prefix: string;
  name: string;
  ok: boolean;
  error: string | null;
  source: "live" | "snapshot" | "unavailable";
  actionable: boolean;
  readAt: string | null;
  closedSince: string | null;
  /** The live read answered with an error for this project: shown, never
   * swallowed. */
  laneError: string | null;
  stats: ProjectStats;
  /** Epic id → title, for the row that expands. An epic is grouping rather than
   * claimable work, so it is never a row of its own. */
  epicNames: Map<string, string>;
  /** Everything the read sent, deduped by id: open, in flight, blocked, parked
   * and this week's closes, in one list. */
  tasks: BoardTask[];
  /** The operator's asks for this project, most-blocking first. */
  waiting: BoardTask[];
  /** What the task database actually holds, when the read was a truncated one. */
  totals: { waiting: number; tasks: number };
}

/** A gate is the wait condition in front of a task, not a task — `bd` titles
 * every one of them "Gate: human" and holds work out of the claimable queue
 * until it is resolved. The photograph marks one with `issueType`; the live read
 * marks it with `awaitType`, so both are read — and a row from the photograph
 * alone (Home's Waiting on you, a site's Needs you) carries no `awaitType`. */
export function isGate(task: Pick<WorkItem, "issueType"> & { awaitType?: string | null }): boolean {
  return task.issueType === "gate" || (task.awaitType ?? null) !== null;
}

/**
 * WHAT THE OPERATOR'S INBOX ASKS OF A TASK, or null when it is not waiting on
 * the operator: a human gate is APPROVED (`bd gate resolve`), and a ready task
 * labelled `human` is ANSWERED or dismissed (`bd human respond` / `dismiss`).
 * The one rule the board's Waiting on you and a task's own page both read, so
 * the two offer the same verbs one click apart (bead `ro-ujb9.243`). A timer
 * or GitHub gate resolves itself and asks nothing.
 */
export type InboxAsk = "approve" | "answer";

export function inboxAsk(
  task: Pick<LiveTask, "issueType" | "status" | "labels" | "ready"> & { awaitType?: string | null },
): InboxAsk | null {
  if (task.status === PARKED || task.status === "closed") return null;
  const waits = isGate(task)
    ? (task.awaitType ?? "human") === "human"
    : task.labels.includes("human") && task.ready;
  return waits ? askVerb(task) : null;
}

/** The verb for a row ALREADY in the inbox — the photograph's `waiting` list
 * says it is, without the labels `inboxAsk` reads. */
export function askVerb(task: Parameters<typeof isGate>[0]): InboxAsk {
  return isGate(task) ? "approve" : "answer";
}

/** The live rows this board renders: not epic containers (they are grouping,
 * not claimable work — the same exclusion the OS makes when it photographs the
 * task database, so the two reads can never disagree about a count), and not a
 * gate that resolves itself. A timer or GitHub gate is nobody's inbox item and
 * nobody's queue row. */
function boardRows(payload: LiveTasksPayload): BoardTask[] {
  return payload.tasks
    .filter((task: LiveTask) => task.issueType !== "epic")
    .filter((task: LiveTask) => task.awaitType === null || task.awaitType === "human")
    .map((task: LiveTask) => ({ ...task, project: payload.project, ...(payload.actors === undefined ? {} : { actors: payload.actors }) }));
}

/** A photographed row, widened. `labels` is empty because the photograph does
 * not carry them — which is why the label filter says so rather than silently
 * matching nothing. */
function snapshotRow(item: WorkItem, project: string, ready: boolean): BoardTask {
  return {
    ...item,
    project,
    labels: [],
    ready,
    awaitType: item.issueType === "gate" ? "human" : null,
  };
}

/** Most-blocking first: a gate leads (it is holding a task out of the claimable
 * queue), then priority, then whatever has gone longest untouched — the ask
 * nobody has answered is the one rotting. */
function inboxOrder(a: BoardTask, b: BoardTask): number {
  const gate = Number(isGate(b)) - Number(isGate(a));
  if (gate !== 0) return gate;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return touchedAt(a) - touchedAt(b);
}

/**
 * THE BOARD'S ONE ORDER, and it is the order the old board's live read already
 * used: live work first, then priority, then whatever has gone longest
 * untouched. Parked work sinks below live work and closed work sinks below
 * that — both are still on the board (doc 05 forbids a deferral that silently
 * vanishes) but neither is what the next hour is spent on.
 */
function boardOrder(a: BoardTask, b: BoardTask): number {
  const rank = restRank(a) - restRank(b);
  if (rank !== 0) return rank;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return touchedAt(a) - touchedAt(b);
}

function restRank(task: BoardTask): number {
  if (task.status === "closed") return 2;
  if (task.status === PARKED) return 1;
  return 0;
}

/** Last activity as a number, with an unparseable stamp sorting oldest rather
 * than making the whole comparison `NaN`. */
function touchedAt(task: BoardTask): number {
  const parsed = Date.parse(task.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One project's rows and counts, from the live read if it answered and from the
 * photograph otherwise.
 *
 * The counts are computed from whichever rows the board renders, so the strip
 * can never disagree with the table under it: a live close removes the row AND
 * decrements the headline in the same paint. The live read carries ALL closes
 * in its stated date window; the snapshot's capped rows are fallback samples.
 */
function buildProject(
  project: WorkProject,
  live: LiveTasksPayload | null,
  laneError: string | null,
  capturedAt: string | null,
): BoardProject {
  const base = {
    asset: project.asset,
    prefix: project.prefix,
    name: project.name,
    ok: project.ok,
    error: project.error,
    laneError,
  };
  if (live === null) {
    const readySet = new Set(project.ready.map((item) => item.id));
    const rows = new Map<string, BoardTask>();
    for (const item of project.ok ? [
      ...project.waiting,
      ...project.ready,
      ...project.inProgress,
      ...project.deferred,
      ...project.recentlyClosed,
    ] : []) {
      if (!rows.has(item.id)) {
        rows.set(item.id, snapshotRow(item, project.asset, readySet.has(item.id)));
      }
    }
    const { open, highPriority, inProgress, blocked, closedRecent } = project.counts;
    return {
      ...base,
      source: project.ok ? "snapshot" : "unavailable",
      actionable: false,
      readAt: project.ok ? capturedAt : null,
      closedSince: null,
      stats: project.ok
        ? { open, urgent: highPriority, inProgress, blocked, closed: closedRecent }
        : { open: 0, urgent: null, inProgress: 0, blocked: 0, closed: 0 },
      epicNames: new Map((project.epics ?? []).map((epic) => [epic.id, epic.title])),
      tasks: [...rows.values()],
      waiting: (project.ok ? project.waiting : []).map((item) =>
        snapshotRow(item, project.asset, readySet.has(item.id)),
      ),
      totals: {
        waiting: project.ok ? project.counts.waiting ?? project.waiting.length : 0,
        tasks: project.ok ? open + inProgress + blocked + closedRecent : 0,
      },
    };
  }

  const tasks = boardRows(live);
  const active = tasks.filter((task) => task.status !== PARKED && task.status !== "closed");
  const waiting = tasks.filter((task) => inboxAsk(task) !== null).sort(inboxOrder);
  return {
    ...base,
    ok: true,
    error: null,
    source: "live",
    actionable: true,
    readAt: live.readAt,
    closedSince: live.closedSince ?? null,
    stats: {
      open: tasks.filter((task) => task.status === "open").length,
      urgent: active.filter((task) => task.priority <= 1).length,
      inProgress: tasks.filter((task) => task.status === IN_PROGRESS).length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
      closed: tasks.filter((task) => task.status === "closed").length,
    },
    epicNames: new Map((live.epics ?? []).map((epic) => [epic.id, epic.title])),
    tasks,
    waiting,
    totals: { waiting: waiting.length, tasks: tasks.length },
  };
}

/** The six counts, summed across every project the board is showing.
 *
 * `urgent` is `null` only when NOTHING measured it; where some projects
 * measured it and others did not, the number is what was measured and
 * `blindUrgent` says how many projects are missing from it. A count that
 * silently absorbs an unmeasured project reads as a smaller queue than there
 * is, which is the one direction this number must never be wrong in. */
function boardTotals(projects: BoardProject[]): {
  waiting: number;
  urgent: number | null;
  blindUrgent: number;
  open: number;
  inProgress: number;
  blocked: number;
  closed: number;
  live: number;
} {
  let urgent = 0;
  let blindUrgent = 0;
  let measured = 0;
  const sum = { waiting: 0, open: 0, inProgress: 0, blocked: 0, closed: 0 };
  for (const project of projects) {
    sum.waiting += project.totals.waiting;
    sum.open += project.stats.open;
    sum.inProgress += project.stats.inProgress;
    sum.blocked += project.stats.blocked;
    sum.closed += project.stats.closed;
    if (project.stats.urgent === null) blindUrgent += 1;
    else {
      urgent += project.stats.urgent;
      measured += 1;
    }
  }
  return {
    ...sum,
    urgent: measured === 0 && blindUrgent > 0 ? null : urgent,
    blindUrgent,
    live: sum.open + sum.inProgress + sum.blocked,
  };
}

/** P0..P4, clamped — `bd` will hand back a priority outside the five bands and
 * a row must still land in exactly one of them. */
function clampBand(priority: number): number {
  return Math.min(Math.max(Math.trunc(priority), 0), 4);
}


export interface TaskBoardFilters {
  project: string;
  status: string;
  priority: string;
  label: string;
  assignee: string;
}
export interface ProjectTaskRead {
  data?: LiveTasksPayload;
  isError: boolean;
  error: unknown;
}
export function taskBoardProjects(snapshot: WorkPayload | null | undefined, scope: string | null): WorkProject[] {
  return (snapshot?.projects ?? []).filter(project => scope === null || project.asset === scope);
}

/** A configured catalog establishes the roster, not measured counts. Missing
 * snapshots stay unavailable until the actual live board answers. */
export function taskCatalogProjects(catalog: readonly TaskProject[], snapshot: WorkPayload | null | undefined): WorkProject[] {
  return catalog.map(project => {
    const stored = snapshot?.projects.find(row => row.asset === project.logicalKey && row.prefix === project.prefix);
    if (stored) return { ...stored, name: project.displayName };
    return { asset: project.logicalKey, prefix: project.prefix, name: project.displayName,
      ok: false, error: null, counts: { open: 0, highPriority: null, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: null, waiting: null },
      history: { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] }, priorities: null, epics: null,
      ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [] };
  });
}

/** One view of the existing hub reads. Only a successful local read for this
 * project permits actions; saved samples retain their full reported counts.
 * Failed refreshes cannot grant actions using previously cached live rows. */
export function readTaskBoard({ capabilities, snapshot, scope = null, reads, filters, roster }: {
  capabilities: TasksCapabilities;
  snapshot: WorkPayload | null | undefined;
  scope?: string | null;
  reads: ReadonlyMap<string, ProjectTaskRead>;
  filters: TaskBoardFilters;
  roster?: readonly WorkProject[];
}) {
  const spokes = roster === undefined ? taskBoardProjects(snapshot, scope) : roster.filter(row => scope === null || row.asset === scope);
  const projects = spokes.map(project => {
    const query = capabilities.live ? reads.get(project.asset) : undefined;
    const mismatched = query?.data !== undefined && query.data.project !== project.asset;
    const laneError = mismatched ? "The local read answered for a different project."
      : query?.isError ? query.error instanceof Error && query.error.message !== ""
        ? query.error.message : "The local read could not reach this repository."
      : null;
    const payload = laneError === null ? query?.data ?? null : null;
    const read = buildProject(project, payload, laneError, snapshot?.capturedAt ?? null);
    return capabilities.writable === false ? { ...read, actionable: false } : read;
  });
  const allTasks = projects.flatMap(project => project.tasks);
  const projectFilter = scope ?? filters.project;
  const matches = (task: BoardTask): boolean =>
    (projectFilter === "all" || task.project === projectFilter) &&
    (filters.status === "all" || STORED_TO_KEY.get(task.status) === filters.status) &&
    (filters.priority === "all" || PRIORITY_BANDS[clampBand(task.priority)] === filters.priority) &&
    (filters.label === "" || task.labels.some(label => label.toLowerCase().includes(filters.label.toLowerCase()))) &&
    (filters.assignee === "all" || (task.assignee ?? "") === filters.assignee);

  const statusCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const assigneeCounts = new Map<string, number>();
  for (const task of allTasks) {
    const status = STORED_TO_KEY.get(task.status);
    if (status !== undefined) statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const priority = PRIORITY_BANDS[clampBand(task.priority)]!;
    priorityCounts.set(priority, (priorityCounts.get(priority) ?? 0) + 1);
    if (task.assignee) assigneeCounts.set(task.assignee, (assigneeCounts.get(task.assignee) ?? 0) + 1);
  }
  const inbox = projects.flatMap(project => project.waiting.map(task => ({ project, task })))
    .filter(row => matches(row.task)).sort((a, b) => inboxOrder(a.task, b.task));
  // ONE ROW PER TASK ON THE PAGE (bead `ro-ujb9.96.7.11`, doc 21 3b): an ask
  // is answered in Waiting on you, so the table below does not list it again.
  const waitingIds = new Set(inbox.map(row => row.task.id));
  const totals = boardTotals(projects);
  const missingProjects = projects.filter(project => !project.ok).length;
  const countsComplete = projects.length > 0 && missingProjects === 0;
  const complete = projects.length > 0 && projects.every(project => project.source === "live");
  const pendingProjects = capabilities.live
    ? projects.filter(project => project.source !== "live" && project.laneError === null) : [];
  // A fresh local read cannot make an older fallback sample look fresh.
  const shownAt = projects.length > 0 && projects.every(project => project.readAt !== null && Number.isFinite(Date.parse(project.readAt)))
    ? projects.map(project => project.readAt!).sort()[0]! : null;
  const boundaries = new Set(projects.map(project => project.closedSince));
  const closedSince = complete && boundaries.size === 1 ? projects[0]!.closedSince : null;
  return {
    spokes, projects, allTasks, totals, complete, pendingProjects, shownAt, closedSince,
    countsComplete, missingProjects,
    counts: {
      waiting: countsComplete ? totals.waiting : null,
      urgent: countsComplete ? totals.urgent : null,
      open: countsComplete ? totals.open : null,
      inProgress: countsComplete ? totals.inProgress : null,
      blocked: countsComplete ? totals.blocked : null,
      closed: countsComplete && (!capabilities.live || complete) ? totals.closed : null,
    },
    live: capabilities.live, reason: capabilities.reason,
    rows: allTasks.filter(task => matches(task) && !waitingIds.has(task.id)).sort(boardOrder), inbox,
    statusCounts, priorityCounts, assigneeCounts,
    projectCounts: new Map(projects.map(project => [project.asset, project.tasks.length])),
    byId: new Map(projects.map(project => [project.asset, project])),
    broken: projects.filter(project => !project.ok || project.laneError !== null),
    closedHistoryState: complete ? "complete" as const : pendingProjects.length > 0 ? "loading" as const : "sample" as const,
    gates: inbox.filter(row => isGate(row.task)).length,
  };
}
