// The task board's reads drawn as the visual kit's shapes: the operator's
// queue, each project's work, the board's days in and out, and one epic's
// dependencies. Each function re-reads what `readTaskBoard` already decided;
// a day or an edge nobody read stays absent rather than becoming a zero.
import type { TaskActor, TaskDependency } from "@shared/tasks";
import { taskActorLabel } from "@shared/tasks";
import { ageMs, formatAge } from "@shared/freshness";
import { sumWorkHistory, type WorkDoneWeek, type WorkEpic, type WorkProject, type WorkWeeks } from "@shared/work";
import type { BarStripPoint } from "@/components/viz/BarStrip";
import type { QueueItem } from "@/components/viz/DecisionQueue";
import { flowLayers, type FlowEdge, type FlowEdgeState, type FlowNode } from "@/components/viz/FlowGraph";
import type { WorkFlowRow } from "@/components/viz/WorkFlow";
import { formatInt } from "@/lib/format";
import { IN_PROGRESS, PARKED, inboxAsk, isGate, type BoardProject, type BoardTask, type InboxAsk } from "@/lib/task-board-read";

const DAY_MS = 86_400_000;

/** The UTC calendar day an instant falls in: the day the work history keys by. */
function utcDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

// --- the queue ----------------------------------------------------------------

/** One ask as the queue's item: its age is how long it has sat untouched. */
export function queueItem({ project, task }: { project: BoardProject; task: BoardTask }, nowMs: number): QueueItem {
  const age = ageMs(nowMs, task.updatedAt);
  return {
    id: task.id,
    title: task.title,
    project: project.name,
    kind: isGate(task) ? "approval" : "question",
    ageDays: age === null ? null : age / DAY_MS,
  };
}

// --- work by project ------------------------------------------------------------

/**
 * Each read project as a work-flow row, from the same counts the answer's
 * figures sum. In the saved snapshot `open` includes the blocked tasks; in the
 * live read `blocked` is the stored status and `open` excludes it, so the
 * Blocked figure, the status filter and the hatched segment count one set. A
 * project neither read reached is left out, never drawn as an empty queue.
 * Done is this calendar week's done closes from the project's week reading, as
 * the Wall draws it, with last week's beside it; without one, the read's closes.
 */
export function boardWorkRows(
  projects: readonly BoardProject[],
  to?: (project: BoardProject) => string,
  weeks: ReadonlyMap<string, WorkWeeks> = new Map(),
): WorkFlowRow[] {
  return projects.flatMap((project) => {
    if (project.source === "unavailable") return [];
    const { open, inProgress, blocked, closed, urgent } = project.stats;
    const week = weeks.get(project.asset)?.done;
    return [{
      id: project.asset,
      name: project.name,
      to: to?.(project),
      done: week?.now ?? closed,
      doneLastWeek: week?.lastWeek ?? null,
      inProgress,
      ready: project.source === "live" ? open : Math.max(0, open - blocked),
      blocked,
      urgent,
    }];
  });
}

// --- in and out -----------------------------------------------------------------

export interface InOut {
  /** Closed a day; null where no read measured the day. */
  closed: BarStripPoint[];
  /** Filed a day, or null when no read on this board can count filings. */
  filed: BarStripPoint[] | null;
  /** Today, still being counted. */
  today: string;
}

/**
 * The board's last `days` days of work closed and work filed. A closing is
 * counted from the live read inside its closed window when every project was
 * read live, and from the daily history before that (or throughout, when the
 * live read is partial). A filing is counted only from a complete live read
 * and only inside its window: a task filed and closed before the window is in
 * neither read, so an earlier day is unmeasured rather than low. The first day
 * of the window is left to the history, because whether `bd` includes the
 * boundary day is not this code's to assume. Approvals are asks, not work, and
 * are counted in neither series, as the history does not count them.
 */
export function boardInOut(projects: readonly BoardProject[], snapshots: readonly WorkProject[], nowMs: number, days = 14): InOut {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const keys = Array.from({ length: days }, (_, index) => new Date(nowMs - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10));
  const boundaries = new Set(projects.map((project) => project.closedSince));
  const since = projects.length > 0 && projects.every((project) => project.source === "live") && boundaries.size === 1 ? projects[0]!.closedSince : null;
  const live = since === null ? null : projects.flatMap((project) => project.tasks).filter((task) => !isGate(task));
  const inWindow = (day: string) => since !== null && day > since;
  const tally = (pick: (task: BoardTask) => string | null) => {
    const counts = new Map<string, number>();
    for (const task of live ?? []) {
      const day = pick(task);
      if (day !== null) counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return counts;
  };
  const closedLive = tally((task) => (task.status === "closed" ? utcDay(task.closedAt) : null));
  const filedLive = tally((task) => utcDay(task.createdAt));
  const history = new Map(sumWorkHistory(snapshots).closed.map((point) => [point.t, point.v]));
  return {
    today,
    closed: keys.map((t) => ({ t, v: inWindow(t) ? (closedLive.get(t) ?? 0) : (history.get(t) ?? null) })),
    filed: live === null ? null : keys.map((t) => ({ t, v: inWindow(t) ? (filedLive.get(t) ?? 0) : null })),
  };
}

/** Whether either strip measured a single day: a panel of two empty strips is
 * not drawn. */
export function inOutDrawn(inOut: InOut): boolean {
  return [...inOut.closed, ...(inOut.filed ?? [])].some((point) => point.v !== null);
}

/** A strip's settled total and daily average, over the days it measured. */
export function stripTotals(points: readonly BarStripPoint[], today: string): { total: number; days: number; average: number | null } {
  const measured = points.filter((point) => point.v !== null);
  const settled = measured.filter((point) => point.t < today);
  const total = measured.reduce((sum, point) => sum + point.v!, 0);
  return {
    total,
    days: measured.length,
    average: settled.length >= 3 ? settled.reduce((sum, point) => sum + point.v!, 0) / settled.length : null,
  };
}

/** Done this week against last week by the same point, as one line under In
 * and out; null when there is nothing to compare. */
export function weekLine(week: WorkDoneWeek | null | undefined): string | null {
  const move = week?.move ?? null;
  if (move === null) return null;
  if (move.by === 0) return "As many done this week as last week by today";
  return `${formatInt(Math.abs(move.by))} ${move.by > 0 ? "more" : "fewer"} done this week than last week by today`;
}

/** Closed against filed over the days both measured: positive when the queue
 * shrank. Null when the two share no measured day. */
export function netFlow(inOut: InOut): { closed: number; filed: number; days: number } | null {
  if (inOut.filed === null) return null;
  let closed = 0;
  let filed = 0;
  let days = 0;
  inOut.closed.forEach((point, index) => {
    const other = inOut.filed![index]!;
    if (point.v === null || other.v === null) return;
    closed += point.v;
    filed += other.v;
    days += 1;
  });
  return days === 0 ? null : { closed, filed, days };
}

// --- one epic's dependencies ------------------------------------------------------

/** The most nodes one epic's graph draws; the rest stay in the table. */
export const EPIC_GRAPH_NODES = 12;

export interface EpicGraph {
  id: string;
  title: string;
  project: BoardProject;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Blocked or parked tasks holding another task in the graph. */
  stuck: number;
  /** Nodes waiting on the operator. */
  asks: number;
  /** All-time progress from the snapshot's epic rollup, when it carried one. */
  progress: { closed: number; total: number } | null;
  /** Children in the read that the graph leaves out. */
  hidden: number;
}

/** `blocks` edges only: what `bd ready` waits on. A list row carries the edge
 * on the dependent, pointing at its blocker. */
function blockers(task: BoardTask): string[] {
  const deps = (task as BoardTask & { dependencies?: readonly TaskDependency[] }).dependencies;
  return Array.isArray(deps) ? deps.filter((dep) => dep.type === "blocks").map((dep) => dep.id) : [];
}

const finished = (task: BoardTask) => task.status === "closed";

/** How many unfinished tasks in the read this one waits on. */
function waitingOnCount(task: BoardTask, byId: ReadonlyMap<string, BoardTask>): number {
  return blockers(task).filter((id) => byId.has(id) && !finished(byId.get(id)!)).length;
}

/** Where a task stands, in the board's words, in the order an epic's page
 * groups its tasks: what needs the operator first, what is finished last. */
export const TASK_STATE_WORDS = ["Needs attention", "In progress", "Ready", "Waiting", "Not started", "Blocked", "Parked", "Done"] as const;
export type TaskStateWord = (typeof TASK_STATE_WORDS)[number];

/** A task's word. `waitingOn` counts the unfinished tasks in the read it waits
 * on; `ask` is what the operator's inbox asks of it, passed in because the
 * saved snapshot knows an ask by its list rather than by its labels. */
export function taskStateWord(task: Pick<BoardTask, "status" | "ready">, waitingOn: number, ask: InboxAsk | null): TaskStateWord {
  if (task.status === "closed") return "Done";
  if (task.status === PARKED) return "Parked";
  if (ask !== null) return "Needs attention";
  if (task.status === "blocked") return "Blocked";
  if (task.status === IN_PROGRESS) return "In progress";
  if (waitingOn > 0) return "Waiting";
  return task.ready ? "Ready" : "Not started";
}

/** A task as a node: its status as the node's state and word, the fact that
 * matters for that state as its caption. Blocked and asks wear warn, as their
 * rows do; the graph draws no task in error ink. */
function epicNode(task: BoardTask, waitingOn: number, nowMs: number, actors: readonly TaskActor[] | undefined, href: (task: BoardTask) => string): FlowNode {
  const base = { id: task.id, label: task.title, href: href(task), caption: task.id };
  const ask = inboxAsk(task);
  const word = taskStateWord(task, waitingOn, ask);
  switch (word) {
    case "Done": {
      const age = ageMs(nowMs, task.closedAt);
      return { ...base, state: "ok", stateLabel: word, caption: age === null ? task.id : `closed ${formatAge(age)} ago` };
    }
    case "Parked":
      return { ...base, state: "absent", stateLabel: word, caption: task.deferUntil ? `until ${task.deferUntil.slice(0, 10)}` : task.id };
    case "Needs attention":
      return { ...base, state: "warn", stateLabel: word, caption: ask === "approve" ? "your approval" : ask === "choose" ? "your choice" : "your answer", since: task.updatedAt };
    case "Blocked":
      return { ...base, state: "warn", stateLabel: word, since: task.updatedAt };
    case "In progress":
      return { ...base, state: "active", stateLabel: word, caption: task.assignee ? taskActorLabel(task.assignee, actors) : task.id };
    case "Waiting":
      return { ...base, state: "idle", stateLabel: word, caption: `waits on ${waitingOn}` };
    default:
      return { ...base, state: "idle", stateLabel: word };
  }
}

/** One epic's unfinished children, the tasks in the read that hold them, and
 * the edges between those: what the board's graph draws for the epic. */
function epicChain(tasks: readonly BoardTask[], byId: ReadonlyMap<string, BoardTask>, epicId: string) {
  const children = tasks.filter((task) => task.parent === epicId);
  const open = children.filter((task) => !finished(task));
  const keep = new Map(open.map((task) => [task.id, task]));
  // What holds the unfinished children, and what released them: one step
  // back, inside the read.
  for (const task of open) {
    for (const id of blockers(task)) {
      const blocker = byId.get(id);
      if (blocker) keep.set(blocker.id, blocker);
    }
  }
  const edges = [...keep.values()].flatMap((task) =>
    blockers(task).filter((id) => keep.has(id)).map((id) => epicEdge(keep.get(id)!, task.id)));
  return { children, keep, edges };
}

/** Whether the board's Epic graph draws this epic, given the board's own rows
 * for its project: a link to the graph is offered only where there is one. */
export function epicDrawsGraph(tasks: readonly BoardTask[], epicId: string): boolean {
  return epicChain(tasks, new Map(tasks.map((task) => [task.id, task])), epicId).edges.length > 0;
}

export interface EpicTaskGroup {
  word: TaskStateWord;
  tasks: BoardTask[];
}

/**
 * An epic's tasks grouped by where each stands, in the board's words and
 * order; inside a group by priority, then id. `read` is every task the read
 * holds, so a task held by one outside the epic still reads Waiting.
 */
export function epicTaskGroups(
  children: readonly BoardTask[],
  read: readonly BoardTask[],
  askOf: (task: BoardTask) => InboxAsk | null = inboxAsk,
): EpicTaskGroup[] {
  const byId = new Map(read.map((task) => [task.id, task]));
  const groups = new Map<TaskStateWord, BoardTask[]>();
  for (const task of children) {
    const word = taskStateWord(task, waitingOnCount(task, byId), askOf(task));
    groups.set(word, [...(groups.get(word) ?? []), task]);
  }
  return TASK_STATE_WORDS.flatMap((word) => {
    const tasks = groups.get(word);
    return tasks ? [{ word, tasks: tasks.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, undefined, { numeric: true })) }] : [];
  });
}

/** An edge as its blocker's status leaves it: released once the blocker is
 * done, moving while someone works it, held when the blocker is blocked or
 * parked. A status the read does not carry is a waiting edge. */
export function blockerEdgeState(status: string | null): FlowEdgeState {
  if (status === "blocked" || status === PARKED) return "broken";
  if (status === IN_PROGRESS) return "flowing";
  return "idle";
}

/** The same edge on the board's graph, which also marks a blocker waiting on
 * the operator. */
function epicEdge(from: BoardTask, to: string): FlowEdge {
  if (from.status !== "closed" && from.status !== "blocked" && from.status !== PARKED && inboxAsk(from) !== null) {
    return { from: from.id, to, state: "idle", label: "needs attention" };
  }
  return { from: from.id, to, state: blockerEdgeState(from.status) };
}

/**
 * Every epic on the board whose children in the live read depend on one
 * another, as a graph: its unfinished children, the tasks in the read that
 * block them (an approval outside the epic included), and the finished ones
 * that released them. An epic with no edge is not a graph, and the saved
 * snapshot carries no edges at all, so a board without the live read draws
 * none. Ordered by what most needs the operator: stuck tasks, then asks,
 * then how much is unfinished.
 */
export function epicGraphs({ projects, snapshots, nowMs, href }: {
  projects: readonly BoardProject[];
  snapshots: readonly WorkProject[];
  nowMs: number;
  href: (task: BoardTask) => string;
}): EpicGraph[] {
  const graphs: EpicGraph[] = [];
  for (const project of projects) {
    if (project.source !== "live") continue;
    const byId = new Map(project.tasks.map((task) => [task.id, task]));
    const rollup = new Map<string, WorkEpic>((snapshots.find((row) => row.prefix === project.prefix)?.epics ?? []).map((epic) => [epic.id, epic]));
    for (const [epicId, title] of project.epicNames) {
      const { children, keep, edges: chained } = epicChain(project.tasks, byId, epicId);
      if (chained.length === 0) continue;
      // Past the cap, the nodes with no edge go first, then the finished ones.
      const linked = new Set(chained.flatMap((edge) => [edge.from, edge.to]));
      const ranked = [...keep.values()].sort((a, b) =>
        Number(linked.has(b.id)) - Number(linked.has(a.id)) || Number(finished(a)) - Number(finished(b)));
      const shown = new Set(ranked.slice(0, EPIC_GRAPH_NODES).map((task) => task.id));
      const edges = chained.filter((edge) => shown.has(edge.from) && shown.has(edge.to));
      const tasks = [...keep.values()].filter((task) => shown.has(task.id));
      const nodes = tasks.map((task) => epicNode(task, waitingOnCount(task, byId), nowMs, task.actors, href));
      const epic = rollup.get(epicId);
      graphs.push({
        id: epicId,
        title,
        project,
        nodes: pinRoots(nodes, edges),
        edges,
        stuck: new Set(edges.filter((edge) => edge.state === "broken").map((edge) => edge.from)).size,
        asks: nodes.filter((node) => node.stateLabel === "Needs attention").length,
        progress: epic && epic.total > 0 ? { closed: epic.closed, total: epic.total } : null,
        hidden: children.filter((task) => !shown.has(task.id)).length,
      });
    }
  }
  const unfinished = (graph: EpicGraph) => graph.nodes.filter((node) => node.state !== "ok").length;
  return graphs.sort((a, b) => b.stuck - a.stuck || b.asks - a.asks || unfinished(b) - unfinished(a));
}

/** A node nothing points into sits one column before the first task it
 * blocks, so an approval that holds the last step is drawn beside that step
 * rather than at the start with its edge running behind every column. */
function pinRoots(nodes: FlowNode[], edges: readonly FlowEdge[]): FlowNode[] {
  const layers = flowLayers(nodes, edges);
  const targets = new Set(edges.map((edge) => edge.to));
  return nodes.map((node) => {
    if (targets.has(node.id)) return node;
    const next = edges.filter((edge) => edge.from === node.id).map((edge) => layers.get(edge.to)!);
    return next.length === 0 ? node : { ...node, column: Math.max(0, Math.min(...next) - 1) };
  });
}
