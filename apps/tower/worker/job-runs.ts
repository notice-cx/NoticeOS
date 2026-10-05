import { LATEST_JOB_RUNS_SQL } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import type { ScheduledLane, ScheduledLaneOutcome } from "../shared/wall";

type LatestJobRunRow = {
  job: string;
  outcome: string;
  started_at: string;
};

function outcomeOf(value: string): ScheduledLaneOutcome {
  if (value === "ran" || value === "skipped" || value === "failed") return value;
  throw new Error(`job_runs contains unsupported outcome: ${value}`);
}

/**
 * The Tower's read-only view over the runner-owned record, in the call's store
 * (bead ro-ujb9.76.4.3). This intentionally consumes the same SQL constant as
 * ingest's cronRunSuccess derivation.
 */
export async function readLatestJobRuns(store: WorkspaceStore): Promise<ScheduledLane[]> {
  const rows = await store.read((tx) => tx.query<LatestJobRunRow>(LATEST_JOB_RUNS_SQL));
  return rows
    .map((row) => ({
      job: row.job,
      outcome: outcomeOf(row.outcome),
      startedAt: javascriptInstant(row.started_at),
    }))
    .sort((a, b) => a.job.localeCompare(b.job));
}
