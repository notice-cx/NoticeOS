// THE TOWER'S SHARE OF A SCHEDULED TICK (bead `ro-ujb9.96.7.29`).
//
// Scheduled work is the ingest's (workers/ingest/src/dispatch.ts), except a
// step that has to count with the Tower's own models: the ingest is a separate
// build that cannot import them, and a count from a second implementation could
// disagree with the number the screen states. Two such steps today, both on the
// hourly tick (the Data freshness checks job), so every day the OS runs has a
// point whether or not anyone opened a page:
//   - System health's four connection counts (connection-status-daily.ts);
//   - each data source's state and freshness for the Source history
//     (connection-daily.ts, bead `ro-ujb9.96.7.31`), counted over the
//     integrations matrix the page builds.
//
// TWO CALLERS, ONE FUNCTION, as the ingest's dispatch has: a deployed Tower's
// own `scheduled()` handler (its cron trigger in wrangler.jsonc), and the local
// runner's fire through the ingest door (runner-route.ts), which runs the
// ingest's steps and then these, and records them as one run of the job.

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
  /** The call's store: the matrix reads the site list on Postgres (bead
   * ro-ujb9.76.4.2), and both steps record their day there (ro-ujb9.76.5.6). */
  STORE: WorkspaceStore;
  INGEST: IntegrationHealthIngest;
  /** The stored settings, as a request resolves them (config-source.ts
   * `towerConfigResolver` over the compiled copy): the matrix is built from
   * the register the page reads. */
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
