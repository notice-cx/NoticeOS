// The job-run writer, and the reader that turns it into a metric
// (db/migrations/0022_job_runs.sql, bead ro-uwo.4). On Postgres,
// `noticeos.job_runs`, since bead ro-ujb9.76.4.3.
//
// The producer is `scripts/os-up.mjs` — the only process on this machine that
// fires the scheduled lanes, and therefore the only witness to a lane that fires
// while the ingest is down. It records every firing to disk first
// (`.local/logs/job-runs.jsonl`, ro-ic5) and ships batches here whenever the
// door answers. So this module is a MIRROR of that record, and everything about
// its shape follows from that. (One more producer writes here directly: a
// job step a person runs now from the connect panel, `recordManualRun` below,
// marked so the latest-run read leaves it out.)
//
//   * BATCHES, not one row per request. After an outage the runner has a queue,
//     and a lane that fires once a minute would need an hour of requests to
//     catch up one-at-a-time.
//   * IDEMPOTENT on (job, startedAt). The runner cannot know which of its
//     records the store already holds — a restart re-seeds the queue from the
//     disk file — so re-posting is the normal case, not the error case. A
//     duplicate is dropped and counted, never a 422: a producer punished for
//     re-sending would learn to forget instead.
//   * TOLERANT of an unknown lane name. The lane list lives in the runner and
//     changes with it; a store that rejects a lane somebody added has stopped
//     recording the thing it exists to record.
//
// What it does NOT tolerate is a malformed firing. `outcome` IS pinned to an
// enum, because it is the OS's own three-valued vocabulary rather than a third
// party's, and a fourth value would be a producer bug arriving as evidence.

import {
  CRON_RUN_SILENCE_MS,
  LATEST_JOB_RUNS_SQL,
  MANUAL_JOB_RUNS_SQL,
  MANUAL_RUN_DETAIL,
  type ManualJobRun,
} from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import {
  FUTURE_SKEW_MS,
  Issues,
  asObject,
  enumValue,
  nonNegativeInteger,
  optionalString,
  pastInstant,
  requiredString,
} from './routes/validate.js';

/** How much history the table keeps. Fixed HERE, in the migration comment, and
 * as `JOB_RUN_RETENTION_DAYS` in scripts/job-runs.mjs — change all three together.
 * The mirror cannot outlive the record it mirrors: the runner can only ever ship
 * what its own 30-day file still holds. */
export const JOB_RUN_RETENTION_DAYS = 30;

/** The outer bound on one POST. The runner ships oldest-first in slices of this
 * size and drains its queue over the following ticks, so a longer outage costs
 * more requests rather than one unbounded body. */
export const JOB_RUN_MAX_BATCH = 500;

/** A lane name ('backup', 'cron 45 12 * * 1'). */
export const JOB_RUN_JOB_MAX = 128;
/** The runner flattens and truncates its detail to 200 chars; this is the
 * ceiling on what any producer may send. */
export const JOB_RUN_DETAIL_MAX = 500;
/** A firing longer than a day is a producer computing a duration wrong — the
 * longest real lane here is a nightly backup measured in minutes. */
export const JOB_RUN_MAX_MS = 86_400_000;

export const JOB_RUN_OUTCOMES = ['ran', 'skipped', 'failed'] as const;
export type JobRunOutcome = (typeof JOB_RUN_OUTCOMES)[number];

/** One firing on the wire. `ms` rather than a finish timestamp, because that is
 * what the runner measures; the store derives `finished_at` once, on the way in,
 * so it can never hold a duration that disagrees with its own timestamps. */
export interface JobRunInput {
  job: string;
  startedAt: string;
  ms: number;
  outcome: JobRunOutcome;
  detail?: string | null;
  /** The tick this firing belongs to, when a producer can honestly distinguish
   * it from the start. The runner cannot and sends none — see db/0022. */
  scheduledAt?: string | null;
}

export interface JobRunsInput {
  runs: JobRunInput[];
}

export type JobRunsResult =
  | {
      ok: true;
      received: number;
      created: number;
      /** Already in the store under the same (job, startedAt) — the normal cost
       * of a producer that re-sends rather than forgets. */
      duplicate: number;
      /** Older than the retention window, so accepted and not stored. A row
       * inserted and then swept by its own insert would be a write reported as
       * successful and silently undone. */
      stale: number;
      pruned: number;
    }
  | { ok: false; error: 'validation'; issues: { path: string; code: string; message: string }[] };

interface StoredRun {
  job: string;
  scheduledAt: string | null;
  startedAt: string;
  finishedAt: string;
  outcome: JobRunOutcome;
  detail: string | null;
}

/** An ISO instant that may be absent. Tolerates a future value the way the
 * beads lane does: this is the producer's clock, and a second of skew must not
 * cost the record. */
function optionalInstant(issues: Issues, value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    issues.add(path, 'invalid_type', `${path} must be an ISO-8601 datetime string`);
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issues.add(path, 'invalid_format', `${path} must be an ISO-8601 datetime`);
    return null;
  }
  return new Date(parsed).toISOString();
}

function parseRun(
  issues: Issues,
  raw: Record<string, unknown>,
  path: string,
  nowMs: number,
): StoredRun | null {
  const job = requiredString(issues, raw.job, `${path}.job`, JOB_RUN_JOB_MAX);
  // A firing is always in the past. A record from the future would sit at the
  // top of "what did each lane last do?" forever, which is precisely how a dead
  // lane would go on looking alive.
  const startedAt = pastInstant(issues, raw.startedAt, `${path}.startedAt`, nowMs, FUTURE_SKEW_MS);
  const ms = nonNegativeInteger(issues, raw.ms, `${path}.ms`, JOB_RUN_MAX_MS);
  const outcome = enumValue(issues, raw.outcome, `${path}.outcome`, JOB_RUN_OUTCOMES);
  const detail = optionalString(issues, raw.detail, `${path}.detail`, JOB_RUN_DETAIL_MAX);
  const scheduledAt = optionalInstant(issues, raw.scheduledAt, `${path}.scheduledAt`);

  if (job === null || startedAt === null || ms === null || outcome === null) return null;
  return {
    job,
    scheduledAt,
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + ms).toISOString(),
    outcome,
    detail,
  };
}

/**
 * Validate one batch of firings and store what is still inside the window.
 *
 * The whole batch fails on any malformed run: a producer sending garbage is
 * broken, and storing the readable half of a broken batch would leave the record
 * with holes nobody can see.
 */
export async function writeJobRuns(
  env: IngestEnv,
  input: JobRunsInput,
  nowMs: number = Date.now(),
): Promise<JobRunsResult> {
  const issues = new Issues();

  if (!Array.isArray(input?.runs)) {
    issues.add('runs', 'invalid_type', 'runs must be an array');
    return { ok: false, error: 'validation', issues: issues.list };
  }
  if (input.runs.length === 0) {
    issues.add('runs', 'too_small', 'runs must hold at least one firing');
    return { ok: false, error: 'validation', issues: issues.list };
  }
  if (input.runs.length > JOB_RUN_MAX_BATCH) {
    issues.add('runs', 'too_big', `runs must hold at most ${JOB_RUN_MAX_BATCH} firings`);
    return { ok: false, error: 'validation', issues: issues.list };
  }

  const parsed: StoredRun[] = [];
  for (let i = 0; i < input.runs.length; i++) {
    const raw = asObject(input.runs[i]);
    if (!raw) {
      issues.add(`runs.${i}`, 'invalid_type', `runs.${i} must be an object`);
      continue;
    }
    const run = parseRun(issues, raw, `runs.${i}`, nowMs);
    if (run) parsed.push(run);
  }
  if (!issues.ok) return { ok: false, error: 'validation', issues: issues.list };

  const cutoff = new Date(nowMs - JOB_RUN_RETENTION_DAYS * 86_400_000).toISOString();
  const fresh = parsed.filter((run) => run.startedAt >= cutoff);
  const recordedAt = new Date(nowMs).toISOString();

  // One transaction: the batch, then the sweep.
  const { created, pruned } = await env.STORE.write(async (tx) => {
    let created = 0;
    if (fresh.length > 0) {
      // `ON CONFLICT DO NOTHING` plus `RETURNING`: the conflict is the
      // idempotence contract, and the returned rows are what count the insert.
      // A firing the store already holds, or one this batch already named, is
      // left out before the insert, so a re-sent record takes no number of the
      // workspace's (the numbering trigger runs before the conflict is found).
      // The rest go in the order the runner sent them.
      const inserted = await tx.query<{ job_run_id: bigint }>(
        `INSERT INTO noticeos.job_runs (workspace_id, job, scheduled_at, started_at, finished_at, outcome, detail, recorded_at)
         SELECT $1::uuid, r.job, r.scheduled_at, r.started_at, r.finished_at, r.outcome, r.detail, $8::timestamptz
           FROM (SELECT DISTINCT ON (u.job, u.started_at) u.*
                   FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::timestamptz[], $6::text[], $7::text[])
                        WITH ORDINALITY AS u(job, scheduled_at, started_at, finished_at, outcome, detail, sent)
                  ORDER BY u.job, u.started_at, u.sent) r
          WHERE NOT EXISTS (SELECT 1 FROM noticeos.job_runs j WHERE j.job = r.job AND j.started_at = r.started_at)
          ORDER BY r.sent
         ON CONFLICT (workspace_id, job, started_at) DO NOTHING
         RETURNING job_run_id`,
        [
          tx.workspaceId,
          fresh.map((run) => run.job),
          fresh.map((run) => run.scheduledAt),
          fresh.map((run) => run.startedAt),
          fresh.map((run) => run.finishedAt),
          fresh.map((run) => run.outcome),
          fresh.map((run) => run.detail),
          recordedAt,
        ],
      );
      created = inserted.length;
    }
    // Bounded history, swept on the way in so nothing has to remember to (the
    // posture db/0017 set). Rows older than the window were already excluded
    // from this insert, so the sweep can never delete what it just wrote.
    const pruned = await tx.execute(`DELETE FROM noticeos.job_runs WHERE started_at < $1::timestamptz`, [cutoff]);
    return { created, pruned };
  });

  return {
    ok: true,
    received: parsed.length,
    created,
    duplicate: fresh.length - created,
    stale: parsed.length - fresh.length,
    pruned,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual firings (bead ro-ujb9.96.7.19): a job step a person ran now.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record one manual firing — the connect panel's Start collecting, run inside
 * this Worker rather than by the runner, which therefore never sees it. Marked
 * `MANUAL_RUN_DETAIL`, so the latest-run read (cron health, a lane's scheduled
 * last run) leaves it out and the Workflows page lists it marked Manual.
 *
 * Never throws: the record is telemetry about a press that already happened,
 * and failing to write it must not turn a collected site into an error.
 */
export async function recordManualRun(
  env: IngestEnv,
  run: { job: string; startedAt: string; finishedAt: string; outcome: JobRunOutcome },
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const inserted = await env.STORE.write((tx) =>
      tx.query<{ job_run_id: bigint }>(
        `INSERT INTO noticeos.job_runs (workspace_id, job, scheduled_at, started_at, finished_at, outcome, detail, recorded_at)
         VALUES ($1::uuid, $2, NULL, $3::timestamptz, $4::timestamptz, $5, $6, $7::timestamptz)
         ON CONFLICT (workspace_id, job, started_at) DO NOTHING
         RETURNING job_run_id`,
        [tx.workspaceId, run.job, run.startedAt, run.finishedAt, run.outcome, MANUAL_RUN_DETAIL, new Date(nowMs).toISOString()],
      ),
    );
    return inserted.length > 0;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'manual-run-not-recorded', job: run.job, error: error instanceof Error ? error.name : 'unknown' }));
    return false;
  }
}

/** The manual firings still in the record, newest first. */
export async function readManualJobRuns(env: IngestEnv): Promise<ManualJobRun[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ job: string; started_at: string; finished_at: string; outcome: string }>(MANUAL_JOB_RUNS_SQL),
  );
  return rows.flatMap((row) =>
    (JOB_RUN_OUTCOMES as readonly string[]).includes(row.outcome)
      ? [{
          job: row.job,
          startedAt: javascriptInstant(row.started_at),
          finishedAt: javascriptInstant(row.finished_at),
          outcome: row.outcome as JobRunOutcome,
        }]
      : [],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader: what the record says about whether the crons are running.
// ─────────────────────────────────────────────────────────────────────────────

/** One lane's most recent firing. */
export interface JobRunLatest {
  job: string;
  outcome: string;
  startedAt: string;
}

export { CRON_RUN_SILENCE_MS };

/**
 * Each lane's latest firing: one row per lane, carrying the outcome of its
 * most recent run (`LATEST_JOB_RUNS_SQL`). `(job, started_at)` is UNIQUE, so
 * there is never a tie to break.
 */
export async function latestJobRuns(env: Pick<IngestEnv, 'STORE'>): Promise<JobRunLatest[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ job: string; outcome: string; started_at: string }>(LATEST_JOB_RUNS_SQL),
  );
  return rows.map((row) => ({
    job: row.job,
    outcome: row.outcome,
    startedAt: javascriptInstant(row.started_at),
  }));
}

/**
 * Did the scheduled lanes run? `1` yes, `0` no, `null` UNKNOWN.
 *
 * The three states are the point of this whole lane. Asset #0 used to emit a
 * hard-coded `1`, so a cron that never fired still scored full marks (docs/19
 * finding 6). The replacement must never manufacture that `1` again — which
 * means "the record is empty" cannot round up to success, and it cannot round
 * down to failure either: before the operator's first restart after this shipped
 * there is nothing in the table, and "the lanes failed" would be as invented as
 * "the lanes are fine". Nothing observed is reported as nothing observed, by
 * omitting the metric AND its capability from the envelope — which is exactly
 * what `capabilities` means in docs/02: the metric families the asset can
 * actually observe.
 *
 * Once there IS a record, two things make it 0:
 *   - a lane whose LATEST firing failed (the bead's acceptance criterion) —
 *     regardless of age, because a failed lane stays failed until a later firing
 *     says otherwise;
 *   - total silence for a day, because the mirror only grows while the runner is
 *     alive. Without this rule a dead runner would freeze the table on its last
 *     healthy row and the metric would report 1 forever — the hard-coded
 *     constant rebuilt out of stale evidence.
 */
export function cronRunSuccessValue(latest: JobRunLatest[], nowMs: number): 0 | 1 | null {
  if (latest.length === 0) return null;
  if (latest.some((run) => run.outcome === 'failed')) return 0;
  const freshest = latest.reduce((max, run) => (run.startedAt > max ? run.startedAt : max), '');
  return Date.parse(freshest) >= nowMs - CRON_RUN_SILENCE_MS ? 1 : 0;
}
