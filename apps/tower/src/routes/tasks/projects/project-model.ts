// The Projects tab's one derivation: every epic on the board as a project of
// its site, with where it stands, what it asks of the operator, what moves
// next and one bar segment per task. It re-reads what `readTaskBoard` already
// decided; a fact the read does not carry (a snapshot row has no claim time,
// and one an older poller wrote has no links) stays absent rather than being
// invented.
import { TASK_CHANGE_CLASSES, type TaskChangeClass } from "@noticeos/contract/task-change-class";
import { TASK_BLOCKING_DEPENDENCIES } from "@noticeos/contract/task-gate";
import { taskActorLabel } from "@shared/tasks";
import type { WorkEpic, WorkProject } from "@shared/work";
import { TASK_BAR_ORDER, type TaskBarSegment, type TaskBarState } from "@/components/viz/TaskProgressBar";
import { IN_PROGRESS, PARKED, askVerb, type BoardProject, type BoardTask, type InboxAsk } from "@/lib/task-board-read";
import { cardOf, taskAgeDays } from "@/lib/task-ranking";

/** Where a project stands, in the order "Needs attention first" ranks them. */
export const PROJECT_STATES = ["needs-you", "urgent", "blocked", "in-progress", "ready", "not-started", "parked", "done"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export interface ProjectAsk {
  task: BoardTask;
  verb: InboxAsk;
  /** Days since it was filed (else since it last moved); null when neither is known. */
  ageDays: number | null;
}

export interface ProjectNext {
  task: BoardTask;
  /** Who holds it, as the board names them; null while nobody does. */
  who: string | null;
}

export interface ProjectRecord {
  id: string;
  title: string;
  site: { asset: string; name: string };
  /** The container's own stored status, when the snapshot's rollup carries it. */
  status: string | null;
  total: number;
  closed: number;
  counts: { open: number; inProgress: number; blocked: number; deferred: number };
  kind: TaskChangeClass | null;
  /** Most of its tasks are bugs. */
  bugHeavy: boolean;
  state: ProjectState;
  ask: ProjectAsk | null;
  /** The first ready task, else the task in progress with who holds it. */
  next: ProjectNext | null;
  /** The first task in progress, with who holds it. */
  working: ProjectNext | null;
  segments: TaskBarSegment[];
  /** The ask's age. */
  agesDays: number | null;
  /** The earliest kill date any of its tasks' cards names. */
  killDate: string | null;
  /** What its open tasks' cards say they are worth a month, summed; null when none carries one. */
  valuePerMonth: number | null;
  /** Tasks not yet closed, the ones the read cannot place included. */
  open: number;
  /** The newest close among its tasks in the read. */
  closedAt: string | null;
  /** Its tasks the read holds. */
  tasks: BoardTask[];
  /** Whether the verbs can run on this project's rows here. */
  actionable: boolean;
}

export interface SiteProjects {
  site: { asset: string; name: string };
  /** The read could not reach this site's tasks. */
  unread: boolean;
  projects: ProjectRecord[];
  /** Open tasks that hang off no project. */
  loose: number;
  /** Open tasks in all. */
  open: number;
  /** Projects waiting on the operator. */
  forYou: number;
  /** The live read lists every open task; the snapshot only a sample, so its counts are lower bounds. */
  complete: boolean;
}

const closed = (task: BoardTask) => task.status === "closed";
const active = (task: BoardTask) => task.status !== "closed" && task.status !== PARKED;

/** A task's segment. A question waiting on the operator outranks its stored status. */
function barState(task: BoardTask, asked: boolean): TaskBarState {
  if (closed(task)) return "done";
  if (asked) return "needs-you";
  if (task.status === PARKED) return "parked";
  if (task.status === "blocked") return "blocked";
  if (task.status === IN_PROGRESS) return "in-progress";
  return task.ready ? "ready" : "waiting";
}

/** Oldest first within a priority: the work that has waited longest. */
function byPriorityThenAge(a: BoardTask, b: BoardTask): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return stamp(a.createdAt ?? a.updatedAt) - stamp(b.createdAt ?? b.updatedAt) || a.id.localeCompare(b.id, undefined, { numeric: true });
}

function stamp(iso: string | null | undefined): number {
  const parsed = Date.parse(iso ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function holder(task: BoardTask): string | null {
  return task.assignee ? taskActorLabel(task.assignee, task.actors) : null;
}

/** The class the epic records, else the one most of its tasks carry. */
function kindOf(self: BoardTask | undefined, children: readonly BoardTask[]): TaskChangeClass | null {
  if (self?.changeClass) return self.changeClass;
  const counts = new Map<TaskChangeClass, number>();
  for (const task of children) if (task.changeClass) counts.set(task.changeClass, (counts.get(task.changeClass) ?? 0) + 1);
  let best: TaskChangeClass | null = null;
  for (const kind of TASK_CHANGE_CLASSES) {
    const n = counts.get(kind) ?? 0;
    if (n > 0 && (best === null || n > (counts.get(best) ?? 0))) best = kind;
  }
  return best;
}

/**
 * One epic as a project. The read's own tasks set each segment; the
 * snapshot's rollup, which counts every child, raises a count the read's
 * sample misses, and what the rollup counts and nobody placed is `unknown`.
 */
function epicRecord(project: BoardProject, epicId: string, title: string, rollup: WorkEpic | undefined, now: Date): ProjectRecord {
  const children = project.tasks.filter((task) => task.parent === epicId);
  const waiting = new Set(project.waiting.map((task) => task.id));
  // What the operator is asked inside the project, then an approval outside
  // it that holds one of its tasks: either way the project waits on them.
  const holding = new Set(children.flatMap((task) => (task.dependencies ?? [])
    .filter((edge) => TASK_BLOCKING_DEPENDENCIES.includes(edge.type)).map((edge) => edge.id)));
  const asks = [
    ...project.waiting.filter((task) => task.parent === epicId && !closed(task)),
    ...project.waiting.filter((task) => task.parent !== epicId && holding.has(task.id) && !closed(task)),
  ];
  const read = new Map<TaskBarState, number>();
  for (const task of children) {
    const state = barState(task, waiting.has(task.id));
    read.set(state, (read.get(state) ?? 0) + 1);
  }

  const n = (state: TaskBarState) => read.get(state) ?? 0;
  const count: Record<TaskBarState, number> = Object.fromEntries(TASK_BAR_ORDER.map((state) => [state, n(state)])) as Record<TaskBarState, number>;
  if (rollup) {
    count.done = Math.max(count.done, rollup.closed);
    if (project.source !== "live") {
      count["in-progress"] = Math.max(count["in-progress"], rollup.counts.inProgress);
      count.blocked = Math.max(count.blocked, rollup.counts.blocked);
      count.parked = Math.max(count.parked, rollup.counts.deferred);
      const openKnown = count["needs-you"] + count.ready + count.waiting;
      count.unknown += Math.max(0, rollup.counts.open - openKnown);
    }
    const placed = TASK_BAR_ORDER.reduce((sum, state) => sum + count[state], 0);
    count.unknown += Math.max(0, rollup.total - placed);
  }
  const total = TASK_BAR_ORDER.reduce((sum, state) => sum + count[state], 0);
  const segments = TASK_BAR_ORDER.flatMap((state) => Array.from({ length: count[state] }, () => ({ state })));

  const live = children.filter(active);
  const movable = count["in-progress"] + count["needs-you"] + count.blocked + count.ready + count.waiting;
  const ask = asks[0] ?? null;
  const ageDays = ask ? taskAgeDays(ask, now) : null;
  const state: ProjectState =
    ask !== null ? "needs-you"
    : live.some((task) => task.priority <= 1) ? "urgent"
    : movable > 0 && count.blocked + count.waiting === movable && count.unknown === 0 ? "blocked"
    : count["in-progress"] > 0 ? "in-progress"
    : count.ready > 0 ? "ready"
    : count.parked > 0 && movable === 0 && count.unknown === 0 ? "parked"
    : total > 0 && count.done === total ? "done"
    : "not-started";

  const ready = children.filter((task) => !closed(task) && !waiting.has(task.id) && task.status !== PARKED && task.status !== "blocked" && task.status !== IN_PROGRESS && task.ready).sort(byPriorityThenAge);
  const inProgress = children.filter((task) => task.status === IN_PROGRESS).sort(byPriorityThenAge);
  const working = inProgress[0] ? { task: inProgress[0], who: holder(inProgress[0]) } : null;
  const next = ready[0] ? { task: ready[0], who: holder(ready[0]) } : working;

  const cards = children.map((task) => ({ task, card: cardOf(task) }));
  const kills = cards.flatMap(({ card }) => (card?.kill?.date ? [card.kill.date] : [])).sort();
  const values = cards.filter(({ task, card }) => !closed(task) && card !== null).map(({ card }) => card!.valuePerMonth);
  const closes = children.flatMap((task) => (closed(task) && task.closedAt ? [task.closedAt] : [])).sort();
  const self = project.tasks.find((task) => task.id === epicId);
  const bugs = children.filter((task) => task.issueType === "bug").length;

  return {
    id: epicId,
    title,
    site: { asset: project.asset, name: project.name },
    status: rollup?.status ?? null,
    total,
    closed: count.done,
    counts: {
      open: count["needs-you"] + count.ready + count.waiting + (total - count.done - movable - count.parked),
      inProgress: count["in-progress"],
      blocked: count.blocked,
      deferred: count.parked,
    },
    kind: kindOf(self, children),
    bugHeavy: children.length > 0 && bugs * 2 > children.length,
    state,
    ask: ask ? { task: ask, verb: askVerb(ask), ageDays } : null,
    next,
    working,
    segments,
    agesDays: ageDays,
    killDate: kills[0] ?? null,
    valuePerMonth: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null,
    open: total - count.done,
    closedAt: closes.at(-1) ?? null,
    tasks: children,
    actionable: project.actionable,
  };
}

/** The rollup a project's snapshot carries, joined the way the board's graph joins it. */
function rollupOf(project: BoardProject, snapshots: readonly WorkProject[]): Map<string, WorkEpic> {
  const row = snapshots.find((candidate) => candidate.prefix === project.prefix) ?? snapshots.find((candidate) => candidate.asset === project.asset);
  return new Map((row?.epics ?? []).map((epic) => [epic.id, epic]));
}

/** Every site the board read, each with its projects and the open work that hangs off none. */
export function projectModel({ projects, snapshots, now }: {
  projects: readonly BoardProject[];
  snapshots: readonly WorkProject[];
  now: Date;
}): SiteProjects[] {
  return projects.map((project) => {
    const rollup = rollupOf(project, snapshots);
    const titles = new Map<string, string>(project.epicNames);
    for (const [id, epic] of rollup) if (!titles.has(id)) titles.set(id, epic.title);
    const records = [...titles].map(([id, title]) => epicRecord(project, id, title, rollup.get(id), now));
    const loose = project.tasks.filter((task) => !closed(task) && (task.parent === null || !titles.has(task.parent))).length;
    const open = project.tasks.filter((task) => !closed(task)).length;
    return {
      site: { asset: project.asset, name: project.name },
      unread: project.source === "unavailable",
      projects: records,
      loose,
      open: Math.max(open, records.reduce((sum, record) => sum + record.open, 0) + loose),
      forYou: records.filter((record) => record.state === "needs-you").length,
      complete: project.source === "live",
    };
  });
}

// --- order ---------------------------------------------------------------------

export type ProjectSort = "attention" | "open" | "az";

/** The three orders, as their pills read. */
export const PROJECT_SORTS: readonly { key: ProjectSort; label: string }[] = [
  { key: "attention", label: "Needs attention first" },
  { key: "open", label: "Most open work" },
  { key: "az", label: "A–Z" },
];

const byTitle = (a: ProjectRecord, b: ProjectRecord) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id);

/** What needs the operator first: the oldest question, then urgent, blocked,
 * moving, ready, unstarted, parked and finished work; ties by open work. */
export function attentionOrder(a: ProjectRecord, b: ProjectRecord): number {
  const rank = PROJECT_STATES.indexOf(a.state) - PROJECT_STATES.indexOf(b.state);
  if (rank !== 0) return rank;
  if (a.state === "needs-you") {
    const age = (b.agesDays ?? -1) - (a.agesDays ?? -1);
    if (age !== 0) return age;
  }
  return b.open - a.open || byTitle(a, b);
}

export function sortProjects(records: readonly ProjectRecord[], mode: ProjectSort): ProjectRecord[] {
  const order = mode === "attention" ? attentionOrder : mode === "open" ? (a: ProjectRecord, b: ProjectRecord) => b.open - a.open || attentionOrder(a, b) : byTitle;
  return [...records].sort(order);
}

/** Sites in the same order as their projects: by their first project, by their open work, or by name. */
export function sortSites(sites: readonly SiteProjects[], mode: ProjectSort): SiteProjects[] {
  const byName = (a: SiteProjects, b: SiteProjects) => a.site.name.localeCompare(b.site.name) || a.site.asset.localeCompare(b.site.asset);
  const sorted = sites.map((site) => ({ ...site, projects: sortProjects(site.projects, mode) }));
  if (mode === "az") return sorted.sort(byName);
  if (mode === "open") return sorted.sort((a, b) => b.open - a.open || byName(a, b));
  return sorted.sort((a, b) => {
    const first = (site: SiteProjects) => site.projects[0];
    const left = first(a);
    const right = first(b);
    if (left && right) return attentionOrder(left, right) || b.forYou - a.forYou || byName(a, b);
    if (left || right) return left ? -1 : 1;
    return b.open - a.open || byName(a, b);
  });
}

/** Every project on the board, in one order. */
export function allProjects(sites: readonly SiteProjects[], mode: ProjectSort): ProjectRecord[] {
  return sortProjects(sites.flatMap((site) => site.projects), mode);
}
