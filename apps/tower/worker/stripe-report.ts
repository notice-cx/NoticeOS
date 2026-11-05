import type { WorkspaceStore } from '@noticeos/postgres';
import { compareStripe, stripeSnapshotSchema, stripeSummarySchema, summarizeStripe, type StripeSubscriptionReport } from '@noticeos/contract/stripe-report';

/** The current mapping selects the account; old account history cannot become
 * a growth baseline. Only four reports load private customer references. */
export async function loadStripeReport(store: WorkspaceStore, asset: string, account: string | undefined, now: Date): Promise<StripeSubscriptionReport | null> {
  if (!account) return null;
  const { summaries, rows } = await store.read(async (tx) => ({
    summaries: await tx.query<{ summary: unknown }>(
      `SELECT DISTINCT ON ((observed_at AT TIME ZONE 'UTC')::date) snapshot->'summary' AS summary
         FROM noticeos.stripe_subscription_snapshots
        WHERE asset_id = $1 AND account_ref = $2 AND observed_at <= $3::timestamptz
          AND observed_at >= $3::timestamptz - interval '120 days'
        ORDER BY (observed_at AT TIME ZONE 'UTC')::date DESC, observed_at DESC, snapshot_id DESC`,
      [asset, account, now.toISOString()]),
    rows: await tx.query<{ at: string; snapshot: unknown }>(
      `WITH latest AS (
         SELECT observed_at FROM noticeos.stripe_subscription_snapshots
          WHERE asset_id = $1 AND account_ref = $2 AND observed_at <= $3::timestamptz
            AND observed_at >= $3::timestamptz - interval '120 days'
          ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1
       )
       SELECT DISTINCT s.observed_at::text AS at, s.snapshot
         FROM latest l CROSS JOIN unnest(ARRAY[0, 7, 28, 90]) AS b(days)
         CROSS JOIN LATERAL (
           SELECT observed_at, snapshot FROM noticeos.stripe_subscription_snapshots
            WHERE asset_id = $1 AND account_ref = $2
              AND observed_at <= l.observed_at - b.days * interval '1 day'
              AND observed_at >= l.observed_at - (b.days + 1) * interval '1 day'
            ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1
         ) s ORDER BY at`, [asset, account, now.toISOString()]),
  }));
  const snapshots = rows.map((row) => ({ at: new Date(row.at).toISOString(), snapshot: stripeSnapshotSchema.parse(typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot) }));
  const latest = snapshots.at(-1);
  if (!latest) return { latest: null, history: [], comparisons: [] };
  const history = summaries.filter((row) => row.summary != null).map((row) => stripeSummarySchema.parse(typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary)).reverse();
  return {
    latest: summarizeStripe(latest.snapshot, latest.at),
    history: history.length ? history : snapshots.map((row) => summarizeStripe(row.snapshot, row.at)),
    comparisons: [7, 28, 90].map((days) => {
      const baseline = Date.parse(latest.at) - days * 86_400_000;
      const before = snapshots.filter((row) => Date.parse(row.at) <= baseline && Date.parse(row.at) >= baseline - 86_400_000).at(-1);
      return { days, growth: before ? compareStripe(before.snapshot, latest.snapshot, before.at, latest.at) : null };
    }),
  };
}
