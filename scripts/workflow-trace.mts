// Portable instrumentation: no I/O, raw payloads, credentials or execution policy.
//
// Authored TypeScript (bead ro-ujb9.61): `pnpm config:generate` writes the
// `.mjs` the ingest Worker and local runner import and the `.d.mts` beside it.

import type { WorkflowStepRun } from '../packages/contract/src/workflows.js';
import { captureWorkflowOutput, unreadSiteCount } from './workflow-output.mjs';

/** An operation's result as the verdict reads it: any shape, every key guarded. */
type Probe = { readonly [key: string]: unknown } | null | undefined;
type StepVerdict = Pick<WorkflowStepRun, 'state' | 'summary'>;

/** A failed step's first line, naming what failed: sites whose remote could
 * not be read (bead ro-ujb9.233), else collections. */
function failedSummary(result: unknown, failed: number): string {
  const sites = unreadSiteCount(result);
  if (sites !== null) return `${sites} site${sites === 1 ? '' : 's'} could not be read.`;
  return `${failed} collection${failed === 1 ? '' : 's'} failed.`;
}

export function stepResult(result: unknown): StepVerdict {
  const failed = typeof (result as Probe)?.failed === 'number' ? (result as Probe)!.failed as number : Array.isArray((result as Probe)?.failed) ? ((result as Probe)!.failed as unknown[]).length : 0;
  if (result === false || (result as Probe)?.outcome === 'failed' || (result as Probe)?.ok === false || failed > 0 ||
      (typeof (result as Probe)?.code === 'number' && (result as Probe)!.code !== 0) ||
      ['delivery-failed', 'store-unavailable'].includes((result as Probe)?.skipped as string) ||
      ((result as Probe)?.projects as Probe[] | undefined)?.some?.((project) => project!.ok === false)) {
    return { state: 'failed', summary: failed > 0 ? failedSummary(result, failed) : 'The operation reported a failure.' };
  }
  if (result === null || (result as Probe)?.outcome === 'skipped' || (result as Probe)?.attempted === 0 || typeof (result as Probe)?.skipped === 'string') {
    return { state: 'skipped', summary: 'No work was performed on this pass.' };
  }
  return { state: 'succeeded', summary: typeof (result as Probe)?.succeeded === 'number' ? `${(result as Probe)!.succeeded} collection${(result as Probe)!.succeeded === 1 ? '' : 's'} completed.` : 'Completed without a reported error.' };
}

export function workflowResult(steps: WorkflowStepRun[], outcome: string): 'failed' | 'skipped' | 'succeeded' {
  if (outcome === 'failed' || steps.some((s) => s.state === 'failed')) return 'failed';
  const actions = steps.filter((s) => s.id !== 'config' && s.id !== 'record');
  if (outcome === 'skipped' || (actions.length > 0 && actions.every((s) => s.state === 'skipped'))) return 'skipped';
  return 'succeeded';
}

/** Return only after every started branch has supplied its terminal evidence. */
export async function settleWorkflowSteps(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r) => r.status === 'rejected');
  if (failure) throw failure.reason;
}

export interface WorkflowRecorder {
  steps: WorkflowStepRun[];
  run<T>(id: string, fn: () => Promise<T>, assess?: (result: T) => StepVerdict): Promise<T>;
}

/**
 * `failed` hears each step's own error as it is recorded, so the caller can
 * write it where "Check the service logs" sends the operator (bead
 * ro-ujb9.173). The recorder itself still does no I/O and keeps no error.
 */
export function createWorkflowRecorder({ now = Date.now, changed = () => {}, failed = () => {} }: {
  now?: () => number;
  changed?: (steps: WorkflowStepRun[]) => void;
  failed?: (id: string, error: unknown) => void;
} = {}): WorkflowRecorder {
  const steps: WorkflowStepRun[] = [];
  return {
    steps,
    async run<T>(id: string, fn: () => Promise<T>, assess: (result: T) => StepVerdict = stepResult) {
      const step: WorkflowStepRun = { id, attempt: steps.filter((s) => s.id === id).length + 1, startedAt: new Date(now()).toISOString(), state: 'running' };
      steps.push(step);
      changed(steps);
      try {
        const result = await fn();
        Object.assign(step, assess(result), { finishedAt: new Date(now()).toISOString() });
        // Evidence is best-effort and cannot turn a completed operation into a
        // failed operation, even if an unexpected result cannot be projected.
        try { const output = captureWorkflowOutput(result); if (output) step.output = output; } catch { /* no output captured */ }
        return result;
      } catch (error) {
        Object.assign(step, { state: 'failed', summary: 'This step failed. Check the service logs for details.', finishedAt: new Date(now()).toISOString() });
        try { failed(id, error); } catch { /* a listener cannot change the verdict */ }
        throw error;
      } finally { changed(steps); }
    },
  };
}
