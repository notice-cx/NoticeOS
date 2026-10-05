/**
 * A firing a person started from the product rather than the scheduler — the
 * connect panel's Start collecting, which runs one job step now (bead
 * `ro-ujb9.96.7.19`). It is recorded in `job_runs` like any firing, marked in
 * its `detail` column (no schema change), so the Workflows page can list it in
 * its job's run history, marked Manual.
 *
 * The runner never writes this detail: its own records carry a lane's summary
 * or nothing.
 */
export const MANUAL_RUN_DETAIL = "trigger:manual";

/**
 * The one latest-run read shared by asset #0's signal and every Tower surface.
 * Keeping the SQL here prevents the monitoring metric and the operator view
 * from quietly choosing different rows for the same scheduled lane.
 *
 * On Postgres (bead `ro-ujb9.76.4.3`): each job's newest start, one row per
 * job. `(job, started_at)` is unique, so there is never a tie to break.
 * Instants leave as the store prints them; each reader passes them through
 * `javascriptInstant`.
 *
 * SCHEDULED FIRINGS ONLY. A manual run is left out, so "did the crons run?"
 * (`cronRunSuccessValue`) and a lane's scheduled last run mean exactly what
 * they meant before manual runs were recorded: a press cannot make a silent
 * scheduler look alive, nor a failed press make a healthy one look broken.
 */
export const LATEST_JOB_RUNS_SQL =
  `SELECT DISTINCT ON (job) job, outcome, started_at FROM noticeos.job_runs WHERE detail IS NULL OR detail <> '${MANUAL_RUN_DETAIL}' ORDER BY job, started_at DESC`;

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

/** A whole day with no firing means the local scheduler itself is silent. */
export const CRON_RUN_SILENCE_MS = 24 * 3_600_000;
