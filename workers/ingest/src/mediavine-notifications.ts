import { DISCORD_MEDIAVINE_REVENUE_KEY } from '@noticeos/contract/configuration';
import { DAILY_MEDIAVINE_REVENUE } from '@noticeos/contract';
import { MEDIAVINE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import type { Transaction } from '@noticeos/postgres';
import type { Report } from '@noticeos/mediavine';

export const MEDIAVINE_NOTIFICATIONS_ENABLED = `EXISTS (
  SELECT 1 FROM noticeos.config_documents
  WHERE document_key = 'constants' AND (body -> '${DISCORD_MEDIAVINE_REVENUE_KEY}')::jsonb = 'true'::jsonb
)`;

/** Snapshot the first amount and its comparison after every day of the run has been written. */
export async function enqueueMediavineNotifications(tx: Transaction, asset: string, runId: string, report: Report): Promise<void> {
  await tx.execute(`INSERT INTO noticeos.notification_events
      (workspace_id, notification_type, source_kind, source_ref, occurrence, occurred_at, next_attempt_at, payload)
    SELECT r.workspace_id, $8, 'asset', r.asset_id, to_char(r.revenue_date, 'YYYY-MM-DD'),
      r.recorded_at, r.recorded_at, jsonb_build_object(
        'amount_minor', r.amount_minor, 'previous_minor', comparison.previous_amount,
        'month_minor', comparison.month_amount, 'month_reported_days', comparison.month_days)
    FROM noticeos.revenue_observations r
    CROSS JOIN LATERAL (
      SELECT SUM(daily.amount_minor) FILTER (WHERE daily.revenue_date = r.revenue_date - 7) AS previous_amount,
        SUM(daily.amount_minor) FILTER (WHERE daily.revenue_date >= date_trunc('month', r.revenue_date::timestamp)::date) AS month_amount,
        count(*) FILTER (WHERE daily.revenue_date >= date_trunc('month', r.revenue_date::timestamp)::date)::int AS month_days
      FROM noticeos.current_revenue daily
      WHERE daily.workspace_id = r.workspace_id AND daily.asset_id = r.asset_id AND daily.source = r.source
        AND daily.account_ref = r.account_ref AND daily.item_ref IS NULL
        AND daily.revenue_date BETWEEN least(r.revenue_date - 7, date_trunc('month', r.revenue_date::timestamp)::date) AND r.revenue_date
    ) comparison
    WHERE r.workspace_id = $1::uuid AND r.asset_id = $2 AND r.source = $3 AND r.account_ref = $4
      AND r.revenue_date BETWEEN $5::date AND $6::date AND r.run_ref = $7 AND r.item_ref IS NULL
      AND ${MEDIAVINE_NOTIFICATIONS_ENABLED}
      AND NOT EXISTS (
        SELECT 1 FROM noticeos.revenue_observations earlier
        WHERE earlier.workspace_id = r.workspace_id AND earlier.asset_id = r.asset_id
          AND earlier.source = r.source AND earlier.revenue_date = r.revenue_date AND earlier.item_ref IS NULL
          AND earlier.observation_number < r.observation_number
      )
    ORDER BY r.revenue_date
    ON CONFLICT DO NOTHING`,
    [tx.workspaceId, asset, MEDIAVINE_REVENUE_SOURCE, report.site.id, report.period.start, report.period.end, runId, DAILY_MEDIAVINE_REVENUE]);
}

export interface MediavineRevenueNotification {
  asset: string;
  date: string;
  collectedAt: string;
  amountMinor: bigint;
  previousMinor: bigint | null;
  monthMinor: bigint;
  projectedMinor: bigint | null;
}

/** A pace estimate requires revenue for every elapsed reporting day. */
export function projectMediavineMonth(date: string, total: bigint, reportedDays: number): bigint | null {
  const [year, month, day] = date.split('-').map(Number);
  if (reportedDays !== day) return null;
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const divisor = BigInt(reportedDays);
  const scaled = total * BigInt(daysInMonth);
  return (scaled + (scaled < 0n ? -1n : 1n) * (divisor / 2n)) / divisor;
}
