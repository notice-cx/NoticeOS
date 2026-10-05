import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { evaluatePulse } from '@noticeos/contract';
import { generateDemoScenario, demoScenarioHash } from '../../../scripts/demo-scenario.mjs';
import { fillDemo } from '../../../scripts/demo-store.mjs';
import { generateDemoWorkflows } from '../../../scripts/demo-workflows.mjs';
import { runWatchWindows } from '../src/watch-windows';
import { writeJobRuns } from '../src/job-runs';
import { asOwner, reset } from './helpers';

const scenario = generateDemoScenario({ seed: 'workflow-store', cutoff: '2026-09-15T12:00:00.000Z', release: '1'.repeat(40) });
beforeEach(async () => {
  await reset();
  await asOwner('DELETE FROM noticeos.assets');
  await env.STORE.write(tx => fillDemo(tx, scenario, { evaluatePulse, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }));
});
it('the released writer mirrors generated runs and the actual final watch reading without changing money', async () => {
  const ledger = () => env.STORE.read(tx => tx.query('SELECT to_jsonb(l)::text AS row FROM noticeos.ledger_entries l ORDER BY entry_id'));
  const moneyBefore = await ledger();
  const bound = new Proxy(env, { get(target, key) { if (key === 'STORE') return target.STORE; throw new Error(`Unexpected demo binding: ${String(key)}`); } });
  const evaluatedAt = scenario.manifest.stories.repair.checkAt;
  const result = await runWatchWindows(bound, Date.parse(evaluatedAt));
  const readings = await env.STORE.read(tx => tx.query<{ outcome: string; checked_at: string; baseline: string; post: string }>(`SELECT w.outcome, r.checked_at::text AS checked_at, r.baseline::text AS baseline, r.post::text AS post
    FROM noticeos.watch_windows w JOIN noticeos.watch_window_readings r USING (workspace_id, window_id) WHERE w.window_id = $1 AND r.final`, [scenario.manifest.stories.repair.watchId]));
  expect(readings).toHaveLength(1);
  const history = generateDemoWorkflows({ scenario, watch: { evaluatedAt, result, reading: readings[0]! }, tasks: {
    synthetic: true, scenarioHash: demoScenarioHash(scenario), workspaceId: scenario.manifest.workspaceId, release: scenario.manifest.release,
    projects: scenario.assets.map(asset => ({ asset: asset.id })), tasks: 38, snapshots: 401,
  } });
  const written = await writeJobRuns(bound, { runs: history.runs }, Date.parse(history.cutoff));
  expect(written).toMatchObject({ ok: true, created: 4, duplicate: 0, stale: 0, pruned: 0 });
  const stored = await env.STORE.read(tx => tx.query<{ job: string; started_at: string; finished_at: string; outcome: string; detail: string }>('SELECT job, started_at::text AS started_at, finished_at::text AS finished_at, outcome, detail FROM noticeos.job_runs ORDER BY started_at'));
  expect(stored).toHaveLength(4);
  for (const run of history.runs) {
    const row = stored.find(row => row.job === run.job && Date.parse(row.started_at) === Date.parse(run.startedAt));
    expect(row).toBeDefined();
    expect(row?.outcome).toBe(run.outcome);
    expect(Date.parse(row!.finished_at) - Date.parse(row!.started_at)).toBe(run.ms);
    expect(row?.detail).toContain('Synthetic scenario');
  }
  expect(await ledger()).toEqual(moneyBefore);
  expect(await writeJobRuns(bound, { runs: history.runs }, Date.parse(history.cutoff))).toMatchObject({ ok: true, created: 0, duplicate: 4 });
});
