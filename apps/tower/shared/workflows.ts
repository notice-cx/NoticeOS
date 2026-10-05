import type { WorkflowRun } from '@noticeos/contract';
import type { ScheduledJobsPayload } from './scheduled-jobs';
import { WORKFLOW_DEFINITIONS, type WorkflowDefinition } from '../../../scripts/workflow-definitions.mjs';
export * from '../../../scripts/workflow-definitions.mjs';

/**
 * The workflows this installation runs. One whose runner says it does not run
 * the host's lanes (an installation `pnpm start` runs, bead ro-ujb9.156) has
 * only the `local` jobs its runner lists — the task board refresh and the
 * backup, once each is set up (bead ro-ujb9.174); every other job is listed,
 * and one its runner does not report stays unconfirmed.
 */
export function installedWorkflows(data?: Pick<ScheduledJobsPayload, 'runtime'> & { workflows?: readonly { id: string }[] }): WorkflowDefinition[] {
  const runtime = data?.runtime;
  const recorded = (id: string) => data?.workflows?.some(workflow => workflow.id === id) ?? false;
  if (!runtime && data?.workflows) return WORKFLOW_DEFINITIONS.filter(workflow => recorded(workflow.id));
  if (runtime?.onlyListedJobs) return WORKFLOW_DEFINITIONS.filter(workflow =>
    (runtime.registeredJobs?.includes(workflow.id) ?? runtime.jobs.some(job => job.id === workflow.id)) || recorded(workflow.id));
  if (runtime?.hostLanes !== false) return WORKFLOW_DEFINITIONS;
  return WORKFLOW_DEFINITIONS.filter((workflow) => !workflow.local || runtime.jobs.some((job) => job.id === workflow.id));
}
/**
 * What System health's footer says this installation runs in the background,
 * named from the workflows it has installed (bead `ro-ujb9.178`): collection
 * and service checks always, then each installed job's own `footer` phrase —
 * the task-board refresh and backups a started installation runs once a task
 * project is saved and an offsite backup folder is set.
 */
export function backgroundWorkSummary(workflows: readonly Pick<WorkflowDefinition, 'footer'>[]): string {
  const parts = ['Collection', 'service checks', ...workflows.flatMap((workflow) => (workflow.footer ? [workflow.footer] : []))];
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}
export type { WorkflowRun, WorkflowStepRun, WorkflowStepDefinition } from '@noticeos/contract';

import type { WorkflowSummary, WorkflowBucket } from '../../../scripts/workflow-history-view.mjs';
// This screen shares the result types; history construction stays in its reader.
export type { WorkflowSummary, WorkflowBucket };
export interface WorkflowsPayload extends ScheduledJobsPayload {
  generatedAt: string;
  historyAvailable: boolean;
  observationsFresh: boolean;
  workflows: WorkflowSummary[];
  selectedRun: WorkflowRun | null;
}

export type WorkflowState = WorkflowRun['state'] | 'paused' | 'unknown' | 'never';
export function workflowState(summary: WorkflowSummary, data: Pick<WorkflowsPayload, 'historyAvailable' | 'observationsFresh' | 'runtimeFresh' | 'runtime'>): WorkflowState {
  if (!data.historyAvailable || !data.observationsFresh || !data.runtimeFresh) return 'unknown';
  if (summary.active) return 'running';
  const activeSchedule = data.runtime?.jobs.find((j) => j.id === summary.id);
  if (!activeSchedule) return 'unknown';
  if (!activeSchedule.enabled) return 'paused';
  return summary.latest?.state ?? 'never';
}
export const WORKFLOW_STATE_LABEL: Record<WorkflowState, string> = {
  succeeded: 'Succeeded', failed: 'Failed', running: 'Running', skipped: 'Skipped',
  waiting: 'Awaiting approval', paused: 'Paused', unknown: 'Unknown', never: 'No runs',
};

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
export function workflowRunAge(startedAt: string, now: number): string {
  const elapsed = now - Date.parse(startedAt);
  if (!Number.isFinite(elapsed)) return 'Time unknown';
  if (elapsed < 60_000) return 'Just now';
  const unit = elapsed < 3_600_000 ? 'minute' : elapsed < 86_400_000 ? 'hour' : 'day';
  const divisor = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000;
  return relativeTime.format(-Math.floor(elapsed / divisor), unit);
}

/** The runner's unpublished-commit check (`push-state` in
 * scripts/scheduled-jobs.mts): the one job whose unread sites System health
 * names (bead `ro-ujb9.188`). */
export const PUSH_STATE_JOB = 'push-state';

/**
 * THE SITES A RUN COULD NOT READ, and why (bead `ro-ujb9.188`): its steps'
 * failed output items, each labelled by its site, and their reasons in words
 * (the run's own projection, scripts/workflow-output.mts). Null when the run
 * read every site. Under launchd the unpublished-commit check can find a
 * site's remote refusing the service's sign-in; this is how that reaches the
 * screen rather than one log line.
 */
export function unreadSites(run: WorkflowRun | null | undefined): { runId: string; sites: string[]; reasons: string[] } | null {
  const items = run?.steps?.flatMap((step) => step.output?.items ?? []).filter((item) => item.state === 'failed') ?? [];
  if (!run || items.length === 0) return null;
  const reasons = items.flatMap((item) => item.fields.filter((field) => field.key === 'reason').map((field) => String(field.value)));
  return { runId: run.id, sites: [...new Set(items.map((item) => item.label))], reasons: [...new Set(reasons)] };
}

export type WorkflowSurface = 'workflow' | 'system';
export function workflowBasePath(surface: WorkflowSurface): string { return surface === 'system' ? '/health/operations' : '/workflows'; }
