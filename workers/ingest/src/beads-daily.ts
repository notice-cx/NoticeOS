// The daily rollup of the task hub: one row per project per calendar day. The
// task photograph is retaken every minute and pruned after two days, so this
// writes down once a day per project what the queue counts were, for 400 days.
// It runs on every capture, the deduplicated "unchanged" touch included, as an
// upsert: the state counts are last-write-wins, point-in-time facts; what
// closed on a day is not (`mergeClosedIds`). It runs in the snapshot's own
// transaction after the snapshot lock is taken, so a day's read-union-write is
// never interleaved with another capture's, and a rollup that fails fails the
// capture whole.

import { javascriptInstant, type Transaction } from '@noticeos/postgres';

/**
 * How many closed beads one project's snapshot list can hold: a mirror of the
 * poller's own `BEADS_CLOSED_LIMIT` (`scripts/runner/task-snapshot.mjs`), which
 * cannot be imported into workerd. Only `closedOn`'s completeness test reads
 * it; if the poller ever sends a shorter list, the test turns optimistic, so the
 * two move together. `workers/ingest/test/beads-daily.test.ts` pins the value.
 */
export const BEADS_CLOSED_LIMIT = 5;

/** How long the rollup keeps a day: a real history rather than a cache, the
 * only record of what the queue looked like on a past day. 400 days so a chart
 * can show a full year plus the run-up to it. */
export const BEADS_DAILY_RETENTION_DAYS = 400;

/** What one project contributed to one day. */
export interface BeadsDailyProject {
  asset: string;
  ok: boolean;
  counts: {
    open: number;
    inProgress: number;
    blocked: number;
    highPriority?: number;
    waiting?: number;
  };
  /** The capped `recentlyClosed` list — ids and close times only. */
  recentlyClosed: { id: string; closedAt: string | null }[];
}

/** Rows were upserted (or there was nothing to upsert). */
export interface BeadsDailyOutcome {
  days: number;
  rows: number;
  pruned: number;
  backfilled: number;
}

type DailyRow = {
  project: string;
  closed_ids: string | null;
};

/** The UTC calendar day an ISO instant falls in: the clock `captured_at` is
 * stamped on, so the poller and the Worker bucket alike. */
export function beadsDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The ids this project saw close on `day`, and whether that set is complete.
 * The snapshot's closed list is the five most recent closes, truncating from
 * the old end, so the set is complete whenever the list is shorter than the
 * cap or still contains a row from an earlier day. When neither holds, five
 * rows all dated `day` could be five closings or fifty.
 */
export function closedOn(
  project: BeadsDailyProject,
  day: string,
): { ids: string[]; complete: boolean } {
  const ids: string[] = [];
  let sawEarlier = false;
  for (const item of project.recentlyClosed) {
    if (!item.closedAt) continue;
    const closedDay = beadsDay(item.closedAt);
    if (closedDay === day) ids.push(item.id);
    else if (closedDay < day) sawEarlier = true;
  }
  return {
    ids,
    complete: project.recentlyClosed.length < BEADS_CLOSED_LIMIT || sawEarlier,
  };
}

/**
 * What the day's closed set becomes after this capture. A bead that closes
 * stays in the five-most-recent list until five more close after it, so at one
 * capture a minute every closing is photographed unless six land inside one
 * minute; accumulating the ids across the day counts closings. `null` is "this
 * day's closings were never observable" and is sticky: written once, when the
 * day's row is created from a capture whose list was already truncated.
 * Unioning onto it would produce a floor that reads as a measurement.
 */
export function mergeClosedIds(
  stored: string | null | undefined,
  seen: { ids: string[]; complete: boolean },
  creating: boolean,
): string | null {
  if (creating) return seen.complete ? JSON.stringify(seen.ids) : null;
  if (stored === null || stored === undefined) return null;
  let previous: unknown;
  try {
    previous = JSON.parse(stored);
  } catch {
    previous = null;
  }
  // An unreadable set is not a set: say the day cannot be counted rather than
  // restart the union half way through it.
  if (!Array.isArray(previous)) return null;
  const union = new Set<string>();
  for (const id of previous) if (typeof id === 'string') union.add(id);
  for (const id of seen.ids) union.add(id);
  return JSON.stringify([...union]);
}

const UPSERT = `INSERT INTO noticeos.task_daily_counts AS d
       (workspace_id, project, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids)
     VALUES ($1::uuid, $2, $3::date, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (workspace_id, project, day) DO UPDATE SET
       captured_at = excluded.captured_at,
       waiting     = excluded.waiting,
       urgent      = excluded.urgent,
       open        = excluded.open,
       in_progress = excluded.in_progress,
       blocked     = excluded.blocked,
       closed_ids  = excluded.closed_ids
      WHERE excluded.captured_at >= d.captured_at
  RETURNING project`;

/**
 * Roll one capture into its day. A project that reported `ok:false` writes
 * nothing: its counts are the absence of an answer, and a day whose last
 * capture failed keeps the last capture that worked.
 */
export async function rollUpBeadsDay(
  tx: Transaction,
  projects: BeadsDailyProject[],
  capturedAt: string,
  nowMs: number,
): Promise<BeadsDailyOutcome> {
  const day = beadsDay(capturedAt);
  // The first run seeds from what the photographs still hold, before this
  // capture lands, so today's row is created by the backfill and then unioned
  // into by the write below.
  const backfilled = await backfillFromSnapshots(tx);

  const existing = new Map<string, DailyRow>(
    (
      await tx.query<DailyRow>(
        `SELECT project, closed_ids::text AS closed_ids FROM noticeos.task_daily_counts WHERE day = $1::date`,
        [day],
      )
    ).map((row) => [row.project, row]),
  );

  let rows = 0;
  for (const project of projects) {
    if (!project.ok) continue;
    const row = existing.get(project.asset);
    const written = await writeDay(tx, project, day, capturedAt, row);
    if (written) rows += 1;
  }

  const cutoff = beadsDay(new Date(nowMs - BEADS_DAILY_RETENTION_DAYS * 86_400_000).toISOString());
  const pruned = await tx.execute(`DELETE FROM noticeos.task_daily_counts WHERE day < $1::date`, [cutoff]);

  const [days] = await tx.query<{ days: number }>(
    `SELECT count(DISTINCT day)::int AS days FROM noticeos.task_daily_counts`,
  );

  return { days: days?.days ?? 0, rows, pruned, backfilled };
}

async function writeDay(
  tx: Transaction,
  project: BeadsDailyProject,
  day: string,
  capturedAt: string,
  stored: DailyRow | undefined,
): Promise<boolean> {
  const closed = mergeClosedIds(stored?.closed_ids, closedOn(project, day), stored === undefined);
  const written = await tx.query<{ project: string }>(UPSERT, [
    tx.workspaceId,
    project.asset,
    day,
    capturedAt,
    // Absent stays absent, as NULL and never as 0: a poller that did not
    // measure the operator's inbox must not draw a line through "nothing was
    // waiting on you".
    project.counts.waiting ?? null,
    project.counts.highPriority ?? null,
    project.counts.open,
    project.counts.inProgress,
    project.counts.blocked,
    closed,
  ]);
  return written.length > 0;
}

/**
 * Seed the rollup from the photographs the store still holds, once. One
 * capture per day, the last one, so the closed set comes under `closedOn`'s
 * completeness test and an already-truncated day is recorded as not
 * observable. Bounded: at most a few payloads are parsed, because this runs
 * inside the POST that files a snapshot.
 */
async function backfillFromSnapshots(tx: Transaction): Promise<number> {
  const [seeded] = await tx.query<{ seeded: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM noticeos.task_daily_counts) AS seeded`,
  );
  if (seeded?.seeded) return 0;

  // Each UTC day's last photograph, the days in order.
  const results = await tx.query<{ captured_at: string; payload: string }>(
    `SELECT DISTINCT ON ((s.captured_at AT TIME ZONE 'UTC')::date) s.captured_at, s.payload::text AS payload
       FROM noticeos.task_snapshots s
      ORDER BY (s.captured_at AT TIME ZONE 'UTC')::date, s.captured_at DESC, s.snapshot_id DESC`,
  );

  let rows = 0;
  for (const snapshot of results) {
    const capturedAt = javascriptInstant(snapshot.captured_at);
    const day = beadsDay(capturedAt);
    for (const project of readSnapshotProjects(snapshot.payload)) {
      if (!project.ok) continue;
      const written = await writeDay(tx, project, day, capturedAt, undefined);
      if (written) rows += 1;
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The stored payload, read for exactly the fields the rollup needs. A separate,
 * tolerant read rather than the validator: this parses rows written days ago,
 * possibly under an older schema, and a backfill that threw on one unreadable
 * project would cost the whole history.
 */
export function readSnapshotProjects(payload: string): BeadsDailyProject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) return [];
  const out: BeadsDailyProject[] = [];
  for (const entry of parsed.projects) {
    if (!isRecord(entry)) continue;
    const asset = typeof entry.asset === 'string' ? entry.asset.trim() : '';
    if (asset === '') continue;
    const counts = isRecord(entry.counts) ? entry.counts : {};
    const open = whole(counts.open);
    const inProgress = whole(counts.inProgress);
    const blocked = whole(counts.blocked);
    // A row missing a required count is damaged rather than old, and must not
    // become a day of zeroes.
    if (open === undefined || inProgress === undefined || blocked === undefined) continue;
    const closed: { id: string; closedAt: string | null }[] = [];
    if (Array.isArray(entry.recentlyClosed)) {
      for (const item of entry.recentlyClosed) {
        if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue;
        closed.push({ id: item.id, closedAt: typeof item.closedAt === 'string' ? item.closedAt : null });
      }
    }
    out.push({
      asset,
      ok: entry.ok !== false,
      counts: {
        open,
        inProgress,
        blocked,
        highPriority: whole(counts.highPriority),
        waiting: whole(counts.waiting),
      },
      recentlyClosed: closed,
    });
  }
  return out;
}
