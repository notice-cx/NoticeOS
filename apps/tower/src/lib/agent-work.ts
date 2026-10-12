// Who did the work: each worker's tasks in hand and its closes over eight
// weeks, the weeks stacked by worker, and the last seven days as a contest
// between the agents and the models they name. Built only from live task
// reads. A close belongs to whoever closed it when that was recorded, else to
// the task's holder at the close; an agent is a worker that named a model.
import {
  claimedModel,
  closeAttribution,
  taskActorLabel,
  TASKS_CLOSED_HISTORY_DAYS,
  type LiveTask,
  type TaskActor,
} from "@shared/tasks";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 1970-01-05, the first Monday after the epoch: weeks start on a UTC Monday. */
const MONDAY_MS = 4 * DAY_MS;
/** The velocity chart's span, the current week included. */
export const AGENT_WEEKS = 8;
/** Workers the velocity chart names; the rest share one segment. */
export const NAMED_WORKERS = 3;
/** The contest's window, ending now. */
export const RACE_DAYS = 7;

export interface AgentProjectRead {
  /** The project key the read answered for. */
  project: string;
  /** Its name as the board shows it. */
  name: string;
  tasks: readonly LiveTask[];
  actors?: readonly TaskActor[];
}

export interface AgentTask {
  id: string;
  project: string;
  projectName: string;
  title: string;
  priority: number;
  status: string;
  /** The holder: the assignee as the read found it. */
  holder: string | null;
  claimedAt: string | null;
  closedAt: string | null;
  evidence: string | null;
  /** Who the close belongs to, or null for a task not closed. */
  closer: string | null;
  /** The model the closer named, else the one the claimer named. */
  model: string | null;
}

export interface Worker {
  id: string;
  name: string;
  /** Named a model on some claim or close. */
  agent: boolean;
  /** The models it named, most used first. */
  models: string[];
  /** Claimed and still open, longest held first. */
  inHand: AgentTask[];
  blocked: AgentTask[];
  /** Closes a UTC day over the last seven, oldest first; the last is today. */
  days: number[];
  /** Closes in the last seven days, and in the seven before them. */
  week: number;
  lastWeek: number | null;
  /** Median hours from claim to close across the history read. */
  medianHours: number | null;
  latest: string | null;
}

export interface VelocityWeek {
  /** The week's Monday, `YYYY-MM-DD`. */
  start: string;
  /** Still running: drawn as still counting. */
  current: boolean;
  /** Closes by worker key; `""` is everyone the chart does not name. */
  counts: Record<string, number>;
  total: number;
}
export interface Velocity {
  weeks: VelocityWeek[];
  /** The named workers, most closes first, then `""` when anyone else closed work. */
  keys: string[];
  names: Record<string, string>;
}

export interface RacePlayer {
  key: string;
  worker: string;
  name: string;
  model: string | null;
  /** Each close's instant, ascending. */
  closes: number[];
  /** Priority-weighted closes: urgent work counts more. */
  points: number;
  medianHours: number | null;
}

export interface Trophy {
  key: "most" | "fastest" | "streak" | "urgent";
  award: string;
  holder: string;
  value: string;
  detail: string | null;
}

export type AgentEvent = { kind: "claimed" | "closed"; at: string; who: string; model: string | null; task: AgentTask };

export interface AgentWork {
  workers: Worker[];
  velocity: Velocity;
  race: { from: number; to: number; players: RacePlayer[] };
  trophies: Trophy[];
  events: AgentEvent[];
  /** Closes in the last seven days and the seven before; null when the history read is missing. */
  week: number;
  lastWeek: number | null;
  inHand: number;
  blocked: number;
}

export function agentTasks(reads: readonly AgentProjectRead[]): AgentTask[] {
  const seen = new Map<string, AgentTask>();
  for (const read of reads) {
    for (const task of read.tasks) {
      if (task.issueType === "epic" || task.issueType === "gate" || task.awaitType !== null) continue;
      const key = `${read.project}\0${task.id}`;
      // The board's read and the history read overlap on the last week; the later state wins.
      const existing = seen.get(key);
      if (existing && (existing.status === "closed" || task.status !== "closed")) continue;
      const closer = closeAttribution(task);
      seen.set(key, {
        id: task.id,
        project: read.project,
        projectName: read.name,
        title: task.title,
        priority: task.priority,
        status: task.status,
        holder: task.assignee,
        claimedAt: task.startedAt,
        closedAt: task.status === "closed" ? task.closedAt : null,
        evidence: task.status === "closed" ? task.closeReason : null,
        closer: task.status === "closed" ? closer?.by ?? task.assignee : null,
        model: closer?.model ?? claimedModel(task),
      });
    }
  }
  return [...seen.values()];
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekStart = (ms: number) => MONDAY_MS + Math.floor((ms - MONDAY_MS) / (7 * DAY_MS)) * 7 * DAY_MS;
const cycleHours = (task: AgentTask) => task.claimedAt && task.closedAt
  ? (Date.parse(task.closedAt) - Date.parse(task.claimedAt)) / HOUR_MS : null;

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Urgent work counts more: top 5, high 3, normal 2, low 1. */
export function taskPoints(priority: number): number {
  return priority <= 0 ? 5 : priority === 1 ? 3 : priority === 2 ? 2 : 1;
}

/** Days running, ending today or yesterday, with a close on each. */
export function streakOf(days: readonly number[]): number {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index--) {
    if (days[index]! > 0) streak++;
    else if (index === days.length - 1) continue;
    else break;
  }
  return streak;
}

/**
 * Everything the Agents page draws, from the live reads at `nowMs`.
 * `historyComplete` says the eight-week read answered for every project; a
 * partial read leaves the earlier week's figures unknown, never low.
 */
export function readAgentWork(reads: readonly AgentProjectRead[], nowMs: number, historyComplete: boolean): AgentWork {
  const actors = reads.flatMap((read) => read.actors ?? []);
  const label = (id: string) => taskActorLabel(id, reads.some((read) => read.actors) ? actors : undefined);
  const tasks = agentTasks(reads);
  const closed = tasks.filter((task) => task.closedAt !== null && task.closer !== null && Date.parse(task.closedAt) <= nowMs
    && nowMs - Date.parse(task.closedAt) <= TASKS_CLOSED_HISTORY_DAYS * DAY_MS);
  const today = Math.floor(nowMs / DAY_MS);
  const ids = new Set<string>([...closed.map((task) => task.closer!), ...tasks.filter((task) => task.closedAt === null && task.holder)
    .map((task) => task.holder!)]);
  const modelsOf = new Map<string, Map<string, number>>();
  for (const task of tasks) {
    const who = task.closer ?? task.holder;
    if (!who || !task.model) continue;
    const counts = modelsOf.get(who) ?? new Map<string, number>();
    counts.set(task.model, (counts.get(task.model) ?? 0) + 1);
    modelsOf.set(who, counts);
  }
  const workers: Worker[] = [...ids].map((id) => {
    const mine = closed.filter((task) => task.closer === id);
    const days = Array.from({ length: 7 }, (_, index) => mine.filter((task) => Math.floor(Date.parse(task.closedAt!) / DAY_MS) === today - 6 + index).length);
    const age = (task: AgentTask) => nowMs - Date.parse(task.closedAt!);
    const held = tasks.filter((task) => task.closedAt === null && task.holder === id);
    return {
      id,
      name: label(id),
      agent: modelsOf.has(id),
      models: [...(modelsOf.get(id) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model),
      inHand: held.filter((task) => task.status === "in_progress")
        .sort((a, b) => Date.parse(a.claimedAt ?? "") - Date.parse(b.claimedAt ?? "")),
      blocked: held.filter((task) => task.status === "blocked"),
      days,
      week: mine.filter((task) => age(task) < RACE_DAYS * DAY_MS).length,
      lastWeek: historyComplete ? mine.filter((task) => age(task) >= RACE_DAYS * DAY_MS && age(task) < 2 * RACE_DAYS * DAY_MS).length : null,
      medianHours: medianOf(mine.map(cycleHours).filter((hours): hours is number => hours !== null && hours >= 0)),
      latest: mine.map((task) => task.closedAt!).sort().at(-1) ?? null,
    };
  }).sort((a, b) => Number(b.agent) - Number(a.agent) || b.week - a.week || b.inHand.length - a.inHand.length || a.name.localeCompare(b.name));

  // Eight calendar weeks, the current one still counting.
  const current = weekStart(nowMs);
  const starts = Array.from({ length: AGENT_WEEKS }, (_, index) => current - (AGENT_WEEKS - 1 - index) * 7 * DAY_MS);
  const totals = new Map<string, number>();
  for (const task of closed) if (Date.parse(task.closedAt!) >= starts[0]!) totals.set(task.closer!, (totals.get(task.closer!) ?? 0) + 1);
  const named = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, NAMED_WORKERS).map(([id]) => id);
  const keyOf = (id: string) => named.includes(id) ? id : "";
  const weeks: VelocityWeek[] = starts.map((start) => {
    const counts: Record<string, number> = {};
    for (const task of closed) {
      const at = Date.parse(task.closedAt!);
      if (at >= start && at < start + 7 * DAY_MS) counts[keyOf(task.closer!)] = (counts[keyOf(task.closer!)] ?? 0) + 1;
    }
    return { start: dayKey(start), current: start === current, counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) };
  });
  const others = weeks.some((week) => (week.counts[""] ?? 0) > 0);
  const velocity: Velocity = {
    weeks,
    keys: [...named, ...(others ? [""] : [])],
    names: Object.fromEntries([...named.map((id) => [id, label(id)]), ["", "Everyone else"]]),
  };

  // The contest: agents only, one player per agent and model.
  const from = nowMs - RACE_DAYS * DAY_MS;
  const players = new Map<string, RacePlayer & { cycles: number[] }>();
  for (const task of closed) {
    const at = Date.parse(task.closedAt!);
    if (at < from || !modelsOf.has(task.closer!)) continue;
    const key = `${task.closer}\0${task.model ?? ""}`;
    const player = players.get(key) ?? { key, worker: task.closer!, name: label(task.closer!), model: task.model, closes: [], points: 0, medianHours: null, cycles: [] };
    player.closes.push(at);
    player.points += taskPoints(task.priority);
    const hours = cycleHours(task);
    if (hours !== null && hours >= 0) player.cycles.push(hours);
    players.set(key, player);
  }
  const racers = [...players.values()].map(({ cycles, ...player }) => ({
    ...player, closes: [...player.closes].sort((a, b) => a - b), medianHours: medianOf(cycles),
  })).sort((a, b) => b.points - a.points || b.closes.length - a.closes.length || a.closes.at(-1)! - b.closes.at(-1)!);

  const recent = closed.filter((task) => Date.parse(task.closedAt!) >= from && modelsOf.has(task.closer!));
  const playerName = (task: AgentTask) => task.model ? `${label(task.closer!)} · ${task.model}` : label(task.closer!);
  const trophies: Trophy[] = [];
  // The most closes, not the most points: the ranking already shows points.
  const most = [...racers].sort((a, b) => b.closes.length - a.closes.length || b.points - a.points)[0];
  if (most) trophies.push({ key: "most", award: "Most tasks closed", holder: most.model ? `${most.name} · ${most.model}` : most.name,
    value: `${most.closes.length}`, detail: most.closes.length === 1 ? "task" : "tasks" });
  const fastest = recent.filter((task) => (cycleHours(task) ?? -1) >= 0).sort((a, b) => cycleHours(a)! - cycleHours(b)!)[0];
  if (fastest) trophies.push({ key: "fastest", award: "Fastest close", holder: playerName(fastest), value: formatHours(cycleHours(fastest)!), detail: fastest.title });
  const streaks = workers.filter((worker) => worker.agent).map((worker) => ({ worker, streak: streakOf(worker.days) })).sort((a, b) => b.streak - a.streak);
  if (streaks[0] && streaks[0].streak > 1) trophies.push({ key: "streak", award: "Most days in a row", holder: streaks[0].worker.name,
    value: `${streaks[0].streak}`, detail: "days" });
  const urgent = new Map<string, { name: string; n: number }>();
  for (const task of recent.filter((entry) => entry.priority <= 1)) {
    const name = playerName(task);
    urgent.set(name, { name, n: (urgent.get(name)?.n ?? 0) + 1 });
  }
  const mostUrgent = [...urgent.values()].sort((a, b) => b.n - a.n)[0];
  if (mostUrgent) trophies.push({ key: "urgent", award: "Most urgent tasks closed", holder: mostUrgent.name, value: `${mostUrgent.n}`,
    detail: mostUrgent.n === 1 ? "high-priority close" : "high-priority closes" });

  const events: AgentEvent[] = [];
  for (const task of tasks) {
    if (task.claimedAt && task.holder && nowMs - Date.parse(task.claimedAt) <= RACE_DAYS * DAY_MS) {
      events.push({ kind: "claimed", at: task.claimedAt, who: label(task.holder), model: task.model, task });
    }
    if (task.closedAt && task.closer && nowMs - Date.parse(task.closedAt) <= RACE_DAYS * DAY_MS) {
      events.push({ kind: "closed", at: task.closedAt, who: label(task.closer), model: task.model, task });
    }
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.kind === "closed" ? -1 : 1));

  const week = closed.filter((task) => nowMs - Date.parse(task.closedAt!) < RACE_DAYS * DAY_MS).length;
  return {
    workers,
    velocity,
    race: { from, to: nowMs, players: racers },
    trophies,
    events,
    week,
    lastWeek: historyComplete ? closed.filter((task) => {
      const age = nowMs - Date.parse(task.closedAt!);
      return age >= RACE_DAYS * DAY_MS && age < 2 * RACE_DAYS * DAY_MS;
    }).length : null,
    inHand: workers.reduce((sum, worker) => sum + worker.inHand.length, 0),
    blocked: workers.reduce((sum, worker) => sum + worker.blocked.length, 0),
  };
}

/** Hours as the page says them: under two days in hours, then days. */
export function formatHours(hours: number): string {
  if (hours < 1) return "under 1 h";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} d`;
}

export type EvidencePart = { kind: "text" | "commit" | "link"; text: string; href: string | null };

/**
 * A close reason split into the pointers it cites: `·`-separated parts that
 * are a commit hash or a link become chips, the rest stays the sentence it
 * was. Only a full http(s) address links; a bare domain is shown, not followed.
 */
export function evidenceParts(reason: string): EvidencePart[] {
  return reason.split(/\s+·\s+/u).map((part) => part.trim()).filter(Boolean).map((part): EvidencePart => {
    if (/^[0-9a-f]{7,40}$/u.test(part)) return { kind: "commit", text: part.slice(0, 7), href: null };
    if (/^https?:\/\/\S+$/iu.test(part)) return { kind: "link", text: part.replace(/^https?:\/\//iu, ""), href: part };
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/iu.test(part) && !/\s/u.test(part)) return { kind: "link", text: part, href: null };
    return { kind: "text", text: part, href: null };
  });
}
