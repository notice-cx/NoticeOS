// The daily rollup of the task hub — one row per project per calendar day
// (db/migrations/0032_beads_daily_counts.sql, bead `ro-78qo.23`). On Postgres,
// `noticeos.task_daily_counts`, since bead ro-ujb9.76.4.3.
//
// WHY IT EXISTS. The task photograph is retaken every minute, of which only
// the newest is kept whole and everything past two days is pruned.
// The Tasks strip could therefore state six numbers and answer nothing about
// whether any of them was growing. This writes down, once a day per project,
// what those six numbers were — 400 days of it for about one row per project
// per day, instead of widening a 1,440-a-day cache to buy 28 points.
//
// IT RUNS ON EVERY CAPTURE, including the deduplicated "unchanged" touch, and it
// is an UPSERT: the day's row always holds the newest capture of that day. Only
// the *state* counts are last-write-wins, because they are point-in-time facts.
// What CLOSED on a day is not — see `mergeClosedIds`.
//
// IT RUNS IN THE SNAPSHOT'S OWN TRANSACTION (`writeBeadsSnapshot`), after the
// writer has taken the snapshot lock, so a day's read-union-write is never
// interleaved with another capture's. A migrated store has the table, so there
// is no "not migrated yet" to fall back to: a rollup that fails fails the
// capture, whole, as any failed statement did on D1.

import { javascriptInstant, type Transaction } from '@noticeos/postgres';

/**
 * How many closed beads one project's snapshot list can hold — a MIRROR of the
 * poller's own `BEADS_CLOSED_LIMIT` (`scripts/runner/task-snapshot.mjs`), which is where the
 * truncation happens. It cannot be imported: the poller is a Node script and
 * this is workerd, and `BEADS_MAX_ITEMS` above is the outer bound the validator
 * enforces rather than the head the poller actually sends.
 *
 * Only `closedOn`'s completeness test reads it, and only to decide whether a
 * day's closings were observable at all. If the poller ever sends a SHORTER
 * list than this, the test turns optimistic — a truncated day would be recorded
 * as complete — so the two move together. `workers/ingest/test/beads-daily.test.ts`
 * pins the value.
 */
export const BEADS_CLOSED_LIMIT = 5;

/** How long the rollup keeps a day. Unlike the photographs' two days this is
 * a real history rather than a cache — it is the ONLY record of what the queue
 * looked like on a past day, because the photographs it was derived from are
 * long pruned and the hub itself holds only the present. 400 days so a chart can
 * always show a full year plus the run-up to it. */
export const BEADS_DAILY_RETENTION_DAYS = 400;

/** What one project contributed to one day. Everything this module needs out of
 * a stored snapshot payload, and nothing else. */
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

/** Rows were upserted (or there was nothing to upsert, which is the same fact
 * about the store). */
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

/** The UTC calendar day an ISO instant falls in. UTC because that is the clock
 * `captured_at` is stamped on and the only one the poller and the Worker agree
 * about; bucketing on a local midnight would put two adjacent captures in
 * different days depending on which process did the arithmetic. */
export function beadsDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The ids this project saw close ON `day`, and whether that set is COMPLETE.
 *
 * The snapshot's closed list is the five MOST RECENT closes inside a trailing
 * seven-day window, so it truncates from the OLD end. Today's closings are
 * therefore the last thing it drops, and the set is complete whenever the list
 * is shorter than the cap (nothing was dropped at all) or still contains a row
 * from an EARLIER day (the cap had not been reached by `day`'s own closings).
 *
 * When neither holds, five rows all dated `day` could be five closings or
 * fifty, and the caller must record "not observable" rather than five.
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
 * What the day's closed set becomes after this capture.
 *
 * THE UNION IS THE MECHANISM. A bead that closes stays in the five-most-recent
 * list until five more close after it, so at one capture a minute every closing
 * is photographed by at least one capture unless six land inside the same
 * minute. Accumulating the ids across the day therefore counts CLOSINGS, where
 * bucketing any single capture would count the capped list.
 *
 * `null` is "this day's closings were never observable" and is STICKY. It is
 * written once, when the day's row is CREATED from a capture whose list was
 * already truncated — the backfill's older days, and the half-day an operator
 * applies the migration in. Unioning onto it would produce a floor that reads as
 * a measurement, which is the more comfortable of the two lies.
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
  // An unreadable set is not a set. Better to say the day cannot be counted than
  // to restart the union half way through it and under-report the rest.
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
 * Roll one capture into its day.
 *
 * A project that reported `ok:false` writes NOTHING. The poller could not read
 * that repository, so its counts are the absence of an answer rather than an
 * answer of zero — and a day whose last capture failed keeps the last capture
 * that worked, which is a better record than a cliff to zero on the day a
 * checkout went missing.
 */
export async function rollUpBeadsDay(
  tx: Transaction,
  projects: BeadsDailyProject[],
  capturedAt: string,
  nowMs: number,
): Promise<BeadsDailyOutcome> {
  const day = beadsDay(capturedAt);
  // FIRST RUN SEEDS FROM WHAT THE PHOTOGRAPHS STILL HOLD, before this capture
  // lands, so today's row is created by the backfill and then unioned into by
  // the write below rather than the other way round.
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
    // Absent stays ABSENT, as NULL and never as 0 — the same rule the snapshot
    // payload follows. A poller that did not measure the operator's inbox must
    // not draw a line through "nothing was waiting on you".
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
 * Seed the rollup from the photographs the store still holds (two days since
 * bead `ro-ujb9.76.16`; an older one keeps the counts and closed list this
 * reads), once — the day the operator applies the migration.
 *
 * ONE CAPTURE PER DAY, the last one, which gives the five state counts exactly
 * as they stood at the end of that day. The closed set comes from the same
 * capture under `closedOn`'s completeness test, so a day whose closings were
 * already truncated out of that list is recorded as not observable rather than
 * as five.
 *
 * Bounded on purpose: at most eight payloads are parsed, not the hundreds of
 * distinct states a week of captures can hold. This runs inside the POST that
 * files a snapshot, and a first run that timed out would look exactly like a
 * broken poller.
 */
async function backfillFromSnapshots(tx: Transaction): Promise<number> {
  const [seeded] = await tx.query<{ seeded: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM noticeos.task_daily_counts) AS seeded`,
  );
  if (seeded?.seeded) return 0;

  // Each UTC day's last photograph, the days in order; of two taken at one
  // instant, the later written.
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
 * The stored payload, read for exactly the fields the rollup needs.
 *
 * A SEPARATE, TOLERANT READ rather than a reuse of the validator above it: this
 * parses rows the validator wrote days ago, possibly under an older generation
 * of the schema, and a backfill that threw on one unreadable project would cost
 * the whole history rather than that project's day.
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
    // The three required counts have been in the payload since the table
    // existed, so a row missing one is damaged rather than old — and a damaged
    // row must not become a day of zeroes.
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
