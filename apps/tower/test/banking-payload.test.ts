// @vitest-environment node
import { expect, it } from 'vitest';
import { createTestStore } from './postgres-store';
import { loadBanking } from '../worker/banking';
import { buildFinancialsPayload } from '../worker/financials-payload';

it('reads only its workspace and current connection edit, without modifying ledger totals', async () => {
  const ctx = await createTestStore();
  expect((await loadBanking(ctx.call)).state).toBe('not-connected');
  await ctx.call.write(tx => tx.query(`INSERT INTO noticeos.integration_connections
    (workspace_id, provider, scope, created_at, updated_at) VALUES ($1, 'mercury', 'shared', '2026-11-01', '2026-11-01')`, [tx.workspaceId]));
  expect((await loadBanking(ctx.call)).state).toBe('awaiting');
  const payload = { currency: 'USD', windowStart: '2026-10-01T12:00:00Z', windowEnd: '2026-11-05T12:00:00Z', accounts: [], transactions: [] };
  await ctx.call.write(tx => tx.query(`INSERT INTO noticeos.mercury_readings
    (workspace_id, connection_id, connection_updated_at, observed_at, payload)
    SELECT workspace_id, connection_id, updated_at, '2026-11-05T12:00:00Z', $1::jsonb
    FROM noticeos.integration_connections WHERE provider = 'mercury'`, [JSON.stringify(payload)]));
  expect(await loadBanking(ctx.call)).toMatchObject({ state: 'recorded', observedAt: '2026-11-05T12:00:00.000Z', snapshot: payload });
  const money = await buildFinancialsPayload(ctx.call, { now: new Date('2026-11-05T12:00:00Z'), osTimeZone: 'UTC', domainOrders: [] });
  expect(money).toMatchObject({ empty: true, months: [], banking: { state: 'recorded' } });
  await ctx.call.write(tx => tx.query(`UPDATE noticeos.integration_connections SET updated_at = '2026-11-06' WHERE provider = 'mercury'`));
  expect((await loadBanking(ctx.call)).state).toBe('awaiting');
  await ctx.call.write(tx => tx.query(`DELETE FROM noticeos.integration_connections WHERE provider = 'mercury'`));
  expect((await loadBanking(ctx.call)).state).toBe('not-connected');
});
