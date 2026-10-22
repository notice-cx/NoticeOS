/**
 * A firing a person started from the product rather than the scheduler. It is
 * recorded in `job_runs` like any firing, marked in its `detail` column, so
 * the Workflows page can list it marked Manual. The runner never writes this
 * detail.
 */
export const MANUAL_RUN_DETAIL = "trigger:manual";

/**
 * The one latest-run read shared by asset #0's signal and every Tower
 * surface: each job's newest start, one row per job (`(job, started_at)` is
 * unique). Instants leave as the store prints them; each reader passes them
 * through `javascriptInstant`. Scheduled firings only: a press cannot make a
 * silent scheduler look alive, nor a failed press make a healthy one look
 * broken.
 *
 * Beside it, each job's newest firing that ran (`last_ran_at`), a press
 * included, because a press that ran did the job's work; then the scheduled
 * firings that failed after it, counted (`failed_runs`) and dated from the
 * first (`failing_since`). With nothing that ran on record, every failed
 * scheduled firing counts.
 */
export const LATEST_JOB_RUNS_SQL = `WITH good AS (
    SELECT job, max(started_at) AS last_ran_at FROM noticeos.job_runs WHERE outcome = 'ran' GROUP BY job
  )
SELECT DISTINCT ON (r.job) r.job, r.outcome, r.started_at, g.last_ran_at,
       min(r.started_at) FILTER (WHERE r.outcome = 'failed' AND r.started_at > coalesce(g.last_ran_at, '-infinity')) OVER (PARTITION BY r.job) AS failing_since,
       (count(*) FILTER (WHERE r.outcome = 'failed' AND r.started_at > coalesce(g.last_ran_at, '-infinity')) OVER (PARTITION BY r.job))::int AS failed_runs
  FROM noticeos.job_runs r LEFT JOIN good g ON g.job = r.job
 WHERE r.detail IS NULL OR r.detail <> '${MANUAL_RUN_DETAIL}'
 ORDER BY r.job, r.started_at DESC`;

/** The manual firings the record still holds, newest first (two at one
 * instant, the later recorded first) — what the Workflows page adds to each
 * job's run history. Bounded like every read the page makes. */
export const MANUAL_JOB_RUNS_SQL =
  `SELECT job, started_at, finished_at, outcome FROM noticeos.job_runs WHERE detail = '${MANUAL_RUN_DETAIL}' ORDER BY started_at DESC, job_run_id DESC LIMIT 200`;

/** One manual firing on the wire (`GET /api/job-runs?trigger=manual`). */
export interface ManualJobRun {
  job: string;
  startedAt: string;
  finishedAt: string;
  outcome: "ran" | "skipped" | "failed";
}

/** Complete UTC calendar counts, independent of the bounded manual details. */
export interface ManualJobRunHistory {
  timeZone: "UTC";
  from: string;
  through: string;
  buckets: { job: string; at: string; succeeded: number; failed: number; skipped: number; firstRunAt: string; runAt: string }[];
}

/** A whole day with no firing means the local scheduler itself is silent. */
export const CRON_RUN_SILENCE_MS = 24 * 3_600_000;
