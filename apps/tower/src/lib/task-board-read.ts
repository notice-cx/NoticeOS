import type { LiveTask, LiveTasksPayload, TasksCapabilities, TaskProject, TaskActor } from "@shared/tasks";
import { PRIORITY_BANDS, sumWorkWeeks, type WorkItem, type WorkProject, type WorkPayload } from "@shared/work";
import { TASK_BLOCKING_DEPENDENCIES, waitsOnPerson } from "@noticeos/contract/task-gate";
import { taskSearch } from "./task-search";

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
  /** Work classification for filters; stored status remains available to detail views. */
  workStatus?: string;
  /** Claimable now — `bd ready`'s blocker-aware answer, never re-derived. */
  ready: boolean;
  awaitType: string | null;
  /** What the live read says the task asks for; the photograph carries
   * neither, so an inbox row built from it has no evidence to open. */
  description?: string;
  acceptance?: string;
  dependencies?: LiveTask["dependencies"];
  decisionImpact?: { priority: number; proceeds: readonly { id: string; title: string }[] };
}

/** What one project contributes to the board's six counts. `urgent` is `null`
 * where the read that wrote it did not measure it — a different fact from zero,
 * and the strip says so rather than quietly summing it as one. */
interface ProjectStats {
  /** Not-started work, including the blocked subset. */
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
 * What the operator's inbox asks of a task, or null when it is not waiting on
 * the operator: a human gate is approved (`bd gate resolve`), a ready task
 * labelled `human` is answered or dismissed (`bd human respond` / `dismiss`),
 * and one that carries choices nobody has picked yet is chosen (the choose
 * operation), with Answer and Dismiss still offered. The board's Waiting on
 * you, a task's own page and the agents' task tools all read the one rule,
 * `waitsOnPerson`. A timer or GitHub gate asks nothing.
 */
export type InboxAsk = "approve" | "answer" | "choose";

type AskFacts = Parameters<typeof isGate>[0] & Pick<WorkItem, "choices" | "choice">;

export function inboxAsk(
  task: Pick<LiveTask, "issueType" | "status" | "labels" | "ready"> & AskFacts,
): InboxAsk | null {
  return waitsOnPerson(task) ? askVerb(task) : null;
}

/** The verb for a row ALREADY in the inbox — the photograph's `waiting` list
 * says it is, without the labels `inboxAsk` reads. */
export function askVerb(task: AskFacts): InboxAsk {
  if (isGate(task)) return "approve";
  return (task.choices ?? null) !== null && (task.choice ?? null) === null ? "choose" : "answer";
}

/** The live rows this board renders: not epic containers (they are grouping,
 * not claimable work — the same exclusion the OS makes when it photographs the
 * task database, so the two reads can never disagree about a count), and not a
 * gate that resolves itself. A timer or GitHub gate is nobody's inbox item and
 * nobody's queue row. An epic's own page asks for `containers`, because a
 * child epic is part of what its parent holds. */
export function liveRows(payload: LiveTasksPayload, { containers = false }: { containers?: boolean } = {}): BoardTask[] {
  return payload.tasks
    .filter((task: LiveTask) => containers || task.issueType !== "epic")
    .filter((task: LiveTask) => task.awaitType === null || task.awaitType === "human")
    .map((task: LiveTask) => ({ ...task, project: payload.project, ...(payload.actors === undefined ? {} : { actors: payload.actors }) }));
}

/** A photographed row, widened. `labels` is empty because the photograph does
 * not carry them — which is why the label filter says so rather than silently
 * matching nothing. A link takes the other task's title and status from the
 * row the photograph holds for it, and has no title when it holds none. */
function snapshotRow(item: WorkItem, project: string, ready: boolean, held: ReadonlyMap<string, WorkItem>): BoardTask {
  const { dependencies, ...rest } = item;
  return {
    ...rest,
    project,
    labels: [],
    ready,
    awaitType: item.issueType === "gate" ? "human" : null,
    ...(dependencies === undefined ? {} : {
      dependencies: dependencies.map((edge) => {
        const other = held.get(edge.id);
        return { id: edge.id, type: edge.type, title: other?.title ?? null, status: other?.status ?? edge.status ?? null };
      }),
    }),
  };
}

/** Every row one project's photograph holds, once each. The lists are capped,
 * so this is a sample of the project, never all of it. */
export function snapshotRows(project: WorkProject): BoardTask[] {
  const readySet = new Set(project.ready.map((item) => item.id));
  const items = new Map<string, WorkItem>();
  for (const item of project.ok ? [
    ...project.waiting,
    ...project.ready,
    ...project.inProgress,
    ...(project.blocked ?? []),
    ...project.deferred,
    ...project.recentlyClosed,
  ] : []) {
    if (!items.has(item.id)) items.set(item.id, item);
  }
  return [...items.values()].map((item) => snapshotRow(item, project.asset, readySet.has(item.id), items));
}

const blocks = (edge: { type: string }) => TASK_BLOCKING_DEPENDENCIES.includes(edge.type);

/** Approvals and containers remain addressable, but are not completed work. */
function isWork(task: BoardTask): boolean {
  return task.issueType !== "epic" && !isGate(task);
}

/** In-flight, parked and closed work keep their status. Only not-started work
 * joins Blocked; a saved blocked list remains evidence when links are absent. */
function withWorkStatus(
  rows: readonly BoardTask[],
  blockedIds: ReadonlySet<string> = new Set(),
  statuses: ReadonlyMap<string, string> = new Map(rows.map(task => [task.id, task.status])),
): BoardTask[] {
  return rows.map(task => ({ ...task, workStatus: task.status === "open" && (
    blockedIds.has(task.id) || task.dependencies?.some(edge => {
      if (!blocks(edge)) return false;
      const status = statuses.get(edge.id) ?? edge.status;
      // Ready confirms that an unlisted blocker closed outside the read window.
      return status == null ? !task.ready : status !== "closed";
    })
  ) ? "blocked" : task.status }));
}

/**
 * What answering each row releases: the open tasks among `rows` it holds whose
 * every other blocker is known to be closed. A row whose read recorded no links
 * (a snapshot an older poller wrote) gets no `decisionImpact`, so it never
 * reads as releasing nothing. From the snapshot the rows are its capped
 * sample, so a task the snapshot does not list is not counted.
 */
function withDecisionImpact(rows: readonly BoardTask[]): BoardTask[] {
  const byId = new Map(rows.map(task => [task.id, task]));
  return rows.map(task => {
    if (task.dependencies === undefined) return task;
    const proceeds = rows.filter(candidate => candidate.issueType !== "epic" && !isGate(candidate)
      && candidate.status !== "closed" && candidate.status !== PARKED
      && candidate.dependencies?.some(edge => blocks(edge) && edge.id === task.id)
      && candidate.dependencies.every(edge => !blocks(edge) || edge.id === task.id || (byId.get(edge.id)?.status ?? edge.status) === "closed")
      && !(isGate(task) && candidate.choices && !candidate.choice));
    return { ...task, decisionImpact: { priority: Math.min(...(isGate(task) && proceeds.length ? [] : [task.priority]), ...proceeds.map(row => row.priority)),
      proceeds: proceeds.map(({ id, title }) => ({ id, title })) } };
  });
}

/** Rank by the work an answer releases, then age. Approval records inherit
 * their dependent work's urgency rather than outranking every decision. */
export function inboxOrder(a: BoardTask, b: BoardTask): number {
  const priority = (a.decisionImpact?.priority ?? a.priority) - (b.decisionImpact?.priority ?? b.priority);
  if (priority !== 0) return priority;
  const releases = (b.decisionImpact?.proceeds.length ?? 0) - (a.decisionImpact?.proceeds.length ?? 0);
  if (releases !== 0) return releases;
  const gate = Number(isGate(b)) - Number(isGate(a));
  if (gate !== 0) return gate;
  return touchedAt(a) - touchedAt(b);
}

/**
 * The board's one order: live work first, then priority, then whatever has
 * gone longest untouched. Parked work sinks below live work and closed work
 * below that; both are still on the board, because a deferral must never
 * silently vanish.
 */
export function boardOrder(a: BoardTask, b: BoardTask): number {
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
 * Live work counts come from complete rows in the read's stated date window.
 * Snapshot counts remain authoritative: its capped rows are fallback samples.
 * Open includes blocked work in both reads; in-progress work is separate.
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
    const tasks = withDecisionImpact(withWorkStatus(snapshotRows(project), new Set(project.blocked?.map(item => item.id))));
    const byId = new Map(tasks.map((task) => [task.id, task]));
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
      tasks,
      waiting: (project.ok ? project.waiting : []).flatMap((item) => byId.get(item.id) ?? []),
      totals: {
        waiting: project.ok ? project.counts.waiting ?? project.waiting.length : 0,
        tasks: project.ok ? open + inProgress + closedRecent : 0,
      },
    };
  }

  const tasks = withDecisionImpact(withWorkStatus(liveRows(live), new Set(), new Map(live.tasks.map(task => [task.id, task.status]))));
  const work = tasks.filter(isWork);
  const active = work.filter((task) => task.status !== PARKED && task.status !== "closed");
  // An approval is the one question for its blocked parent. Its task remains
  // accessible in All tasks, without a second competing inbox row.
  const approvals = new Set(tasks.filter(task => isGate(task) && inboxAsk(task) !== null).map(task => task.id));
  const waiting = tasks.filter((task) => inboxAsk(task) !== null
    && !task.dependencies?.some(edge => blocks(edge) && approvals.has(edge.id))).sort(inboxOrder);
  return {
    ...base,
    ok: true,
    error: null,
    source: "live",
    actionable: true,
    readAt: live.readAt,
    closedSince: live.closedSince ?? null,
    stats: {
      open: work.filter((task) => task.status === "open" || task.status === "blocked").length,
      urgent: active.filter((task) => task.priority <= 1).length,
      inProgress: work.filter((task) => task.status === IN_PROGRESS).length,
      blocked: work.filter((task) => task.workStatus === "blocked").length,
      closed: work.filter((task) => task.status === "closed").length,
    },
    epicNames: new Map((live.epics ?? []).map((epic) => [epic.id, epic.title])),
    tasks,
    waiting,
    totals: { waiting: waiting.length, tasks: work.filter(task => task.status !== PARKED).length },
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
    live: sum.open + sum.inProgress,
  };
}

/** P0..P4, clamped — `bd` will hand back a priority outside the five bands and
 * a row must still land in exactly one of them. */
function clampBand(priority: number): number {
  return Math.min(Math.max(Math.trunc(priority), 0), 4);
}


export interface TaskBoardFilters {
  q?: string;
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

/** Both live catalogs and configured task selectors exclude archived projects. */
export function taskProjectsWithoutArchives<T extends { prefix: string }>(projects: readonly T[], snapshot: WorkPayload | null | undefined): T[] {
  const archived = new Set(snapshot?.archivedProjects?.map(project => project.prefix) ?? []);
  return projects.filter(project => !archived.has(project.prefix));
}

/** A configured catalog establishes the roster, not measured counts. Missing
 * snapshots stay unavailable until the actual live board answers. The catalog
 * keys a project by its logical key and the snapshot by its asset id; the task
 * prefix is the identity both carry, so it joins them. A roster row keeps the
 * logical key as `asset`, because that is what the hosted read is addressed by. */
export function taskCatalogProjects(catalog: readonly TaskProject[], snapshot: WorkPayload | null | undefined): WorkProject[] {
  return taskProjectsWithoutArchives(catalog, snapshot).map(project => {
    const stored = snapshot?.projects.find(row => row.prefix === project.prefix);
    if (stored) return { ...stored, asset: project.logicalKey, name: project.displayName };
    return { asset: project.logicalKey, prefix: project.prefix, name: project.displayName,
      ok: false, error: null, counts: { open: 0, highPriority: null, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: null, waiting: null },
      history: { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] }, priorities: null, epics: null,
      ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [] };
  });
}

/** An asset's Tasks tab scopes the board by the site id the page is about,
 * while a catalog board is addressed by logical key. Resolve the page's scope
 * through the snapshot row that names the site; a scope the snapshot does not
 * know stays as given, so an already-logical key passes through unchanged. */
export function catalogScope(catalog: readonly TaskProject[], snapshot: WorkPayload | null | undefined, scope: string | null): string | null {
  if (scope === null) return null;
  const stored = snapshot?.projects.find(row => row.asset === scope);
  const project = stored ? catalog.find(row => row.prefix === stored.prefix) : undefined;
  return project?.logicalKey ?? scope;
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
    // A failed refresh keeps the rows its last good read drew, without
    // actions, instead of redrawing the project from the older snapshot.
    const payload = mismatched ? null : query?.data ?? null;
    const read = buildProject(project, payload, laneError, snapshot?.capturedAt ?? null);
    return capabilities.writable === false || laneError !== null ? { ...read, actionable: false } : read;
  });
  const allTasks = projects.flatMap(project => project.tasks);
  const projectFilter = scope ?? filters.project;
  const matchesSearch = taskSearch(filters.q ?? "");
  const matches = (task: BoardTask): boolean =>
    matchesSearch(task) &&
    (projectFilter === "all" || task.project === projectFilter) &&
    (filters.status === "all" || STORED_TO_KEY.get(isWork(task) ? task.workStatus ?? task.status : task.status) === filters.status) &&
    (filters.priority === "all" || PRIORITY_BANDS[clampBand(task.priority)] === filters.priority) &&
    (filters.label === "" || task.labels.some(label => label.toLowerCase().includes(filters.label.toLowerCase()))) &&
    (filters.assignee === "all" || (task.assignee ?? "") === filters.assignee);

  const statusCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const assigneeCounts = new Map<string, number>();
  for (const task of allTasks) {
    // Assignees also filter the inbox, including people assigned only approvals.
    if (task.assignee) assigneeCounts.set(task.assignee, (assigneeCounts.get(task.assignee) ?? 0) + 1);
    if (!isWork(task)) continue;
    const status = STORED_TO_KEY.get(task.workStatus ?? task.status);
    if (status !== undefined) statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const priority = PRIORITY_BANDS[clampBand(task.priority)]!;
    priorityCounts.set(priority, (priorityCounts.get(priority) ?? 0) + 1);
  }
  const inbox = projects.flatMap(project => project.waiting.map(task => ({ project, task })))
    .filter(row => matches(row.task)).sort((a, b) => inboxOrder(a.task, b.task));
  // One row per task on the page: an ask is answered in Waiting on you, so
  // the table below does not list it again.
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
  // Every figure's week through the one derivation the Wall reads
  // (`workWeeks`), whichever read drew the rows: done from each project's
  // closes, the states from the daily history.
  const weeks = sumWorkWeeks(spokes.map(project => project.weeks));
  // Done so far from the projects that have a reading, for a board missing one.
  const doneRead = spokes.flatMap(project => project.weeks?.done.now ?? []);
  return {
    spokes, projects, allTasks, totals, complete, pendingProjects, shownAt, closedSince,
    countsComplete, missingProjects, weeks,
    doneRead: doneRead.length === 0 ? null : doneRead.reduce((sum, count) => sum + count, 0),
    counts: {
      waiting: countsComplete ? totals.waiting : null,
      urgent: countsComplete ? totals.urgent : null,
      open: countsComplete ? totals.open : null,
      inProgress: countsComplete ? totals.inProgress : null,
      blocked: countsComplete ? totals.blocked : null,
      closed: countsComplete && (!capabilities.live || complete) ? totals.closed : null,
    },
    live: capabilities.live, reason: capabilities.reason,
    rows: allTasks.filter(task => isWork(task) && matches(task) && !waitingIds.has(task.id)).sort(boardOrder), inbox,
    statusCounts, priorityCounts, assigneeCounts,
    projectCounts: new Map(projects.map(project => [project.asset, project.tasks.filter(isWork).length])),
    byId: new Map(projects.map(project => [project.asset, project])),
    broken: projects.filter(project => !project.ok || project.laneError !== null),
    closedHistoryState: complete ? "complete" as const : pendingProjects.length > 0 ? "loading" as const : "sample" as const,
    gates: inbox.filter(row => isGate(row.task)).length,
  };
}
