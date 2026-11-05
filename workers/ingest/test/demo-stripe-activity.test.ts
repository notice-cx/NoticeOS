import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { createDemoActivity } from '../../../scripts/demo-activity.mjs';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';
import { writeDemoActivity } from '../src/demo-activity';
import { pgRows, reset } from './helpers';

beforeEach(reset);

it('fills both subscription snapshots after a pre-01:00 seed and keeps retries idempotent', async () => {
  const scenario = generateDemoScenario({ seed: 'stripe-catchup', cutoff: '2026-09-15T00:30:00.000Z', release: '1'.repeat(40) });
  const generated = createDemoActivity(scenario).day(scenario.manifest.referenceDate);
  expect(generated.subscriptions.map(row => row.date)).toEqual(['2026-09-14', '2026-09-15']);
  const day = { ...generated, assets: [], money: [], tasks: [], changes: [], reports: [], codebase: [],
    subscriptions: generated.subscriptions.map(row => ({ ...row, asset: 'meadow.example', account: 'acct_synthetic' })) };
  const saved = () => pgRows<{ day: string }>(`SELECT (observed_at AT TIME ZONE 'UTC')::date::text AS day
    FROM noticeos.stripe_subscription_snapshots ORDER BY observed_at`);
  await writeDemoActivity(env.STORE, day);
  expect(await saved()).toEqual([{ day: '2026-09-15' }, { day: '2026-09-16' }]);
  await writeDemoActivity(env.STORE, day);
  expect(await saved()).toEqual([{ day: '2026-09-15' }, { day: '2026-09-16' }]);
});
