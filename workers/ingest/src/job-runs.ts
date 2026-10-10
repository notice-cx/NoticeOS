// The job-run writer, and the reader that turns it into a metric. The
// producer is the runner, the only process that fires the scheduled lanes and
// therefore the only witness to a lane that fires while the ingest is down; it
// records every firing to disk first and ships batches whenever the door
// answers, so this module is a mirror of that record: batches, not one row per
// request; idempotent on (job, startedAt), because a restart re-seeds the
// runner's queue and re-posting is the normal case; tolerant of an unknown
// lane name, because the lane list lives in the runner. A malformed firing is
// not tolerated: `outcome` is the OS's own vocabulary. One more producer
// writes here directly: a job step a person runs now (`recordManualRun`),
// marked so the latest-run read leaves it out.

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
  enumValue,
  nonNegativeInteger,
  optionalString,
  pastInstant,
  requiredString,
} from './routes/validate.js';
import { asRecord } from './shared.js';

/** How much history the table keeps; the same number as `JOB_RUN_RETENTION_DAYS`
 * in scripts/job-runs.mjs. The mirror cannot outlive the record it mirrors. */
export const JOB_RUN_RETENTION_DAYS = 30;

/** The outer bound on one POST. The runner ships oldest-first in slices of
 * this size, so a longer outage costs more requests rather than one unbounded
 * body. */
export const JOB_RUN_MAX_BATCH = 500;

/** A lane name ('backup', 'cron 45 12 * * 1'). */
export const JOB_RUN_JOB_MAX = 128;
/** The ceiling on what any producer may send; the runner truncates to 200. */
export const JOB_RUN_DETAIL_MAX = 500;
/** A firing longer than a day is a producer computing a duration wrong. */
export const JOB_RUN_MAX_MS = 86_400_000;

export const JOB_RUN_OUTCOMES = ['ran', 'skipped', 'failed'] as const;
export type JobRunOutcome = (typeof JOB_RUN_OUTCOMES)[number];

/** One firing on the wire. `ms` rather than a finish timestamp, because that is
 * what the runner measures; the store derives `finished_at` once. */
export interface JobRunInput {
  job: string;
  startedAt: string;
  ms: number;
  outcome: JobRunOutcome;
  detail?: string | null;
  /** The tick this firing belongs to, when a producer can honestly distinguish
   * it from the start. The runner cannot and sends none. */
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
      /** Already in the store under the same (job, startedAt). */
      duplicate: number;
      /** Older than the retention window: accepted and not stored, since a row
       * inserted and then swept by its own insert would be a silently undone write. */
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

/** An ISO instant that may be absent. Tolerates a future value: this is the
 * producer's clock, and a second of skew must not cost the record. */
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
  // A firing is always in the past: a record from the future would sit at the
  // top of "what did each lane last do?" forever.
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
 * Validate one batch of firings and store what is still inside the window. The
 * whole batch fails on any malformed run: storing the readable half of a broken
 * batch would leave holes nobody can see.
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
    const raw = asRecord(input.runs[i]);
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
    // Rows older than the window were already excluded from this insert, so
    // the sweep can never delete what it just wrote.
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
// Manual firings: a job step a person ran now.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record one manual firing, run inside this Worker rather than by the runner.
 * Marked `MANUAL_RUN_DETAIL`, so the latest-run read leaves it out and the
 * Workflows page lists it as Manual. Never throws: the record is telemetry
 * about a press that already happened.
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
 * Each lane's latest firing. `(job, started_at)` is unique, so there is never
 * a tie to break.
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
 * Did the scheduled lanes run? `1` yes, `0` no, `null` unknown. An empty
 * record cannot round up to success or down to failure: nothing observed is
 * reported as nothing observed, by omitting the metric and its capability from
 * the envelope. Once there is a record, a lane whose latest firing failed is
 * 0 regardless of age, and so is total silence for a day, because the mirror
 * only grows while the runner is alive.
 */
export function cronRunSuccessValue(latest: JobRunLatest[], nowMs: number): 0 | 1 | null {
  if (latest.length === 0) return null;
  if (latest.some((run) => run.outcome === 'failed')) return 0;
  const freshest = latest.reduce((max, run) => (run.startedAt > max ? run.startedAt : max), '');
  return Date.parse(freshest) >= nowMs - CRON_RUN_SILENCE_MS ? 1 : 0;
}
