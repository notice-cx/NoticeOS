import { assetDisplayName } from '@noticeos/contract/asset-name';
import type { WorkspaceStore } from '@noticeos/postgres';
import { MEDIAVINE_REPORTING_CLOCK, yesterdayRevenue, type DailyRevenueHistory, type PortfolioDailyRevenue } from '../shared/daily-revenue';
import { shiftRevenueDate } from '../shared/revenue-projection';
import type { RevenueDay } from '../shared/revenue-projection';
import { cents } from './ledger-history';

/** One site's daily revenue from `from` to `to`, on the call's store (bead
 * ro-ujb9.76.5.5): the newest figure Mediavine gave for each day. */
export async function loadDailyRevenue(
  store: WorkspaceStore, asset: string, from: string, to: string,
): Promise<DailyRevenueHistory> {
  const { daily, latest } = await store.read(async (tx) => ({
    daily: await tx.query<{ date: string; amountMinor: bigint }>(
      `SELECT report_date AS date, amount_minor AS "amountMinor"
         FROM noticeos.mediavine_current_daily WHERE asset_id = $1 AND report_date BETWEEN $2::date AND $3::date
        ORDER BY report_date`, [asset, from, to]),
    latest: (await tx.query<{ date: string | null }>(
      `SELECT MAX(report_date) AS date FROM noticeos.mediavine_current_daily
        WHERE asset_id = $1 AND report_date <= $2::date`, [asset, to]))[0],
  }));
  const days: RevenueDay[] = daily.map((day) => ({ date: day.date, amountMinor: cents(day.amountMinor) }));
  return { from, to, days, reportedThrough: latest?.date ?? null };
}

/** A reported subtotal, with explicit coverage against mapped/reporting sources.
 * The window ends at the last completed Mediavine reporting day (D42).
 *
 * A source owes a day only from its FIRST report onward (bead `ro-rd6r`):
 * `mediavine_sites` carries no mapping date, so the earliest current report is
 * the day the site started reporting. Counting the days before it as missing
 * called a site that joined in August "0/30" for June and buried a real
 * three-day outage among days nobody could have reported. A site that has
 * never reported owes nothing yet; its lane's own health says so. */
export async function loadPortfolioDailyRevenue(store: WorkspaceStore, period: string, now: Date): Promise<PortfolioDailyRevenue> {
  const from = `${period}-01`;
  const nextMonth = new Date(`${from}T12:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = shiftRevenueDate(nextMonth.toISOString().slice(0, 10), -1);
  const yesterday = yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, []).date;
  const to = monthEnd < yesterday ? monthEnd : yesterday;
  // Text is ordered byte for byte, as D1 ordered it.
  const { rows, sourceRows } = await store.read(async (tx) => ({
    rows: await tx.query<{ asset: string; date: string; amountMinor: bigint }>(
      `SELECT asset_id AS asset, report_date AS date, amount_minor AS "amountMinor"
         FROM noticeos.mediavine_current_daily WHERE report_date BETWEEN $1::date AND $2::date
        ORDER BY report_date, asset_id COLLATE "C"`, [from, to]),
    sourceRows: await tx.query<{ asset: string; displayName: string; isOs: boolean; since: string }>(
      `SELECT a.asset_id AS asset, a.display_name AS "displayName", a.is_os AS "isOs", f.since AS since
         FROM noticeos.assets a
         JOIN (SELECT asset_id, MIN(report_date) AS since FROM noticeos.mediavine_current_daily GROUP BY asset_id) f
           ON f.asset_id = a.asset_id
        WHERE f.since <= $1::date
          AND (EXISTS (SELECT 1 FROM noticeos.mediavine_sites s WHERE s.workspace_id = a.workspace_id AND s.asset_id = a.asset_id)
            OR EXISTS (SELECT 1 FROM noticeos.mediavine_current_daily d
                        WHERE d.asset_id = a.asset_id AND d.report_date BETWEEN $2::date AND $1::date))
        ORDER BY a.display_name COLLATE "C", a.asset_id COLLATE "C"`, [to, from]),
  }));
  const sources = sourceRows.map(({ asset, displayName, isOs, since }) => ({ asset, displayName: assetDisplayName(isOs, displayName), since }));
  const byDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const assets = byDate.get(row.date) ?? new Map<string, number>();
    assets.set(row.asset, cents(row.amountMinor));
    byDate.set(row.date, assets);
  }
  const days: RevenueDay[] = [];
  const coverage: PortfolioDailyRevenue['coverage'] = [];
  for (let date = from; date <= to; date = shiftRevenueDate(date, 1)) {
    const reported = byDate.get(date);
    if (reported?.size) days.push({ date, amountMinor: [...reported.values()].reduce((sum, value) => sum + value, 0) });
    const missingAssets = sources
      .filter(source => source.since <= date && !reported?.has(source.asset))
      .map(source => source.asset);
    coverage.push({ date, reported: reported?.size ?? 0, missingAssets });
  }
  return { from, to, days, sources, coverage, reportedThrough: days.at(-1)?.date ?? null };
}
