// Finished synthetic history for the ordinary workflow reader, never a scheduler.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowRun, WorkflowStepOutput, WorkflowStepRun } from '../packages/contract/src/workflows.js';
import { demoScenarioHash, shiftDemoDay, type DemoScenario } from './demo-scenario.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';
import { jobRunName } from './scheduled-jobs.mjs';
import { captureWorkflowOutput } from './workflow-output.mjs';

export interface DemoTaskRunEvidence {
  synthetic: boolean; scenarioHash: string; workspaceId: string; release: string;
  projects: readonly { asset: string }[]; tasks: number; snapshots: number;
}
export interface DemoWatchRunEvidence {
  evaluatedAt: string;
  result: { readings: number; closed: readonly { id: string; outcome: string }[]; failed: readonly unknown[] };
  reading: { outcome: string; checked_at: string; baseline: string; post: string };
}
export interface DemoJobRunInput { job: string; startedAt: string; ms: number; outcome: 'ran' | 'failed'; detail: string; }
export interface DemoJobRecord { job: string; at: string; ms: number; outcome: 'ran' | 'failed'; detail: string; }
const HISTORY_FILES = ['.local/logs/job-runs.jsonl', '.local/logs/workflow-runs.jsonl'] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Values come from the scenario and completed seed receipts, not provider calls. */
export function generateDemoWorkflows({ scenario, watch, tasks }: {
  scenario: DemoScenario; watch: DemoWatchRunEvidence; tasks: DemoTaskRunEvidence;
}) {
  const scenarioHash = demoScenarioHash(scenario);
  const { cutoff, workspaceId, release, stories } = scenario.manifest;
  const projects = scenario.assets.map(asset => asset.id).sort();
  if (!tasks.synthetic || tasks.scenarioHash !== scenarioHash || tasks.workspaceId !== workspaceId || tasks.release !== release ||
      JSON.stringify(tasks.projects.map(project => project.asset).sort()) !== JSON.stringify(projects) ||
      !Number.isSafeInteger(tasks.tasks) || tasks.tasks < 1 || !Number.isSafeInteger(tasks.snapshots) || tasks.snapshots < 1) {
    throw new Error('Workflow history needs the completed matching task seed.');
  }
  if (watch.evaluatedAt !== stories.repair.checkAt || Date.parse(watch.reading.checked_at) !== Date.parse(watch.evaluatedAt) ||
      watch.result.failed.length !== 0 || !Number.isSafeInteger(watch.result.readings) || watch.result.readings < 0 || watch.result.closed.length !== 1 ||
      watch.result.closed[0]?.id !== stories.repair.watchId || watch.result.closed[0]?.outcome !== watch.reading.outcome ||
      watch.reading.outcome !== 'ship_confirmed' || JSON.parse(watch.reading.baseline).days !== 28 || JSON.parse(watch.reading.post).days !== 28) {
    throw new Error('Workflow history needs the actual matching watch reading.');
  }
  const missing = scenario.daily.filter(day => day.reportMissing);
  if (missing.length !== 1) throw new Error('The scenario needs its one missing traffic report.');
  const gap = missing[0]!;
  const resumed = scenario.daily.find(day => day.asset === gap.asset && day.date === shiftDemoDay(gap.date, 1));
  if (!resumed || resumed.reportMissing) throw new Error('The collection recovery needs a later available daily report.');
  const traces: WorkflowRun[] = [];
  const records: DemoJobRecord[] = [];
  const runs: DemoJobRunInput[] = [];
  const output = (facts: unknown): WorkflowStepOutput => {
    const value = captureWorkflowOutput(facts);
    if (!value) throw new Error('The demo workflow needs output supported by the ordinary reader.');
    return value;
  };
  function append(workflowId: string, finishedAt: string, duration: number, action: { id: string; state: 'succeeded' | 'failed'; summary: string; output: WorkflowStepOutput }) {
    const definition = WORKFLOW_DEFINITIONS.find(definition => definition.id === workflowId);
    if (!definition || !definition.stages.some(stage => stage.id === action.id)) throw new Error('The demo workflow stage is not declared by this release.');
    const finish = Date.parse(finishedAt);
    const start = finish - duration;
    if (!Number.isFinite(finish) || finish > Date.parse(cutoff) || start < Date.parse(cutoff) - 30 * 86_400_000) throw new Error('Demo workflow times must remain inside the retained historical window.');
    const startedAt = new Date(start).toISOString();
    const id = `${workflowId}@${startedAt}`;
    const steps: WorkflowStepRun[] = definition.stages.map((stage, index) => ({
      id: stage.id, attempt: 1,
      startedAt: new Date(stage.id === 'record' ? finish : start + Math.floor(duration * index / definition.stages.length)).toISOString(),
      finishedAt: new Date(stage.id === action.id || stage.id === 'record' ? finish : start + Math.floor(duration * (index + 1) / definition.stages.length)).toISOString(),
      state: stage.id === action.id ? action.state : 'succeeded',
      summary: `Synthetic: ${stage.id === action.id ? action.summary : stage.id === 'config' ? 'scenario settings loaded.' : 'execution history recorded.'}`,
      ...(stage.id === action.id ? { output: action.output } : {}),
    }));
    traces.push({ id, workflowId, definitionVersion: definition.version, startedAt, finishedAt: new Date(finish).toISOString(), state: action.state, steps });
    const record = { job: jobRunName(definition), at: startedAt, ms: duration, outcome: action.state === 'failed' ? 'failed' as const : 'ran' as const, detail: `Synthetic scenario ${scenarioHash}` };
    records.push(record);
    runs.push({ job: record.job, startedAt, ms: duration, outcome: record.outcome, detail: record.detail });
    return id;
  }
  const collectionFailure = append('counters', `${shiftDemoDay(gap.date, 1)}T01:10:12.000Z`, 12_000, {
    id: 'google', state: 'failed', summary: 'daily traffic report unavailable.',
    output: output({ written: 0, failed: [{ asset: gap.asset, date: gap.date }] }),
  });
  const collectionRecovery = append('counters', `${shiftDemoDay(resumed.date, 1)}T01:10:08.000Z`, 8_000, {
    id: 'google', state: 'succeeded', summary: 'collection resumed; the earlier report remains missing.',
    output: output({ written: 1, outcomes: [{ asset: resumed.asset, date: resumed.date, ok: true }] }),
  });
  const outcomeCheck = append('watch-windows', watch.evaluatedAt, 600, {
    id: 'outcomes', state: 'succeeded', summary: 'the registered comparison has a final reading.',
    output: output({ readings: 1, closed: watch.result.closed }),
  });
  const taskRefresh = append('beads-snapshot', cutoff, 1_600, {
    id: 'execute', state: 'succeeded', summary: 'task histories recorded.',
    output: output({ found: tasks.tasks, checked: tasks.snapshots, projects: tasks.projects.map(project => ({ asset: project.asset, ok: true })) }),
  });
  return { version: 1 as const, synthetic: true as const, scenarioHash, workspaceId, release, cutoff, records, traces, runs, links: { collectionFailure, collectionRecovery, outcomeCheck, taskRefresh } };
}
export type DemoWorkflowHistory = ReturnType<typeof generateDemoWorkflows>;

/** Caller supplies only the unchanged job-run writer bound to its owned STORE. */
export async function writeDemoWorkflowHistory({ home, history, writeRuns }: {
  home: string; history: DemoWorkflowHistory;
  writeRuns: (input: { runs: DemoJobRunInput[] }, nowMs: number) => Promise<{ ok: boolean; created?: number; duplicate?: number; stale?: number; pruned?: number }>;
}) {
  if (!path.isAbsolute(home) || await fs.realpath(home) !== home || (await fs.lstat(home)).isSymbolicLink()) throw new Error('Workflow history needs a canonical owned demo folder.');
  const receiptFile = path.join(home, 'demo-tasks.json');
  const stat = await fs.lstat(receiptFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Workflow history needs the owned task receipt.');
  const tasks = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as DemoTaskRunEvidence;
  if (!tasks.synthetic || tasks.scenarioHash !== history.scenarioHash || tasks.workspaceId !== history.workspaceId || tasks.release !== history.release) throw new Error('Workflow history belongs to another demo.');
  for (const relative of ['.local', '.local/logs', ...HISTORY_FILES]) {
    const stat = await fs.lstat(path.join(home, relative)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (stat.isSymbolicLink() || (HISTORY_FILES as readonly string[]).includes(relative) || !stat.isDirectory())) throw new Error('Workflow history refuses existing records or redirected paths.');
  }
  await fs.mkdir(path.join(home, '.local/logs'), { recursive: true });
  const documents = [history.records, history.traces].map(rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const files: Record<string, string> = {};
  for (const [index, relative] of HISTORY_FILES.entries()) {
    await fs.writeFile(path.join(home, relative), documents[index]!, { flag: 'wx', mode: 0o600 });
    files[relative] = hash(documents[index]!);
  }
  const mirror = await writeRuns({ runs: history.runs }, Date.parse(history.cutoff));
  if (!mirror.ok || mirror.created !== history.runs.length || mirror.duplicate !== 0 || mirror.stale !== 0 || mirror.pruned !== 0) throw new Error('The demo workflow mirror was not new and complete; preserve its files for review.');
  return { version: 1, synthetic: true, scenarioHash: history.scenarioHash, files, mirror, links: history.links };
}
