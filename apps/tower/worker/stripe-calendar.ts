import { STRIPE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import type { WorkspaceStore } from '@noticeos/postgres';
import { calendarDayStart } from '../shared/reporting-calendar';
import { shiftRevenueDate } from '../shared/revenue-projection';
import type { RevenueSourceHistory } from '../shared/daily-revenue';
import { cents } from './ledger-history';

type StripeDay = RevenueSourceHistory['days'][number];
type Coverage = { from: number; until: number };
type Calendar = { asset: string; currency: string; days: StripeDay[]; partialDates: string[]; reportedThrough: string | null };
export const stripeCalendarKey = (asset: string, currency: string) => JSON.stringify([asset, currency]);

function covered(intervals: readonly Coverage[], start: number, end: number): boolean {
  let through = start;
  for (const interval of intervals) {
    if (interval.from > through) break;
    through = Math.max(through, interval.until);
    if (through >= end) return true;
  }
  return false;
}

/** Timestamped amounts follow the selected calendar. A closed day with no
 * transactions is zero only when the saved collection covers that whole day. */
export async function loadStripeCalendar(
  store: WorkspaceStore, timeZone: string, from: string, to: string, assets: readonly string[],
): Promise<Map<string, Calendar>> {
  if (from > to || assets.length === 0) return new Map();
  const start = new Date(calendarDayStart(from, timeZone)).toISOString();
  const end = new Date(calendarDayStart(shiftRevenueDate(to, 1), timeZone)).toISOString();
  const args = [assets, from, to, timeZone, start, end, STRIPE_REVENUE_SOURCE];
  // Mounted source can follow a checkout before its operator applies the schema.
  const rows = await store.read((tx) => tx.query<{
    asset: string; currency: string; date: string | null; amount: bigint | null; sales: bigint | null; refunds: bigint | null;
    fees: bigint | null; payments: number | null; refundCount: number | null; from: bigint | null; until: bigint | null;
  }>(
    `WITH source_rows AS (
         SELECT asset_id, account_ref, currency, revenue_date, amount_minor, sales_minor, refunds_minor, fees_minor,
                payment_count, refund_count, (to_jsonb(r)->>'occurred_at')::timestamptz AS occurred_at,
                (to_jsonb(r)->>'covered_from')::timestamptz AS covered_from,
                (to_jsonb(r)->>'covered_until')::timestamptz AS covered_until
           FROM noticeos.current_revenue r
          WHERE source = $7 AND asset_id = ANY($1::text[]) AND revenue_date BETWEEN $2::date - 1 AND $3::date + 1
       ), dated AS (
         SELECT asset_id, currency, amount_minor, sales_minor, refunds_minor, fees_minor, payment_count, refund_count,
                COALESCE((occurred_at AT TIME ZONE $4)::date, revenue_date) AS day
           FROM source_rows
          WHERE ((occurred_at >= $5::timestamptz AND occurred_at < $6::timestamptz)
              OR (occurred_at IS NULL AND covered_from IS NULL AND revenue_date BETWEEN $2::date AND $3::date
                AND revenue_date::timestamp AT TIME ZONE $4 = revenue_date::timestamp AT TIME ZONE 'UTC'
                AND (revenue_date + 1)::timestamp AT TIME ZONE $4 = (revenue_date + 1)::timestamp AT TIME ZONE 'UTC'))
       ),
     intervals AS (
         SELECT asset_id, currency, covered_from, covered_until FROM source_rows
          WHERE covered_until > $5::timestamptz AND covered_from < $6::timestamptz
         UNION ALL
         SELECT asset_id, currency, revenue_date::timestamp AT TIME ZONE 'UTC', (revenue_date + 1)::timestamp AT TIME ZONE 'UTC'
           FROM source_rows
          WHERE occurred_at IS NULL AND covered_from IS NULL
          GROUP BY asset_id, account_ref, currency, revenue_date
          HAVING (revenue_date::timestamp AT TIME ZONE $4 = revenue_date::timestamp AT TIME ZONE 'UTC'
               AND (revenue_date + 1)::timestamp AT TIME ZONE $4 = (revenue_date + 1)::timestamp AT TIME ZONE 'UTC')
              OR bool_and(amount_minor = 0 AND COALESCE(payment_count = 0 AND refund_count = 0 AND fees_minor = 0, false))
       )
       SELECT asset_id AS asset, currency, day::text AS date, SUM(amount_minor)::bigint AS amount,
              CASE WHEN bool_and(sales_minor IS NOT NULL) THEN SUM(sales_minor)::bigint END AS sales,
              SUM(refunds_minor)::bigint AS refunds, SUM(fees_minor)::bigint AS fees,
              SUM(payment_count)::int AS payments, SUM(refund_count)::int AS "refundCount",
              NULL::bigint AS "from", NULL::bigint AS "until"
         FROM dated GROUP BY asset_id, currency, day
       UNION ALL
       SELECT asset_id, currency, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              (EXTRACT(EPOCH FROM covered_from) * 1000)::bigint,
              (EXTRACT(EPOCH FROM covered_until) * 1000)::bigint
         FROM intervals ORDER BY "from" NULLS FIRST, date`, args));

  type Group = { asset: string; currency: string; amounts: Map<string, StripeDay>; intervals: Coverage[] };
  const groups = new Map<string, Group>();
  const groupOf = (asset: string, currency: string) => {
    const key = stripeCalendarKey(asset, currency);
    const group: Group = groups.get(key) ?? { asset, currency, amounts: new Map(), intervals: [] };
    groups.set(key, group);
    return group;
  };
  for (const row of rows) {
    const group = groupOf(row.asset, row.currency);
    if (row.date === null) {
      group.intervals.push({ from: Number(row.from), until: Number(row.until) });
      continue;
    }
    const amount: StripeDay = { date: row.date, amountMinor: cents(row.amount!) };
    if (row.sales !== null) amount.sales = {
      salesMinor: cents(row.sales), refundsMinor: cents(row.refunds!), feesMinor: cents(row.fees!),
      payments: row.payments!, refunds: row.refundCount!,
    };
    group.amounts.set(row.date, amount);
  }

  const boundaries = new Map<string, number>();
  for (let date = from; date <= shiftRevenueDate(to, 1); date = shiftRevenueDate(date, 1)) {
    boundaries.set(date, calendarDayStart(date, timeZone));
  }
  return new Map([...groups].map(([key, group]) => {
    const days: StripeDay[] = [];
    const partialDates: string[] = [];
    let reportedThrough: string | null = null;
    for (let date = from; date <= to; date = shiftRevenueDate(date, 1)) {
      const amount = group.amounts.get(date);
      const complete = covered(group.intervals, boundaries.get(date)!, boundaries.get(shiftRevenueDate(date, 1))!);
      if (complete) {
        reportedThrough = date;
        days.push(amount ?? { date, amountMinor: 0, sales: { salesMinor: 0, refundsMinor: 0, feesMinor: 0, payments: 0, refunds: 0 } });
      } else if (amount) {
        days.push(amount);
        partialDates.push(date);
      }
    }
    return [key, { asset: group.asset, currency: group.currency, days, partialDates, reportedThrough }];
  }));
}

/** Only receipts that contribute to the accounting view can move between
 * display months. Imported and reconciled amounts retain their ledger period. */
export async function loadStripeMonthShifts(
  store: WorkspaceStore, timeZone: string, periods: readonly string[],
): Promise<{ asset: string; fromPeriod: string; toPeriod: string; amountMinor: number }[]> {
  const boundaryDays = new Set<string>();
  for (const period of periods) {
    const first = `${period}-01`;
    const next = new Date(`${first}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const nextMonth = next.toISOString().slice(0, 10);
    for (const boundary of [first, nextMonth]) {
      boundaryDays.add(shiftRevenueDate(boundary, -1));
      boundaryDays.add(boundary);
    }
  }
  const rows = await store.read((tx) => tx.query<{ asset: string; fromPeriod: string; toPeriod: string; amount: bigint }>(
    `WITH moved AS (
       SELECT r.workspace_id, r.asset_id, r.currency, r.amount_minor,
              date_trunc('month', r.revenue_date)::date AS source_month,
              date_trunc('month', (to_jsonb(r)->>'occurred_at')::timestamptz AT TIME ZONE $2)::date AS display_month
         FROM noticeos.current_revenue r
        WHERE r.source = $3 AND r.currency = 'USD' AND r.revenue_date = ANY($1::date[])
     )
     SELECT asset_id AS asset, to_char(source_month, 'YYYY-MM') AS "fromPeriod",
            to_char(display_month, 'YYYY-MM') AS "toPeriod", SUM(amount_minor)::bigint AS amount
       FROM moved r WHERE source_month <> display_month AND EXISTS (
         SELECT 1 FROM noticeos.financial_ledger l WHERE l.workspace_id = r.workspace_id
           AND l.asset_id = r.asset_id AND l.period_month = r.source_month AND l.currency = r.currency
           AND l.source = $3 AND l.entry_id < 0)
      GROUP BY asset_id, source_month, display_month`, [[...boundaryDays], timeZone, STRIPE_REVENUE_SOURCE]));
  return rows.map(({ amount, ...row }) => ({ ...row, amountMinor: cents(amount) }));
}
