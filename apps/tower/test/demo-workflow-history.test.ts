import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { generateDemoScenario, demoScenarioHash } from '../../../scripts/demo-scenario.mjs';
import { generateDemoWorkflows, writeDemoWorkflowHistory } from '../../../scripts/demo-workflows.mjs';
import { createWorkflowHistoryReader } from '../vite/workflow-history';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))); });

it('the ordinary history reader opens all synthetic run details and lets old records age out', async () => {
  const scenario = generateDemoScenario({ seed: 'workflow-reader', cutoff: '2026-09-15T12:00:00.000Z', release: '1'.repeat(40) });
  const tasks = { synthetic: true, scenarioHash: demoScenarioHash(scenario), workspaceId: scenario.manifest.workspaceId, release: scenario.manifest.release,
    projects: scenario.assets.map(asset => ({ asset: asset.id })), tasks: 38, snapshots: 401 };
  const history = generateDemoWorkflows({ scenario, tasks, watch: {
    evaluatedAt: scenario.manifest.stories.repair.checkAt,
    result: { readings: 0, closed: [{ id: scenario.manifest.stories.repair.watchId, outcome: 'ship_confirmed' }], failed: [] },
    reading: { checked_at: scenario.manifest.stories.repair.checkAt, outcome: 'ship_confirmed', baseline: '{"days":28}', post: '{"days":28}' },
  } });
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-demo-workflow-reader-'))); homes.push(home);
  await fs.writeFile(path.join(home, 'demo-tasks.json'), JSON.stringify(tasks), { flag: 'wx', mode: 0o600 });
  await writeDemoWorkflowHistory({ home, history, writeRuns: async () => ({ ok: true, created: 4, duplicate: 0, stale: 0, pruned: 0 }) });
  const read = createWorkflowHistoryReader(home);
  for (const trace of history.traces) {
    const result = await read(Date.parse(history.cutoff), trace.id);
    expect(result.historyAvailable).toBe(true);
    expect(result.selectedRun).toEqual(trace);
    expect(result.workflows.every(summary => summary.active === null)).toBe(true);
    expect(result.selectedRun?.steps?.every(step => step.summary?.startsWith('Synthetic: '))).toBe(true);
    expect(result.selectedRun?.steps?.some(step => step.output)).toBe(true);
  }
  const current = await read(Date.parse(history.cutoff), history.links.collectionFailure);
  expect(current.selectedRun?.state).toBe('failed');
  expect(current.workflows.find(workflow => workflow.id === 'counters')?.latest?.id).toBe(history.links.collectionRecovery);
  expect(current.workflows.find(workflow => workflow.id === 'notifications')?.latest).toBeNull();
  const aged = await read(Date.parse(history.cutoff) + 31 * 86_400_000, history.links.outcomeCheck);
  expect(aged.selectedRun).toBeNull();
  expect(aged.workflows.every(workflow => workflow.runs.length === 0)).toBe(true);
});
