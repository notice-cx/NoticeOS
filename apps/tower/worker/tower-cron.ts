// The Tower's share of a scheduled tick: the steps that must count with the
// Tower's own models so the recorded number matches the screen (the ingest
// build cannot import them). Called by a deployed Tower's `scheduled()` and by
// the local runner through runner-route.ts, as one run of the job.

import type { WorkflowStepRun } from "@noticeos/contract";
import type { WorkspaceStore } from "@noticeos/postgres";
import { redactLogText } from "../../../scripts/os-log.mjs";
import { SCHEDULED_JOBS, scheduleFor, cronIntervalMinutes } from "../../../scripts/scheduled-jobs.mjs";
import { createWorkflowRecorder, stepResult } from "../../../scripts/workflow-trace.mjs";
import { type IntegrationHealthIngest, recordTodaysConnectionCounts } from "./connection-status-daily";
import { type IntegrationsSettings, integrationsDeps, recordTodaysSourceHistory } from "./integrations-payload";
import type { TowerConfig } from './config-source';
import type { PortfolioBriefIngest } from './portfolio-brief-route';
import { buildWallPayload } from './wall-payload';
import { buildWorkPayload } from './work-payload';
import { loadRevenueHistories } from './daily-revenue';
import { operatorRevenueClock } from '../shared/daily-revenue';
import { buildPortfolioBriefEvidence } from './portfolio-brief-evidence';

/** The hourly tick's expression: the Data freshness checks job's dispatch key,
 * which the runner fires whatever time the operator saved for it. */
export const HOURLY_TICK: string = SCHEDULED_JOBS.find((job) => job.id === "freshness")!.cron;
export const BRIEFING_TICK: string = SCHEDULED_JOBS.find((job) => job.id === 'portfolio-brief')!.cron;

export interface TowerCronEnv {
  STORE: WorkspaceStore;
  INGEST: IntegrationHealthIngest;
  /** Resolved as a request resolves them, so the matrix matches the page. */
  config: () => Promise<IntegrationsSettings>;
  briefing?: { ingest: PortfolioBriefIngest; config: () => Promise<TowerConfig> };
}

/**
 * Run the Tower's steps for `cron`, traced. Never throws: a failed step is in
 * the trace, its error in the service log, and the other steps and the
 * ingest's steps of the same tick stand. An expression with no Tower step
 * returns no steps.
 */
export async function runTowerCron(cron: string, env: TowerCronEnv, now: () => Date = () => new Date(), trigger?: 'event' | 'recovery' | 'manual'): Promise<WorkflowStepRun[]> {
  if (cron !== HOURLY_TICK && cron !== BRIEFING_TICK) return [];
  const trace = createWorkflowRecorder({
    failed: (step, error) => console.error(JSON.stringify({
      event: "scheduled_step_failed", cron, step,
      message: redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    })),
  });
  const step = async (id: string, run: () => Promise<unknown>) => {
    try {
      await trace.run(id, run, result => {
        if (id === 'portfolio-brief' && typeof result === 'string') return { state: 'skipped', summary: result };
        return stepResult(result);
      });
    } catch {
      // Recorded as a failed step above; the next step still runs.
    }
  };
  if (cron === BRIEFING_TICK) {
    await step('portfolio-brief', async () => {
      if (!env.briefing?.ingest.refreshPortfolioBrief || !env.briefing.ingest.portfolioBrief) return 'Briefing generation is unavailable';
      const state = await env.briefing.ingest.portfolioBrief();
      if (state.state === 'disconnected') return 'Connect a model provider before generating a briefing';
      if (state.state === 'unsupported') return 'Briefing generation is unavailable';
      const at = now();
      if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > at.getTime()) return 'Briefing generation is limited to once every 15 minutes';
      const cfg = await env.briefing.config();
      const schedule = scheduleFor(SCHEDULED_JOBS.find(job => job.id === 'portfolio-brief')!, cfg.schedules ?? {});
      if (!schedule.enabled) return 'Workflow is paused';
      const [wall, work] = await Promise.all([
        buildWallPayload(env.STORE, { now: at, constants: cfg.monthlyCaps, integrations: cfg.integrations, pullConfig: cfg.pullConfig,
          dashboard: cfg.dashboard, serpPanel: cfg.serpPanel, osTimeZone: cfg.osTimeZone, noNightlyReport: cfg.noNightlyReport, counters: cfg.counters, schedules: cfg.schedules }),
        buildWorkPayload(env.STORE, { now: at, projects: cfg.beads.spokes, timeZone: cfg.osTimeZone }),
      ]);
      const assetIds = wall.assets.map(asset => asset.id);
      const revenueByAsset = await loadRevenueHistories(env.STORE, { now: at, days: 28, fallback: operatorRevenueClock(cfg.osTimeZone), assets: assetIds });
      const evidence = buildPortfolioBriefEvidence(wall, work, { now: at, revenueByAsset });
      const result = await env.briefing.ingest.refreshPortfolioBrief(evidence, Math.max(15, cronIntervalMinutes(schedule.cron) ?? 60) * 60_000);
      if (result.error) throw new Error(result.error);
      if (result.state === 'disconnected' || result.state === 'unsupported') return 'Briefing generation is unavailable';
      if (result.lastAttemptAt === state.lastAttemptAt) return 'Another briefing run or its cooldown prevented generation';
      if (trigger === 'manual' && evidence.insightEvidenceIds.length === 0) return 'No comparable evidence is available for briefing insights';
    });
  } else {
    await step("connection-counts", () => recordTodaysConnectionCounts(env.INGEST, env.STORE, now()));
    await step("source-history", async () => recordTodaysSourceHistory(env.STORE, integrationsDeps(await env.config(), now())));
  }
  return trace.steps;
}
