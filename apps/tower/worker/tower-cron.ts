// The Tower's share of a scheduled tick: the steps that must count with the
// Tower's own models so the recorded number matches the screen (the ingest
// build cannot import them). Called by a deployed Tower's `scheduled()` and by
// the local runner through runner-route.ts, as one run of the job.

import type { WorkflowStepRun } from "@noticeos/contract";
import type { WorkspaceStore } from "@noticeos/postgres";
import { redactLogText } from "../../../scripts/os-log.mjs";
import { SCHEDULED_JOBS } from "../../../scripts/scheduled-jobs.mjs";
import { createWorkflowRecorder } from "../../../scripts/workflow-trace.mjs";
import { type IntegrationHealthIngest, recordTodaysConnectionCounts } from "./connection-status-daily";
import { type IntegrationsSettings, integrationsDeps, recordTodaysSourceHistory } from "./integrations-payload";

/** The hourly tick's expression: the Data freshness checks job's dispatch key,
 * which the runner fires whatever time the operator saved for it. */
export const HOURLY_TICK: string = SCHEDULED_JOBS.find((job) => job.id === "freshness")!.cron;

export interface TowerCronEnv {
  STORE: WorkspaceStore;
  INGEST: IntegrationHealthIngest;
  /** Resolved as a request resolves them, so the matrix matches the page. */
  config: () => Promise<IntegrationsSettings>;
}

/**
 * Run the Tower's steps for `cron`, traced. Never throws: a failed step is in
 * the trace, its error in the service log, and the other steps and the
 * ingest's steps of the same tick stand. An expression with no Tower step
 * returns no steps.
 */
export async function runTowerCron(cron: string, env: TowerCronEnv, now: () => Date = () => new Date()): Promise<WorkflowStepRun[]> {
  if (cron !== HOURLY_TICK) return [];
  const trace = createWorkflowRecorder({
    failed: (step, error) => console.error(JSON.stringify({
      event: "scheduled_step_failed", cron, step,
      message: redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    })),
  });
  const step = async (id: string, run: () => Promise<unknown>) => {
    try {
      await trace.run(id, run);
    } catch {
      // Recorded as a failed step above; the next step still runs.
    }
  };
  await step("connection-counts", () => recordTodaysConnectionCounts(env.INGEST, env.STORE, now()));
  await step("source-history", async () => recordTodaysSourceHistory(env.STORE, integrationsDeps(await env.config(), now())));
  return trace.steps;
}
