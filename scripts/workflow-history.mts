// The local runner's workflow history: one JSONL line per finished run and an
// active-run heartbeat, both under `.local/`. Node-only.
//
// Authored TypeScript: `pnpm generate` writes the
// `.mjs` the local runner imports and the `.d.mts` the Tower's Vite lanes read.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { WorkflowRun, WorkflowStepRun } from '../packages/contract/src/workflows.js';
import { createWorkflowRecorder, workflowResult, type WorkflowRecorder } from './workflow-trace.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';
import { jobRunName } from './scheduled-jobs.mjs';

export const WORKFLOW_HISTORY_FILE: string = '.local/logs/workflow-runs.jsonl';
export const WORKFLOW_ACTIVE_FILE: string = '.local/workflow-active.json';
export const WORKFLOW_SESSION_ID: string = randomUUID();

export interface WorkflowRunTrace {
  local: boolean; run: WorkflowRecorder['run']; verdict(outcome: string): 'failed' | 'skipped' | 'succeeded'; adopt(steps?: WorkflowStepRun[]): void; finish(outcome: string): Promise<void>;
}
export interface WorkflowHistory {
  publishHeartbeat(): Promise<void>;
  beginRun(job: string, startedAtMs: number): null | WorkflowRunTrace;
}

/**
 * The workflow history of the installation whose state is under `root`: the
 * home folder for the stack's runner (its code folder links `.local` to home),
 * the installation's own folder for `pnpm start`. The Tower
 * reads the same two files under its home (apps/tower/vite/workflow-history.ts).
 */
export function createWorkflowHistory(root: string): WorkflowHistory {
  const active = new Map<string, WorkflowRun>();
  let writes: Promise<void> = Promise.resolve();
  let completed = 0;

  // Telemetry failure cannot change the operation's outcome. Writes are ordered
  // so concurrent workflows cannot overwrite each other's active observations.
  function queueWrite(fn: () => Promise<void>): Promise<void> { writes = writes.then(fn).catch(() => {}); return writes; }
  function publishHeartbeat(): Promise<void> {
    const body = JSON.stringify({ sessionId: WORKFLOW_SESSION_ID, updatedAt: new Date().toISOString(), runs: [...active.values()] });
    return queueWrite(async () => {
      const file = path.join(root, WORKFLOW_ACTIVE_FILE);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, body);
      await fs.rename(`${file}.tmp`, file);
    });
  }

  function beginRun(job: string, startedAtMs: number): null | WorkflowRunTrace {
    const definition = WORKFLOW_DEFINITIONS.find((w) => jobRunName(w) === job);
    if (!definition) return null;
    const run: WorkflowRun = { id: `${definition.id}@${new Date(startedAtMs).toISOString()}`, workflowId: definition.id,
      definitionVersion: definition.version, startedAt: new Date(startedAtMs).toISOString(), state: 'running', steps: [] };
    const recorder = createWorkflowRecorder({ changed: (steps) => { run.steps = steps; void publishHeartbeat(); } });
    active.set(run.id, run);
    void publishHeartbeat();
    return {
      local: Boolean(definition.local),
      run: recorder.run,
      verdict: (outcome: string) => workflowResult(recorder.steps, outcome),
      adopt(steps?: WorkflowStepRun[]) {
        // The private Worker RPC emits bounded, payload-free step observations.
        if (Array.isArray(steps)) recorder.steps.push(...steps);
        run.steps = recorder.steps;
      },
      async finish(outcome: string) {
        run.finishedAt = new Date().toISOString();
        run.steps = recorder.steps;
        run.state = workflowResult(run.steps, outcome);
        active.delete(run.id);
        await queueWrite(async () => {
          const file = path.join(root, WORKFLOW_HISTORY_FILE);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.appendFile(file, `${JSON.stringify(run)}\n`);
          // Verdicts also live in the 30-day job ledger; step retention cannot
          // recolor an execution. Bound the read as well as the retained output.
          if (completed++ % 100 === 0) {
            const lines = await readJsonLines(file);
            if (lines.length > 6000 || (await fs.stat(file)).size > 12 * 1024 * 1024) {
              await fs.writeFile(`${file}.tmp`, `${lines.slice(-6000).map((entry) => JSON.stringify(entry)).join('\n')}\n`);
              await fs.rename(`${file}.tmp`, file);
            }
          }
        });
        await publishHeartbeat();
      },
    };
  }

  return { publishHeartbeat, beginRun };
}

// The stack's runner's history: this code folder's `.local/`.
const checkoutHistory = createWorkflowHistory(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export function publishWorkflowHeartbeat(): Promise<void> { return checkoutHistory.publishHeartbeat(); }
export function beginWorkflowRun(job: string, startedAtMs: number): null | WorkflowRunTrace { return checkoutHistory.beginRun(job, startedAtMs); }

/** Bounded tail read; a torn first/last JSONL line is never an invented run. */
export async function readJsonLines(file: string, maxBytes: number = 12 * 1024 * 1024): Promise<unknown[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const lines = buffer.toString('utf8').split('\n');
    if (size > maxBytes) lines.shift();
    return lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { await handle.close(); }
}
