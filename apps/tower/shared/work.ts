// The work contract: the payload `GET /api/work` returns — the read-only
// board over the task hub. Pure types and plain constants only. Tasks are
// coordination state, not signals: nothing here is evidence about an asset,
// and there is no write path from the Tower to the hub.

import type { TaskCard } from "@noticeos/contract/task-card";
import type { TaskChangeClass } from "@noticeos/contract/task-change-class";
import type { TaskChoice, TaskChoiceKey, TaskChoices } from "@noticeos/contract/task-choices";
import type { TaskResolution } from "@noticeos/contract/task-resolution";
import { calendarDateIn, revenueCalendarDate } from "./daily-revenue";
import { shiftRevenueDate } from "./revenue-projection";
import type { SeriesPoint } from "./wall";

/** The file that owns the asset ↔ prefix ↔ repo map the board joins on. */
export const WORK_OWNER = "config/beads.json";

/** How many days that history keeps — a mirror of the writer's own
 * `BEADS_DAILY_RETENTION_DAYS` (`workers/ingest/src/beads-daily.ts`), where
 * it is enforced; move the two together. */
export const WORK_HISTORY_RETENTION_DAYS = 400;

/** A daily line needs three points before it is a shape rather than a
 * segment — `Sparkline`'s own floor. */
export const WORK_HISTORY_MIN_POINTS = 3;

/** How often the runner photographs the hub (`beadsPollCron` in
 * `scripts/runner/config.mjs`); the board ages `capturedAt` against it. Keep
 * in step with the runner's cron. */
export const WORK_POLL_CADENCE_HOURS = 1 / 60;

/** One task, exactly as the board renders it. `bd`'s vocabulary, flattened
 * by the poller; the OS adds nothing and interprets nothing. */
export interface WorkItem {
  /** `<prefix>-<hash>` — the id an agent quotes to `bd`, so it renders verbatim. */
  id: string;
  title: string;
  /** `bd`'s stored status. Not an enum here on purpose: `bd` supports custom
   * statuses, and the board must render one it has never seen rather than
   * crash on it. */
  status: string;
  /** P0–P4, 0 = highest. */
  priority: number;
  /** task | bug | feature | chore | epic | … (`bd types`). */
  issueType: string;
  assignee: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  /** When the task was filed. Absent from a snapshot an older poller wrote,
   * which is "not measured", never "old". */
  createdAt?: string | null;
  /** The container this task hangs off, or null. The board groups by this;
   * ungrouped work is the remainder, never hidden. */
  parent: string | null;
  /** When a parked task asks to be reconsidered. */
  deferUntil: string | null;
  /** The options a person picks from, null when the task offers none; absent
   * from a row read before choices existed. */
  choices?: TaskChoices | null;
  /** The option a person picked, null until one is. */
  choice?: TaskChoice | null;
  /** How a closed task's close ended; null on a task not closed. A snapshot
   * row carries it only when it is not done, so absent reads as done. */
  resolution?: TaskResolution | null;
  /** The task a close as a duplicate names, null otherwise. */
  duplicateOf?: string | null;
  /** Why the task is worth doing (task-card.mts), null when it carries no
   * card the reader accepts; absent from a row read before cards existed. A
   * task without one is listed, never ranked. */
  card?: TaskCard | null;
  /** The kind of change it makes (task-change-class.mts), null when unrecorded. */
  changeClass?: TaskChangeClass | null;
}

/**
 * The questions a project's header answers. `ready` and `blocked` are both
 * subsets of `open`. All of these exclude container-type tasks; the exclusion
 * belongs to the poller (`scripts/os-up.mjs`), because the stored lists are
 * truncated and nothing downstream can do it.
 */
export interface WorkCounts {
  /** Stored status `open`: not started. */
  open: number;
  /** P0+P1 across everything not closed — the only count here that cuts
   * across statuses. null = the poller that wrote this row did not measure
   * it, which is rendered as an omitted chip, never as zero (the skew rule in
   * `workers/ingest/src/beads-snapshots.ts`). */
  highPriority: number | null;
  /** Claimable now — `bd ready`'s blocker-aware answer. */
  ready: number;
  /** Someone (or some agent) is on it. */
  inProgress: number;
  /** Open, but waiting on another task. */
  blocked: number;
  /** Closed inside the poller's recent window. */
  closedRecent: number;
  /** Deliberately parked. In none of the counts above and kept out of every
   * "how much is left" number: parked is not queued, but a deferral stays
   * visible. null = this poller did not look. */
  deferred: number | null;
  /** Waiting on the operator: blocker-aware ready tasks carrying `human`, plus
   * open `human` approvals. A filter over `ready`, never added to a work
   * total. null = this poller did not look. */
  waiting: number | null;
}

/**
 * One point per calendar day, per count. Six arrays rather than one array of
 * records, because the six are measured independently and a day can be
 * present in one and absent from another. A day the rollup does not hold is
 * simply not in the array: never a placeholder, never a zero. Points are
 * ascending by day, and the last one is today, still being lived in.
 */
export interface WorkCountsHistory {
  /** `counts.waiting` by day. */
  waiting: SeriesPoint[];
  /** `counts.highPriority` by day — the strip calls it Urgent. */
  urgent: SeriesPoint[];
  open: SeriesPoint[];
  inProgress: SeriesPoint[];
  blocked: SeriesPoint[];
  /** How many tasks closed on that day: the size of the set of ids the day's
   * captures saw close — not `closedRecent`'s trailing total. */
  closed: SeriesPoint[];
}

/** The six metrics in the order the strip draws them. */
export const WORK_HISTORY_METRICS = [
  "waiting",
  "urgent",
  "open",
  "inProgress",
  "blocked",
  "closed",
] as const;

export type WorkHistoryMetric = (typeof WORK_HISTORY_METRICS)[number];

/** No history at all. A function rather than a shared constant: the arrays
 * are mutable. */
export function emptyWorkHistory(): WorkCountsHistory {
  return { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] };
}

/** One container task and what its children are doing — the board's grouping
 * row. `total`/`closed` are all-time (`bd epic status`): the snapshot's closed
 * list is a trailing week, so a container finished last month would otherwise
 * read as 0% done. */
export interface WorkEpic {
  id: string;
  title: string;
  /** `bd`'s stored status for the container itself. */
  status: string;
  priority: number;
  total: number;
  closed: number;
  /** Live children by status. Excludes closed, which `total`/`closed` cover. */
  counts: { open: number; inProgress: number; blocked: number; deferred: number };
  /** Child priority shape, P0..P4, over children that are not parked. */
  priorities: number[];
}

export interface WorkProject {
  /** The asset id — the join key back to `assets` (config/beads.README.md). */
  asset: string;
  /** The task id prefix. Visible because it is the half of a task id an
   * operator types, and not derivable from the asset id. */
  prefix: string;
  /** The asset's display name, or the raw asset id when the snapshot names
   * a project the store has never heard of — an unrecognized project is shown,
   * never dropped. */
  name: string;
  /** False when the poller could not read this repo. Its lists are then empty
   * and `error` says why. */
  ok: boolean;
  error: string | null;
  counts: WorkCounts;
  /** What those counts were on each of the days the daily rollup holds. Empty
   * on every day of it when the store has no rollup table yet — see
   * `historyDays`, which is what tells the two apart. */
  history: WorkCountsHistory;
  /** Each figure's week against the week before, on the installation's
   * clock (`workWeeks`): done from the snapshot's closes, the states from
   * `history`. Absent when the store holds neither, or from a Worker older
   * than the reading. */
  weeks?: WorkWeeks;
  /** Open work per `bd` priority band, P0..P4. null when the poller that
   * wrote this row did not send one. */
  priorities: number[] | null;
  /** Container grouping. null = this snapshot cannot describe structure, and
   * the board falls back to flat lists. */
  epics: WorkEpic[] | null;
  ready: WorkItem[];
  inProgress: WorkItem[];
  recentlyClosed: WorkItem[];
  /** Parked work, soonest wake-up first. [] when none; the `counts.deferred`
   * null carries "did not look". */
  deferred: WorkItem[];
  /** The operator's presently actionable inbox for this project, most-blocking
   * first: an open `human` approval leads, then human-labelled rows that also
   * appear in this snapshot's `ready` set, by priority and age. An approval is
   * identifiable by `issueType`. */
  waiting: WorkItem[];
  /** Who did the work. Absent when nobody holds or closed any, or when the
   * poller that wrote this snapshot did not count it. */
  workers?: WorkWorker[];
  /** The newest claims and closes, newest first. Absent under the same rule. */
  recentWork?: WorkEvent[];
}

/** One worker and the model it named: its closes in the closed window and the
 * work it holds. A close belongs to the closer NoticeOS recorded, else to the
 * task's holder. */
export interface WorkWorker {
  id: string;
  model: string | null;
  closedRecent: number;
  inProgress: number;
}

/** One claim or close, with a close's evidence as the closer gave it. */
export interface WorkEvent {
  kind: "claimed" | "closed" | "chosen";
  taskId: string;
  title: string;
  by: string;
  model: string | null;
  at: string;
  evidence: string | null;
  /** A person's pick: the option's key and label. */
  option?: TaskChoiceKey;
  label?: string;
  /** A close that is not done: how it ended. */
  resolution?: Exclude<TaskResolution, "done">;
}

export interface WorkPayload {
  generatedAt: string;
  /** When the poller looked, NOT when the Tower rendered. Null means no
   * snapshot has ever been filed — a first-run board, not an empty portfolio. */
  capturedAt: string | null;
  pollCadenceHours: number;
  owner: string;
  projects: WorkProject[];
  /** How many calendar days the daily rollup holds. */
  historyDays: number;
}

/** The five `bd` priority bands, P0..P4, as the operator's own words. Index is
 * the priority; a distribution has to name every band it draws, which is why
 * this exists beside `priorityLabel`. */
export const PRIORITY_BANDS = ["top", "high", "normal", "low", "lowest"] as const;

/** Priority as a word. The default band returns null, so only tasks
 * deliberately above or below the default say anything at all. */
export function priorityLabel(priority: number): string | null {
  if (priority <= 0) return "top";
  if (priority === 1) return "high";
  if (priority === 2) return null;
  if (priority === 3) return "low";
  return "lowest";
}

/**
 * The portfolio's daily series, summed over the projects the board is
 * showing. A day counts only where every shown project measured it: summing
 * what happens to be there would draw a portfolio that shrank on the day a
 * project went quiet.
 */
export function sumWorkHistory(projects: readonly WorkProject[]): WorkCountsHistory {
  const out = emptyWorkHistory();
  if (projects.length === 0) return out;
  for (const metric of WORK_HISTORY_METRICS) {
    const byDay = new Map<string, { sum: number; seen: number }>();
    for (const project of projects) {
      // A payload with no history at all (an older Worker) degrades to no
      // series, never to a thrown board.
      for (const point of project.history?.[metric] ?? []) {
        const cell = byDay.get(point.t) ?? { sum: 0, seen: 0 };
        cell.sum += point.v;
        cell.seen += 1;
        byDay.set(point.t, cell);
      }
    }
    out[metric] = [...byDay.entries()]
      .filter(([, cell]) => cell.seen === projects.length)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, cell]) => ({ t, v: cell.sum }));
  }
  return out;
}

// --- the week against the week before -----------------------------------------

/** Which way each figure is better: more closes is good; more waiting on the
 * operator, more urgent and more blocked is worse; in progress has no better
 * direction. Decided here once, so every chip on every screen agrees. */
export const WORK_WEEK_IMPROVEMENT = {
  done: "up",
  waiting: "down",
  urgent: "down",
  inProgress: "none",
  blocked: "down",
} as const;

export type WorkWeekMetric = keyof typeof WORK_WEEK_IMPROVEMENT;

/** A figure's move against its earlier reading. */
export interface WeekMove {
  /** The figure now minus the earlier reading. */
  by: number;
  direction: "up" | "down" | "flat";
  /** `good` when the figure moved its better way, `bad` against it, `neutral`
   * when it did not move or has no better way. */
  verdict: "good" | "bad" | "neutral";
}

/** The one rule for a move: null when either side is unknown. A screen that
 * shows a fresher figure than the history's own pairs it with `before` here,
 * so the chip always reads the figure beside it. */
export function weekMove(metric: WorkWeekMetric, now: number | null, before: number | null): WeekMove | null {
  if (now === null || before === null) return null;
  const by = now - before;
  const direction = by > 0 ? "up" : by < 0 ? "down" : "flat";
  const better = WORK_WEEK_IMPROVEMENT[metric];
  return { by, direction, verdict: direction === "flat" || better === "none" ? "neutral" : direction === better ? "good" : "bad" };
}

/** A state's week: how many are in it today, how many were seven days before,
 * and how many entered it in between. */
export interface WorkStateWeek {
  /** Today's count; null when the history holds no count for today. */
  now: number | null;
  /** The count seven days before today; null where the history does not
   * reach it. */
  before: number | null;
  /** The sum of the day-to-day rises over those seven days, so a task that
   * entered and left the state on one day is not in it. Null unless all
   * eight days are held. */
  added: number | null;
  move: WeekMove | null;
}

/** One close as the task snapshot carries it: when it happened and, when
 * nothing shipped, how it ended. */
export interface WorkClose {
  at: string;
  resolution?: Exclude<TaskResolution, "done">;
}

/** Every close one closed read returned. */
export interface WorkCloses {
  /** The read's first UTC day. Whether that day's own closes came back is the
   * task client's choice, so the closes are whole from the next day on. */
  since: string;
  items: WorkClose[];
}

/** Done this calendar week against last week, counted from the closes: each
 * in the week its time falls in on the installation's clock, and done unless
 * it ended another way. */
export interface WorkDoneWeek {
  /** Done so far this week; null when the closes do not reach its Monday. */
  now: number | null;
  /** This week's closes that shipped nothing (Won't do, Duplicate…), counted
   * apart from `now`; null under the same rule. */
  notDone: number | null;
  /** Done last week up to this moment of its week: what `now` is compared
   * with. Null when the closes do not reach last Monday. */
  before: number | null;
  /** Done last week, all seven days; null under the same rule. */
  lastWeek: number | null;
  move: WeekMove | null;
}

/**
 * Every work figure's week against the week before. The week starts on
 * Monday in the installation's time zone. Done is counted from the closes;
 * the states from the daily history, whose days run midnight to midnight UTC
 * (the clock the rollup keys by).
 */
export interface WorkWeeks {
  /** The Monday this week started on. */
  weekStart: string;
  /** Today's place in the week: Monday 1 to Sunday 7. */
  daysIn: number;
  done: WorkDoneWeek;
  waiting: WorkStateWeek;
  urgent: WorkStateWeek;
  inProgress: WorkStateWeek;
  blocked: WorkStateWeek;
}

/** The ISO weekday of a calendar date: Monday 1 to Sunday 7. */
function isoWeekday(day: string): number {
  return ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

const DAY_MS = 86_400_000;

function doneWeek(closes: WorkCloses | undefined, now: Date, weekStart: string, timeZone: string): WorkDoneWeek {
  if (!closes) return { now: null, notDone: null, before: null, lastWeek: null, move: null };
  const dayOf = calendarDateIn(timeZone);
  // The latest day on the installation's clock the read may hold only part of.
  const partDay = dayOf(new Date(Date.parse(`${closes.since}T00:00:00.000Z`) + DAY_MS - 1));
  const lastStart = shiftRevenueDate(weekStart, -7);
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const count = { done: 0, notDone: 0, lastWeek: 0, before: 0 };
  for (const close of closes.items) {
    const at = Date.parse(close.at);
    if (!Number.isFinite(at)) continue;
    const day = dayOf(new Date(at));
    const done = close.resolution === undefined;
    if (day >= weekStart) count[done ? "done" : "notDone"] += 1;
    else if (day >= lastStart && done) {
      count.lastWeek += 1;
      if (at <= weekAgo) count.before += 1;
    }
  }
  const thisWeek = weekStart > partDay;
  const lastWeek = lastStart > partDay;
  const done = thisWeek ? count.done : null;
  const before = lastWeek ? count.before : null;
  return {
    now: done,
    notDone: thisWeek ? count.notDone : null,
    before,
    lastWeek: lastWeek ? count.lastWeek : null,
    move: weekMove("done", done, before),
  };
}

function stateWeek(metric: WorkWeekMetric, series: readonly SeriesPoint[], utcToday: string): WorkStateWeek {
  const byDay = new Map(series.map((point) => [point.t, point.v]));
  const now = byDay.get(utcToday) ?? null;
  const before = byDay.get(shiftRevenueDate(utcToday, -7)) ?? null;
  let added: number | null = 0;
  for (let back = 6; back >= 0 && added !== null; back -= 1) {
    const day = byDay.get(shiftRevenueDate(utcToday, -back));
    const prior = byDay.get(shiftRevenueDate(utcToday, -back - 1));
    added = day === undefined || prior === undefined ? null : added + Math.max(0, day - prior);
  }
  return { now, before, added, move: weekMove(metric, now, before) };
}

/** One project's week on the installation's clock: done from its closes
 * (absent when the snapshot carried none), the states from its daily history. */
export function workWeeks(history: WorkCountsHistory, closes: WorkCloses | undefined, now: Date, timeZone: string): WorkWeeks {
  const today = revenueCalendarDate(now, timeZone);
  const daysIn = isoWeekday(today);
  const weekStart = shiftRevenueDate(today, -(daysIn - 1));
  const utcToday = now.toISOString().slice(0, 10);
  return {
    weekStart,
    daysIn,
    done: doneWeek(closes, now, weekStart, timeZone),
    waiting: stateWeek("waiting", history.waiting, utcToday),
    urgent: stateWeek("urgent", history.urgent, utcToday),
    inProgress: stateWeek("inProgress", history.inProgress, utcToday),
    blocked: stateWeek("blocked", history.blocked, utcToday),
  };
}

/** Add where every side is known. */
function knownSum(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

/**
 * Several projects' weeks as one: the figures the Wall and the board draw
 * for every project they show. A project without a reading counts as not
 * known, so a total never passes for one that includes it.
 */
export function sumWorkWeeks(readings: readonly (WorkWeeks | null | undefined)[]): WorkWeeks | null {
  const first = readings.find((reading): reading is WorkWeeks => reading !== null && reading !== undefined);
  if (!first) return null;
  const all = readings.map((reading) => reading ?? null);
  const state = (metric: Exclude<WorkWeekMetric, "done">): WorkStateWeek => {
    const now = knownSum(all.map((reading) => reading?.[metric].now ?? null));
    const before = knownSum(all.map((reading) => reading?.[metric].before ?? null));
    return { now, before, added: knownSum(all.map((reading) => reading?.[metric].added ?? null)), move: weekMove(metric, now, before) };
  };
  const done = (key: Exclude<keyof WorkDoneWeek, "move">) => knownSum(all.map((reading) => reading?.done[key] ?? null));
  const now = done("now");
  const before = done("before");
  return {
    weekStart: first.weekStart,
    daysIn: first.daysIn,
    done: { now, notDone: done("notDone"), before, lastWeek: done("lastWeek"), move: weekMove("done", now, before) },
    waiting: state("waiting"),
    urgent: state("urgent"),
    inProgress: state("inProgress"),
    blocked: state("blocked"),
  };
}

/** Does this project have anything worth a row? A project with no work is
 * one calm line, not an empty panel. */
export function hasWork(project: WorkProject): boolean {
  return (
    project.counts.open > 0 ||
    project.counts.inProgress > 0 ||
    project.counts.blocked > 0 ||
    project.counts.closedRecent > 0 ||
    // Parked work and asks waiting on the operator count as something to
    // show, though never as something queued.
    (project.counts.deferred ?? 0) > 0 ||
    (project.counts.waiting ?? 0) > 0
  );
}
