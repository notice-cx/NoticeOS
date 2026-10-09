// Shared WORK contract: the payload `GET /api/work` returns — the read-only
// board over the beads task hub (db/migrations/0017_beads_snapshots.sql).
//
// Same discipline as wall.ts / integrations.ts: pure types + plain constants, no
// runtime deps, safe in workerd and imported by the client for rendering.
//
// Tasks are coordination state, not signals (docs/01, docs/06). Nothing here is
// evidence about an asset: a bead is what someone intends to do, and the OS
// must never let that stand in for what an asset observed. That is also why
// this board is READ-ONLY by construction — there is no write path from the
// Tower to the hub, and there should not be one. Work is claimed and closed
// with `bd` in the repo where the work happens, which is the only place an
// agent has the context to be honest about it.

import type { SeriesPoint } from "./wall";

/** The file that owns the asset ↔ prefix ↔ repo map the board joins on. */
export const WORK_OWNER = "config/beads.json";

/** How many days that history keeps — a MIRROR of the writer's own
 * `BEADS_DAILY_RETENTION_DAYS` (`workers/ingest/src/beads-daily.ts`) and the
 * migration's comment, which are where it is enforced. It is here only so the
 * board's `About` can state the number instead of a third hard-coded copy of it
 * sitting in prose; move all three together. */
export const WORK_HISTORY_RETENTION_DAYS = 400;

/** A daily line needs three points before it is a shape rather than a segment —
 * `Sparkline`'s own floor, stated here because the BOARD is what decides
 * between drawing a series and declaring one that has not grown yet. */
export const WORK_HISTORY_MIN_POINTS = 3;

/** How often the runner photographs the hub (`beadsPollCron` in `scripts/runner/config.mjs`).
 * The board ages `capturedAt` against this, so a dead poller turns the header
 * chip amber inside a couple of minutes instead of showing stale work as
 * current. Keep in step with the runner's cron. */
export const WORK_POLL_CADENCE_HOURS = 1 / 60;

/** One bead, exactly as the board renders it. `bd`'s vocabulary, flattened by
 * the poller; the OS adds nothing and interprets nothing. */
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
  /** When the bead was filed. Absent from a snapshot an older poller wrote,
   * which is "not measured", never "old" (bead `ro-trai.7`). */
  createdAt?: string | null;
  /** The epic this bead hangs off, or null when it hangs off nothing. The
   * board groups by this; un-epiced work is the remainder, never hidden. */
  parent: string | null;
  /** When a parked bead asks to be reconsidered — the fact that makes a
   * deferral a decision rather than a disappearance. */
  deferUntil: string | null;
}

/**
 * The questions a project's header answers. `ready` and `blocked` are both
 * subsets of `open`, split by whether anything is in the way — three chips
 * answering three questions, not one number partitioned three ways.
 *
 * ALL of these EXCLUDE epic-type containers. An epic holds other beads; nobody
 * claims one or closes one by doing it, so counting them overstates every "how
 * much is left?" number by however much structure a repo happens to use. The
 * exclusion belongs to the poller (`scripts/os-up.mjs`), and it has to: these
 * counts are the only untruncated view of the hub, so a reader holding a stored
 * payload can neither find the epics in a 39-item queue nor subtract them from
 * a count that already absorbed them.
 */
export interface WorkCounts {
  /** Stored status `open`: not started. */
  open: number;
  /** P0+P1 across everything not closed. The ONLY count here that is not a
   * status — it cuts across all four, because "is any of this urgent?" is a
   * question an open, in-flight, or blocked bead can each answer yes to.
   *
   * **null = the poller that wrote this row did not measure it**, which is a
   * different fact from zero and is rendered as one (the chip is omitted, not
   * shown as "0 high priority"). Snapshots are written by a long-running local
   * process that can be a generation behind this code — see the skew rule in
   * `workers/ingest/src/beads-snapshots.ts`. */
  highPriority: number | null;
  /** Claimable now — `bd ready`'s blocker-aware answer. */
  ready: number;
  /** Someone (or some agent) is on it. */
  inProgress: number;
  /** Open, but waiting on another bead. */
  blocked: number;
  /** Closed inside the poller's recent window. */
  closedRecent: number;
  /** Deliberately parked (`❄ deferred`). In NONE of the counts above — the
   * read they come from never asks for it — and deliberately kept out of every
   * "how much is left" number downstream. Parked is not queued; the point of
   * carrying it is that a deferral stays VISIBLE rather than silently vanishing
   * from the board (doc 05 forbids a silent deferral).
   *
   * null = this poller did not look, which is not the same as nothing parked. */
  deferred: number | null;
  /** Waiting on the OPERATOR: blocker-aware ready beads carrying `human`, plus
   * open `human` gates. Human beads are a FILTER over `ready`; gates are not
   * queue rows. This number is never added to a work total — it moves rows into
   * the stronger inbox lane without rendering them twice. null = this poller
   * did not look. */
  waiting: number | null;
}

/**
 * ONE POINT PER CALENDAR DAY, per count — the series the strip's six numbers
 * ride (db/migrations/0032_beads_daily_counts.sql, bead `ro-78qo.23`).
 *
 * Six arrays rather than one array of six-field records, because the six are
 * measured independently and a day can be present in one and absent from
 * another: `urgent` and `waiting` are only there on the days a poller measured
 * them, and `closed` is only there on the days whose closings were observable.
 * A record shape would have forced a null into the other five to say so.
 *
 * A DAY THE ROLLUP DOES NOT HOLD IS SIMPLY NOT IN THE ARRAY. There is no
 * placeholder and never a zero: an OS that was switched off on Tuesday did not
 * measure "no open work on Tuesday" (doc 14 principle 8). Points are ascending
 * by day, and the last one is TODAY — still being lived in, which is why the
 * strip draws its endpoint hollow.
 */
export interface WorkCountsHistory {
  /** `counts.waiting` by day. */
  waiting: SeriesPoint[];
  /** `counts.highPriority` by day — the strip calls it Urgent. */
  urgent: SeriesPoint[];
  open: SeriesPoint[];
  inProgress: SeriesPoint[];
  blocked: SeriesPoint[];
  /** How many beads CLOSED on that day — not the seven-day total the
   * `closedRecent` count carries, and not the length of the capped
   * `recentlyClosed` list either. See the migration: it is the size of the set
   * of ids the day's captures saw close. */
  closed: SeriesPoint[];
}

/** The six metrics in the order the strip draws them — so a reader can walk
 * them without spelling the six names out again and getting one wrong. */
export const WORK_HISTORY_METRICS = [
  "waiting",
  "urgent",
  "open",
  "inProgress",
  "blocked",
  "closed",
] as const;

export type WorkHistoryMetric = (typeof WORK_HISTORY_METRICS)[number];

/** No history at all, for a project the rollup has never recorded. A FUNCTION
 * rather than a shared constant: the arrays are mutable, and one frozen-looking
 * literal handed to every project would be one array six projects push into. */
export function emptyWorkHistory(): WorkCountsHistory {
  return { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] };
}

/** One epic container and what its children are doing — the board's grouping
 * row. `total`/`closed` are ALL-TIME (`bd epic status`), the only honest
 * progress denominator: the snapshot's closed list is a trailing week, so an
 * epic finished last month would otherwise read as 0% done. */
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
  /** The bead prefix. Visible because it is the half of a bead id an operator
   * types, and it is NOT derivable from the asset id (`ex` is not
   * `example.com`). */
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
  /** Open work per `bd` priority band, P0..P4 — the queue's SHAPE. null when
   * the poller that wrote this row did not send one (see `WorkCounts`). */
  priorities: number[] | null;
  /** Epic grouping. null = this snapshot cannot describe structure, and the
   * board falls back to flat lists rather than inventing groups. */
  epics: WorkEpic[] | null;
  ready: WorkItem[];
  inProgress: WorkItem[];
  recentlyClosed: WorkItem[];
  /** Parked work, soonest wake-up first. [] when none; the `counts.deferred`
   * null carries "did not look". */
  deferred: WorkItem[];
  /** The operator's presently actionable inbox for this project, most-blocking
   * first: an open `human` gate leads (it holds a bead out of `bd ready`), then
   * human-labelled rows that also appear in this snapshot's `ready` set, by
   * priority and age. Deferred, blocked and in-progress human rows stay out. A
   * gate is identifiable by `issueType`, so no extra marker rides the payload. */
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

/** The five `bd` priority bands, P0..P4, as the operator's own words. Index IS
 * the priority, so `PRIORITY_BANDS[2]` is the default band. `priorityLabel`
 * below deliberately says nothing for the default on a per-row basis; a
 * DISTRIBUTION has to name every band it draws, which is why this exists
 * separately rather than reusing that function. */
export const PRIORITY_BANDS = ["top", "high", "normal", "low", "lowest"] as const;

/** Priority as a word, because "P3" is a system token an operator would have to
 * be taught (doc 14's demo test). The default band returns null: a board where
 * every row says "normal" is a board where nothing stands out, so only beads
 * that are deliberately above or below the default say anything at all. */
export function priorityLabel(priority: number): string | null {
  if (priority <= 0) return "top";
  if (priority === 1) return "high";
  if (priority === 2) return null;
  if (priority === 3) return "low";
  return "lowest";
}

/**
 * The portfolio's daily series, summed over the projects the board is SHOWING —
 * every spoke on the index, one spoke on an asset's Tasks tab.
 *
 * A DAY COUNTS ONLY WHERE EVERY SHOWN PROJECT MEASURED IT. One capture writes a
 * row for every project it could read, so in the ordinary case the days line up
 * and this rule costs nothing. Where they do not — a spoke added last Tuesday,
 * a repository the poller could not open all day, a count an older poller never
 * sent — summing what happens to be there would draw a portfolio that shrank on
 * the day a project went quiet. That is a fabricated shape, and a missing point
 * is the honest alternative (doc 14 principle 8).
 */
export function sumWorkHistory(projects: readonly WorkProject[]): WorkCountsHistory {
  const out = emptyWorkHistory();
  if (projects.length === 0) return out;
  for (const metric of WORK_HISTORY_METRICS) {
    const byDay = new Map<string, { sum: number; seen: number }>();
    for (const project of projects) {
      // A payload with NO history at all degrades to no series, never to a
      // thrown board. The field is required in this contract, so the only way
      // here is a payload written by a Worker one generation behind the client
      // that is rendering it — an ordinary fact about a deployment, and a blank
      // sparkline is a far better answer to it than a blank page.
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

/** Does this project have anything worth a row? A project with no work is one
 * calm line, not an empty panel (doc 14 / the AttentionBand precedent). */
export function hasWork(project: WorkProject): boolean {
  return (
    project.counts.open > 0 ||
    project.counts.inProgress > 0 ||
    project.counts.blocked > 0 ||
    project.counts.closedRecent > 0 ||
    // Parked work counts as something to SHOW, though never as something
    // queued: a project whose only remaining work is deferred must not render
    // as "Nothing queued", or the deferral has silently vanished again.
    (project.counts.deferred ?? 0) > 0 ||
    // An ask waiting on the operator is the last thing that should let a
    // project render as "Nothing queued" — it is the one kind of work the OS
    // cannot start by itself.
    (project.counts.waiting ?? 0) > 0
  );
}
