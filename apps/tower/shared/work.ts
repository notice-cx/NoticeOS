// The work contract: the payload `GET /api/work` returns — the read-only
// board over the task hub. Pure types and plain constants only. Tasks are
// coordination state, not signals: nothing here is evidence about an asset,
// and there is no write path from the Tower to the hub.

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
