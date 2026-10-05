import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { evaluatePulse } from '@noticeos/contract';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';
import { fillDemo } from '../../../scripts/demo-store.mjs';
import { runWatchWindows } from '../src/watch-windows';
import { asOwner, reset } from './helpers';

const scenario = generateDemoScenario({ seed: 'portfolio-v1', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) });
beforeEach(async () => {
  await reset();
  // The suite's invented sites are replaced only in this file's disposable
  // copy. The next file starts from its normal clean template again.
  await asOwner('DELETE FROM noticeos.assets');
  await env.STORE.write(tx => fillDemo(tx, scenario, { evaluatePulse, developmentProfile: { setting: 'noticeos.profile', value: 'development' } }));
});

it('the unchanged sweep derives the repair outcome from its registration and real observations', async () => {
  const ledger = () => env.STORE.read(tx => tx.query('SELECT entry_id::text, amount_minor::text, kind, booking_state, supersedes_id::text FROM noticeos.ledger_entries ORDER BY entry_id'));
  const moneyBefore = await ledger();
  const bound = new Proxy(env, { get(target, key) { if (key === 'STORE') return target.STORE; throw new Error(`Unexpected demo binding: ${String(key)}`); } });
  const result = await runWatchWindows(bound, Date.parse(scenario.manifest.cutoff));
  expect(result.failed).toEqual([]);
  expect(result.closed).toMatchObject([{ id: scenario.manifest.stories.repair.watchId, asset: 'lightbrief.example', outcome: 'ship_confirmed' }]);
  const rows = await env.STORE.read(tx => tx.query<{ status: string; outcome: string; baseline: string; post: string; checked: string }>(`SELECT w.status, w.outcome, r.baseline, r.post, r.checked_at AS checked
    FROM noticeos.watch_windows w JOIN noticeos.watch_window_readings r USING (workspace_id, window_id) WHERE w.window_id = $1`, [scenario.manifest.stories.repair.watchId]));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('closed');
  expect(JSON.parse(rows[0]!.baseline).days).toBe(28);
  expect(JSON.parse(rows[0]!.post).days).toBe(28);
  expect(Date.parse(rows[0]!.checked)).toBe(Date.parse(scenario.manifest.cutoff));
  expect(await ledger()).toEqual(moneyBefore);
  const problem = await env.STORE.read(tx => tx.query<{ resolved: string | null }>('SELECT resolved_at AS resolved FROM noticeos.flags WHERE asset_id = $1', [scenario.manifest.stories.problem.asset]));
  expect(problem).toHaveLength(1);
  expect(problem[0]!.resolved).toBeNull();
  const repeated = await runWatchWindows(bound, Date.parse(scenario.manifest.cutoff));
  expect(repeated.closed).toEqual([]);
  expect(repeated.readings).toBe(0);
  expect(await ledger()).toEqual(moneyBefore);
});
