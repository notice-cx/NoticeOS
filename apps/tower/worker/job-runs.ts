import { LATEST_JOB_RUNS_SQL } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import type { ScheduledLane, ScheduledLaneOutcome } from "../shared/wall";

type LatestJobRunRow = {
  job: string;
  outcome: string;
  started_at: string;
  last_ran_at: string | null;
  failing_since: string | null;
  failed_runs: number;
};

function outcomeOf(value: string): ScheduledLaneOutcome {
  if (value === "ran" || value === "skipped" || value === "failed") return value;
  throw new Error(`job_runs contains unsupported outcome: ${value}`);
}

/** The runner-owned record, read with the same SQL constant as ingest's
 * cronRunSuccess derivation. */
export async function readLatestJobRuns(store: WorkspaceStore): Promise<ScheduledLane[]> {
  const rows = await store.read((tx) => tx.query<LatestJobRunRow>(LATEST_JOB_RUNS_SQL));
  return rows
    .map((row) => ({
      job: row.job,
      outcome: outcomeOf(row.outcome),
      startedAt: javascriptInstant(row.started_at),
      lastRanAt: row.last_ran_at === null ? null : javascriptInstant(row.last_ran_at),
      failedRuns: row.failed_runs,
      failingSince: row.failing_since === null ? null : javascriptInstant(row.failing_since),
    }))
    .sort((a, b) => a.job.localeCompare(b.job));
}

/** A manual-only backup has no scheduled firing to appear in the lane read.
 * Read its good copy separately so it cannot make a silent scheduler look alive. */
export async function readBackupLastGoodAt(store: WorkspaceStore): Promise<string | null> {
  const rows = await store.read((tx) => tx.query<{ last_ran_at: string | null }>(
    "SELECT max(started_at) AS last_ran_at FROM noticeos.job_runs WHERE job = 'backup' AND outcome = 'ran'",
  ));
  const at = rows[0]?.last_ran_at;
  return at == null ? null : javascriptInstant(at);
}
