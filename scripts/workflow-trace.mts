// Portable instrumentation: bounded redacted diagnostics, no I/O or execution policy.
//
// Authored TypeScript: `pnpm generate` writes the
// `.mjs` the ingest Worker and local runner import and the `.d.mts` beside it.

import type { WorkflowStepDiagnostics, WorkflowStepRun } from '../packages/contract/src/workflows.js';
import { captureWorkflowDiagnostic, isWorkflowStepDiagnostics } from './workflow-diagnostics.mjs';
import { captureWorkflowOutput } from './workflow-output.mjs';
import { portfolioBriefFailure } from './portfolio-brief-failure.mjs';

/** An operation's result as the verdict reads it: any shape, every key guarded. */
type Probe = { readonly [key: string]: unknown } | null | undefined;
type StepVerdict = Pick<WorkflowStepRun, 'state' | 'summary'>;

export function stepResult(result: unknown): StepVerdict {
  if ((result as Probe)?.operation === 'portfolio-brief' && (result as Probe)?.ok === false) {
    return { state: 'failed', summary: portfolioBriefFailure((result as Probe)?.failure as Probe).summary };
  }
  const failed = typeof (result as Probe)?.failed === 'number' ? (result as Probe)!.failed as number : Array.isArray((result as Probe)?.failed) ? ((result as Probe)!.failed as unknown[]).length : 0;
  if (result === false || (result as Probe)?.outcome === 'failed' || (result as Probe)?.ok === false || failed > 0 ||
      (typeof (result as Probe)?.code === 'number' && (result as Probe)!.code !== 0) ||
      ['delivery-failed', 'store-unavailable'].includes((result as Probe)?.skipped as string) ||
      ((result as Probe)?.projects as Probe[] | undefined)?.some?.((project) => project!.ok === false)) {
    return { state: 'failed', summary: failed > 0 ? `${failed} collection${failed === 1 ? '' : 's'} failed.` : 'The operation reported a failure.' };
  }
  if (result === null || (result as Probe)?.outcome === 'skipped' || (result as Probe)?.attempted === 0 || typeof (result as Probe)?.skipped === 'string') {
    return { state: 'skipped', summary: 'No work was performed on this pass.' };
  }
  if ((result as Probe)?.operation === 'ga4-realtime' && Array.isArray((result as Probe)?.assets)) {
    const errors = ((result as Probe)!.assets as Probe[]).filter(asset => asset?.status === 'error');
    if (errors.some(asset => asset?.reconnecting !== true)) return { state: 'failed', summary: 'Realtime traffic collection failed.' };
    if (errors.length > 0) return { state: 'waiting', summary: 'Reconnecting' };
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

export interface WorkflowDiagnosticCapture {
  input(value: unknown): void;
  output(value: unknown): void;
  error(value: unknown): void;
  adopt(diagnostics: WorkflowStepDiagnostics): void;
}
export interface WorkflowRecorder {
  steps: WorkflowStepRun[];
  run<T>(id: string, fn: (capture: WorkflowDiagnosticCapture) => Promise<T>, assess?: (result: T) => StepVerdict, input?: unknown): Promise<T>;
}

/** Diagnostics are best-effort evidence and never change the operation verdict. */
export function createWorkflowRecorder({ now = Date.now, changed = () => {}, failed = () => {}, secrets = [] }: {
  now?: () => number;
  changed?: (steps: WorkflowStepRun[]) => void;
  failed?: (id: string, error: unknown) => void;
  secrets?: readonly string[];
} = {}): WorkflowRecorder {
  const steps: WorkflowStepRun[] = [];
  return {
    steps,
    async run<T>(id: string, fn: (capture: WorkflowDiagnosticCapture) => Promise<T>, assess: (result: T) => StepVerdict = stepResult, input?: unknown) {
      const step: WorkflowStepRun = { id, attempt: steps.filter((s) => s.id === id).length + 1, startedAt: new Date(now()).toISOString(), state: 'running' };
      const diagnostics: WorkflowStepDiagnostics = {};
      const put = (key: keyof WorkflowStepDiagnostics, value: unknown) => {
        try { diagnostics[key] = captureWorkflowDiagnostic(value, { secrets }); step.diagnostics = diagnostics; } catch { /* capture cannot affect work */ }
      };
      const capture: WorkflowDiagnosticCapture = { input: value => put('input', value), output: value => put('output', value), error: value => put('error', value),
        adopt(value) {
          try {
            if (!isWorkflowStepDiagnostics(value)) return;
            for (const key of ['input', 'output', 'error'] as const) {
              const original = value[key]; if (!original) continue;
              const safe = captureWorkflowDiagnostic(original.text, { secrets, maxBytes: 65_536 });
              diagnostics[key] = { ...safe, truncated: safe.truncated || original.truncated, redacted: safe.redacted || original.redacted };
            }
            step.diagnostics = diagnostics;
          } catch { /* capture cannot affect work */ }
        },
      };
      if (input !== undefined) capture.input(input);
      steps.push(step);
      changed(steps);
      try {
        const result = await fn(capture);
        if (!diagnostics.output) capture.output(result);
        Object.assign(step, assess(result), { finishedAt: new Date(now()).toISOString() });
        // Evidence is best-effort and cannot turn a completed operation into a
        // failed operation, even if an unexpected result cannot be projected.
        try { const output = captureWorkflowOutput(result); if (output) step.output = output; } catch { /* no output captured */ }
        return result;
      } catch (error) {
        if (!diagnostics.error) capture.error(error);
        Object.assign(step, { state: 'failed', summary: 'This step failed. Open Output for the recorded error.', finishedAt: new Date(now()).toISOString() });
        try { failed(id, error); } catch { /* a listener cannot change the verdict */ }
        throw error;
      } finally { changed(steps); }
    },
  };
}
