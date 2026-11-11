/** Agent statistics as the Agents page and get_agent_stats read them: work in
 * hand, closes and the changes that shipped, by model. Nothing ranks one model
 * against another or awards one, since closes, close times and runs of days
 * are counts an agent can raise by splitting or rushing work. */
import { modelIdentity } from './actor-names.mjs';
import { recordsClose, TASK_METADATA } from './task-metadata.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MONDAY = 4 * DAY;
export const AGENT_HISTORY_DAYS = 56;
export const OTHER_MODEL = 'Other';

/** Only the task facts needed for statistics, before server-side aggregation. */
export interface AgentStatsTask {
  id: string;
  status: string;
  priority: number;
  issueType: string;
  awaitType: string | null;
  assignee: string | null;
  startedAt: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, unknown> | null;
}
export interface AgentStatsProject {
  project: string;
  tasks: readonly AgentStatsTask[];
}
export interface ModelStats {
  id: string;
  name: string;
  inHand: number;
  blocked: number;
  days: number[];
  week: number;
  lastWeek: number;
  medianHours: number | null;
  /** The changes merged or live in the last 7 days with one of this model's
   * tasks; null where the task source records no merges. */
  shipped: number | null;
}
export interface VelocityWeek {
  start: string;
  current: boolean;
  counts: Record<string, number>;
  total: number;
}
export interface AgentStats {
  /** In name order, Other last. */
  workers: ModelStats[];
  velocity: { weeks: VelocityWeek[]; keys: string[]; names: Record<string, string> };
  week: number;
  lastWeek: number;
  inHand: number;
  blocked: number;
  medianHours: number | null;
  /** The changes merged or live in the last 7 days, each pull request once;
   * null where the task source records no merges. */
  shipped: number | null;
  /** The same, for the 7 days before. */
  shippedLastWeek: number | null;
}
export interface AgentStatsPayload {
  readAt: string;
  projects: number;
  /** Names only; task failures never expose command output. */
  broken: string[];
  stats: AgentStats;
}

/** A model's display name, grouped by its id (actor-names.mts); a model no
 * rule knows is Other. */
export function canonicalAgentModel(value: string | null): string {
  const model = modelIdentity(value);
  return model?.id ? model.name : OTHER_MODEL;
}

export function medianOf(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function formatHours(hours: number): string {
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} d`;
}

function modelOf(task: AgentStatsTask): string {
  const metadata = task.metadata;
  const recorded = task.status === 'closed' && recordsClose(metadata, task.closedAt);
  const closedModel = recorded ? metadata?.[TASK_METADATA.closedModel.name] : null;
  const model = typeof closedModel === 'string' && closedModel.trim() ? closedModel : metadata?.[TASK_METADATA.claimedModel.name];
  return canonicalAgentModel(typeof model === 'string' ? model : null);
}
const cycleOf = (task: AgentStatsTask): number | null => {
  const hours = (Date.parse(task.closedAt ?? '') - Date.parse(task.startedAt ?? '')) / HOUR;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
};

/** Aggregate before serialization: no task bodies, identities or metadata leave
 * the server. Historical closes still count when their model is no longer active.
 * These tasks carry no delivery, so nothing here counts a change shipped. */
export function readAgentStats(projects: readonly AgentStatsProject[], nowMs: number): AgentStats {
  const seen = new Map<string, AgentStatsTask>();
  for (const project of projects) for (const task of project.tasks) {
    const key = `${project.project}\0${task.id}`, old = seen.get(key);
    if (old) {
      const at = Date.parse(task.updatedAt ?? ''), prior = Date.parse(old.updatedAt ?? '');
      if (Number.isFinite(at) && Number.isFinite(prior) && at !== prior) {
        if (at < prior) continue;
      } else if (old.status === 'closed' || task.status !== 'closed') continue;
    }
    seen.set(key, task);
  }
  const tasks = [...seen.values()].filter(task => task.issueType !== 'epic' && task.issueType !== 'gate' && task.awaitType === null);
  const current = MONDAY + Math.floor((nowMs - MONDAY) / (7 * DAY)) * 7 * DAY;
  const starts = Array.from({ length: 8 }, (_, i) => current - (7 - i) * 7 * DAY);
  const closed = tasks.filter(task => task.status === 'closed' && Date.parse(task.closedAt ?? '') <= nowMs
    && Date.parse(task.closedAt ?? '') >= nowMs - AGENT_HISTORY_DAYS * DAY);
  const from = nowMs - 7 * DAY;
  const groups = new Map<string, ModelStats & { cycles: number[] }>();
  const get = (name: string) => {
    let group = groups.get(name);
    if (!group) { group = { id: name, name, inHand: 0, blocked: 0, days: Array<number>(7).fill(0), week: 0, lastWeek: 0, medianHours: null, shipped: null, cycles: [] }; groups.set(name, group); }
    return group;
  };
  const totals = new Map<string, number>();
  const cycles: number[] = [];
  for (const task of closed) {
    const name = modelOf(task), group = get(name), at = Date.parse(task.closedAt!), hours = cycleOf(task);
    if (at >= starts[0]!) totals.set(name, (totals.get(name) ?? 0) + 1);
    if (hours !== null) { group.cycles.push(hours); cycles.push(hours); }
    if (at > from) {
      group.week++;
      const day = Math.floor(at / DAY) - Math.floor(nowMs / DAY) + 6;
      if (day >= 0 && day < 7) group.days[day]!++;
    } else if (at > nowMs - 14 * DAY) group.lastWeek++;
  }
  for (const task of tasks) if (task.assignee && (task.status === 'in_progress' || task.status === 'blocked')) {
    const group = get(modelOf(task));
    if (task.status === 'in_progress') group.inHand++;
    else group.blocked++;
  }
  const workers = [...groups.values()].filter(group => group.week > 0 || group.inHand > 0 || group.blocked > 0)
    .map(({ cycles: durations, ...group }) => ({ ...group, medianHours: medianOf(durations) }))
    .sort((a, b) => Number(a.name === OTHER_MODEL) - Number(b.name === OTHER_MODEL) || a.name.localeCompare(b.name));
  const named = [...totals].filter(([name]) => name !== OTHER_MODEL).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name]) => name);
  const weeks = starts.map(start => {
    const counts: Record<string, number> = {};
    for (const task of closed) {
      const at = Date.parse(task.closedAt!);
      if (at < start || at >= start + 7 * DAY) continue;
      const name = modelOf(task), key = named.includes(name) ? name : '';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return { start: new Date(start).toISOString().slice(0, 10), current: start === current, counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  });
  return {
    workers, velocity: { weeks, keys: [...named, ...(weeks.some(week => (week.counts[''] ?? 0) > 0) ? [''] : [])], names: Object.fromEntries([...named.map(name => [name, name]), ['', OTHER_MODEL]]) },
    week: [...groups.values()].reduce((sum, group) => sum + group.week, 0), lastWeek: [...groups.values()].reduce((sum, group) => sum + group.lastWeek, 0),
    inHand: workers.reduce((sum, group) => sum + group.inHand, 0), blocked: workers.reduce((sum, group) => sum + group.blocked, 0), medianHours: medianOf(cycles),
    shipped: null, shippedLastWeek: null,
  };
}
