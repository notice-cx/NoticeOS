// The workflow each scheduled job runs, as the stages its trace records.
//
// Authored TypeScript: `pnpm generate` writes the
// `.mjs` the Tower and local runner import and the `.d.mts` beside it.

import type { WorkflowStepDefinition, WorkflowStepKind } from '../packages/contract/src/workflows.js';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-jobs.mjs';

export interface WorkflowDefinition extends ScheduledJob { version: number; triggerKind: 'schedule'; stages: WorkflowStepDefinition[] }

const action = (id: string, label: string, description: string, kind: WorkflowStepKind = 'task', after: string[] = ['config']): WorkflowStepDefinition => ({ id, label, description, kind, after });
const workerSteps: Readonly<Record<string, WorkflowStepDefinition[]>> = {
  mediavine: [action('revenue', 'Collect ad revenue', 'Checks the collection window and records revenue when due.', 'collection')],
  // `connection-counts` and `source-history` are the Tower's steps of this tick
  // (apps/tower/worker/tower-cron.ts), run once the ingest's checks are done.
  freshness: [action('freshness', 'Check report freshness', 'Compares received reports with their reporting obligations.', 'check'), action('uptime', 'Check sites are up', 'Fetches each site’s home page and records whether it answered.', 'check'),
    action('connection-counts', 'Record connection counts', 'Records today’s System health connection counts.', 'storage', ['freshness', 'uptime']),
    action('source-history', 'Record source history', 'Records today’s state and freshness of each data source.', 'storage', ['freshness', 'uptime'])],
  notifications: [action('notify', 'Deliver notifications', 'Delivers eligible operator notifications through connected channels.')],
  pull: [action('pull', 'Collect asset reports', 'Retrieves the reports from assets configured for pull collection.', 'collection'), action('bing', 'Refresh Bing signals', 'Retrieves Bing search signals for connected assets.', 'collection')],
  'asset-zero': [action('report', 'Record the OS report', 'Summarizes the OS’s own operating evidence.', 'storage')],
  'watch-windows': [action('outcomes', 'Evaluate outcome windows', 'Reads completed windows using the existing outcome rules.', 'check')],
  hygiene: [action('hygiene', 'Check search accessibility', 'Checks robots access, sitemaps, indexing directives and served page structure.', 'check')],
  clarity: [action('clarity', 'Collect behavior summaries', 'Retrieves available Clarity exports within provider limits.', 'collection')],
  'signal-dumps': [action('archives', 'Archive traffic and search', 'Stores the available Google and Bing reporting archives.', 'collection'), action('search-recovery', 'Recover missed search intelligence', 'Re-collects reports an internet outage skipped.', 'collection')],
  posthog: [action('product', 'Archive product analytics', 'Stores each connected asset’s PostHog report families.', 'collection')],
  dataforseo: [action('search', 'Collect search intelligence', 'Retrieves paid ranking and backlink data within the existing budget.', 'collection')],
  counters: [action('counters', 'Refresh asset counters', 'Retrieves configured public asset counters.', 'collection'), action('google', 'Refresh Google signals', 'Retrieves current Google traffic and search snapshots.', 'collection')],
};

export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = SCHEDULED_JOBS.map((job): WorkflowDefinition => {
  const stages = job.local
    ? [action('execute', job.label, 'Runs in the local service on this machine.', job.group === 'Monitoring' ? 'check' : 'task', [])]
    : [action('config', 'Load collection settings', 'Reads the saved configuration for this execution.', 'task', []), ...workerSteps[job.id]!];
  return { ...job, version: 1, triggerKind: 'schedule', stages: [...stages,
    action('record', 'Record execution', 'Persists this run’s result for operational history.', 'storage', job.local ? ['execute'] : workerSteps[job.id]!.map((s) => s.id))] };
});
