// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadStripeReport } from '../worker/stripe-report';
import { loadDailyRevenue } from '../worker/daily-revenue';
import { createTestStore } from './postgres-store';
import { addSites } from './sites';
import { operatorRevenueClock } from '../shared/daily-revenue';
import { stripeSnapshotRecord, type StripeSnapshot } from '@noticeos/contract/stripe-report';

const snapshot = (value: number): StripeSnapshot => ({ version: 1, currency: 'USD', activeSubscriptions: 1, trials: 2,
  pastDue: 0, canceling: 0, unmeasuredSubscriptions: 0, customers: [{ ref: 'cus_private', mrrMinor: value }] });

describe('Stripe report reads', () => {
  it('uses only the mapped account and past observations, and strips customer references', async () => {
    const ctx = await createTestStore();
    try {
      await addSites(ctx, [{ id: 'example.com', domain: null, displayName: 'Product', status: 'live', senseOnly: 0, createdAt: '2026-01-01T00:00:00Z' }]);
      for (const [account, at, amount] of [
        ['acct_old', '2026-09-29T12:00:00Z', 999999],
        ['acct_current', '2026-09-01T12:00:00Z', 1000],
        ['acct_current', '2026-09-29T12:00:00Z', 2000],
        ['acct_current', '2026-09-30T12:00:00Z', 5000],
      ] as const) await ctx.call.write(tx => tx.execute(`INSERT INTO noticeos.stripe_subscription_snapshots
        (workspace_id, asset_id, account_ref, observed_at, snapshot) VALUES ($1::uuid, 'example.com', $2, $3::timestamptz, $4::jsonb)`,
      [tx.workspaceId, account, at, JSON.stringify(stripeSnapshotRecord(snapshot(amount), at))]));
      const report = await loadStripeReport(ctx.call, 'example.com', 'acct_current', new Date('2026-09-29T15:00:00Z'));
      expect(report!.latest).toMatchObject({ mrrMinor: 2000, trials: 2, paidCustomers: 1 });
      expect(report!.history).toHaveLength(2);
      expect(report!.comparisons.find(row => row.days === 28)!.growth).toMatchObject({ netMrrMinor: 1000, expansionMinor: 1000, lostCustomers: 0 });
      expect(report!.comparisons.find(row => row.days === 7)!.growth).toBeNull();
      expect(JSON.stringify(report)).not.toContain('cus_private');
      expect(await loadStripeReport(ctx.call, 'example.com', undefined, new Date())).toBeNull();
      expect(await loadStripeReport(ctx.call, 'example.com', 'acct_empty', new Date())).toEqual({ latest: null, history: [], comparisons: [] });
    } finally { await ctx.close(); }
  });

  it('reads a sale composition without treating older net-only observations as zero sales', async () => {
    const ctx = await createTestStore();
    try {
      await addSites(ctx, [{ id: 'example.com', domain: null, displayName: 'Product', status: 'live', senseOnly: 0, createdAt: '2026-01-01T00:00:00Z' }]);
      await ctx.call.write(async tx => {
        await tx.execute(`INSERT INTO noticeos.revenue_observations
          (workspace_id, asset_id, source, account_ref, revenue_date, amount_minor, currency, run_ref, recorded_at)
          VALUES ($1::uuid, 'example.com', 'stripe', 'acct_current', '2026-09-01', 970, 'USD', 'old', '2026-09-02')`, [tx.workspaceId]);
        await tx.execute(`INSERT INTO noticeos.revenue_observations
          (workspace_id, asset_id, source, account_ref, revenue_date, amount_minor, currency, run_ref, recorded_at,
           sales_minor, refunds_minor, fees_minor, payment_count, refund_count)
          VALUES ($1::uuid, 'example.com', 'stripe', 'acct_current', '2026-09-02', 770, 'USD', 'new', '2026-09-03', 1000, 200, 30, 1, 1)`, [tx.workspaceId]);
      });
      const history = await loadDailyRevenue(ctx.call, 'example.com', { now: new Date('2026-09-03T12:00:00Z'), days: 7, fallback: operatorRevenueClock('UTC') });
      expect(history.bySource[0]!.days).toEqual([
        { date: '2026-09-01', amountMinor: 970 },
        { date: '2026-09-02', amountMinor: 770, sales: { salesMinor: 1000, refundsMinor: 200, feesMinor: 30, payments: 1, refunds: 1 } },
      ]);
      await expect(ctx.call.write(tx => tx.execute(`INSERT INTO noticeos.revenue_observations
        (workspace_id, asset_id, source, account_ref, revenue_date, amount_minor, currency, run_ref, recorded_at, sales_minor)
        VALUES ($1::uuid, 'example.com', 'stripe', 'acct_current', '2026-09-03', 0, 'USD', 'bad', '2026-09-04', 10)`, [tx.workspaceId]))).rejects.toThrow();
    } finally { await ctx.close(); }
  });
});
