import { assetDisplayName } from '@noticeos/contract/asset-name';
import type { WorkspaceStore } from '@noticeos/postgres';
import {
  commonRevenueClock, operatorRevenueClock, revenueCalendarDate,
  type PortfolioDailyRevenue, type RevenueClock, type RevenueSource, type RevenueSourceHistory, type SiteRevenueHistory,
} from '../shared/daily-revenue';
import { shiftRevenueDate } from '../shared/revenue-projection';
import type { RevenueDay } from '../shared/revenue-projection';
import { cents } from './ledger-history';

// Daily revenue from the one revenue ledger (`noticeos.current_revenue`), for
// every source alike. Nothing here names a source: each source's provider,
// family, name and clock come from its vocabulary row.

type SourceRow = {
  source: string; provider: string; family: string; displayName: string;
  timeZone: string; timeZoneLabel: string; readyAfterMinute: number;
};

/** Every revenue source the store's vocabulary names, by id. */
export async function loadRevenueSources(store: WorkspaceStore): Promise<Map<string, RevenueSource>> {
  const rows = await store.read((tx) => tx.query<SourceRow>(
    `SELECT source, provider, family, display_name AS "displayName", time_zone AS "timeZone",
            time_zone_label AS "timeZoneLabel", ready_after_minute AS "readyAfterMinute"
       FROM noticeos_ref.revenue_sources ORDER BY source COLLATE "C"`));
  return new Map(rows.map((row) => [row.source, {
    source: row.source, provider: row.provider, family: row.family, displayName: row.displayName,
    clock: { timeZone: row.timeZone, label: row.timeZoneLabel, readyAfterMinute: Number(row.readyAfterMinute) },
  }]));
}

/** One (site, source, currency) the ledger holds, and its first reported day. */
type SourcePair = { asset: string; source: string; currency: string; since: string };

/** Each site's sources: every (site, source, currency) with a current figure,
 * ordered by site, then source. */
async function readSourcePairs(store: WorkspaceStore, assets: readonly string[] | null): Promise<SourcePair[]> {
  return store.read((tx) => tx.query<SourcePair>(
    `SELECT asset_id AS asset, source, currency, MIN(revenue_date)::text AS since
       FROM noticeos.current_revenue ${assets === null ? '' : 'WHERE asset_id = ANY($1::text[])'}
      GROUP BY asset_id, source, currency
      ORDER BY asset_id COLLATE "C", source COLLATE "C", currency`, assets === null ? [] : [[...assets]]));
}

/** The window of `days` ending yesterday on `clock`. */
function windowOn(clock: RevenueClock, now: Date, days: number): { from: string; to: string } {
  const to = shiftRevenueDate(revenueCalendarDate(now, clock.timeZone), -1);
  return { from: shiftRevenueDate(to, -(Math.max(1, Math.floor(days)) - 1)), to };
}

/** A site's sources summed per day. A day is partial when a source the site
 * owes it (one whose first report is on or before it) did not report it. The
 * days of sources in different currencies are not added: `days` is then
 * empty and each source keeps its own. */
function siteHistory(window: { from: string; to: string }, clock: RevenueClock, bySource: RevenueSourceHistory[]): SiteRevenueHistory & { clock: RevenueClock } {
  const currencies = new Set(bySource.map((source) => source.currency));
  const totals = new Map<string, number>();
  const reporters = new Map<string, number>();
  if (currencies.size <= 1) {
    for (const source of bySource) {
      for (const day of source.days) {
        totals.set(day.date, (totals.get(day.date) ?? 0) + day.amountMinor);
        reporters.set(day.date, (reporters.get(day.date) ?? 0) + 1);
      }
    }
  }
  const dates = [...totals.keys()].sort();
  const owed = (date: string) => bySource.filter((source) => source.since <= date).length;
  const reportedThrough = bySource.map((source) => source.reportedThrough).filter((date): date is string => date !== null).sort().at(-1) ?? null;
  return {
    ...window,
    days: dates.map((date): RevenueDay => ({ date, amountMinor: totals.get(date)! })),
    reportedThrough,
    clock,
    bySource,
    partialDates: dates.filter((date) => reporters.get(date)! < owed(date)),
  };
}

export interface RevenueHistoryOptions {
  now: Date;
  /** How many days the window holds, ending yesterday on the site's clock. */
  days: number;
  /** The clock of a site with no source: the operator's. */
  fallback: RevenueClock;
  /** The sites to read; absent reads every site with a source. */
  assets?: readonly string[];
}

/**
 * Each site's daily revenue for `days` ending yesterday on its sources'
 * clock, per source and summed, from the newest figure of each day. Only
 * sites with a source have an entry; `emptyRevenueHistory` stands for the
 * rest. Three reads in one transaction: the sites' sources, their days in
 * each site's window, and each source's newest day at or before it.
 */
export async function loadRevenueHistories(store: WorkspaceStore, options: RevenueHistoryOptions): Promise<Map<string, SiteRevenueHistory & { clock: RevenueClock }>> {
  const { now, days, fallback } = options;
  const assets = options.assets ?? null;
  if (assets !== null && assets.length === 0) return new Map();
  const [catalog, pairs] = await Promise.all([loadRevenueSources(store), readSourcePairs(store, assets)]);
  const bySite = new Map<string, SourcePair[]>();
  for (const pair of pairs) bySite.set(pair.asset, [...(bySite.get(pair.asset) ?? []), pair]);
  const plans = [...bySite].map(([asset, sitePairs]) => {
    const clock = commonRevenueClock(sitePairs.map((pair) => catalog.get(pair.source)!.clock), now) ?? fallback;
    return { asset, pairs: sitePairs, clock, window: windowOn(clock, now, days) };
  });
  if (plans.length === 0) return new Map();
  const bounds = [plans.map((plan) => plan.asset), plans.map((plan) => plan.window.from), plans.map((plan) => plan.window.to)];
  const { dayRows, throughRows } = await store.read(async (tx) => ({
    dayRows: await tx.query<{ asset: string; source: string; currency: string; date: string; amountMinor: bigint }>(
      `SELECT r.asset_id AS asset, r.source, r.currency, r.revenue_date::text AS date, SUM(r.amount_minor)::bigint AS "amountMinor"
         FROM noticeos.current_revenue r
         JOIN unnest($1::text[], $2::date[], $3::date[]) AS b(asset_id, from_date, to_date) ON b.asset_id = r.asset_id
        WHERE r.revenue_date BETWEEN b.from_date AND b.to_date
        GROUP BY r.asset_id, r.source, r.currency, r.revenue_date
        ORDER BY r.revenue_date`, bounds),
    throughRows: await tx.query<{ asset: string; source: string; currency: string; through: string }>(
      `SELECT r.asset_id AS asset, r.source, r.currency, MAX(r.revenue_date)::text AS through
         FROM noticeos.current_revenue r
         JOIN unnest($1::text[], $2::date[], $3::date[]) AS b(asset_id, from_date, to_date) ON b.asset_id = r.asset_id
        WHERE r.revenue_date <= b.to_date
        GROUP BY r.asset_id, r.source, r.currency`, bounds),
  }));
  const key = (row: { asset: string; source: string; currency: string }) => `${row.asset}\u0000${row.source}\u0000${row.currency}`;
  const daysOf = new Map<string, RevenueDay[]>();
  for (const row of dayRows) daysOf.set(key(row), [...(daysOf.get(key(row)) ?? []), { date: row.date, amountMinor: cents(row.amountMinor) }]);
  const throughOf = new Map(throughRows.map((row) => [key(row), row.through]));
  return new Map(plans.map((plan) => [plan.asset, siteHistory(plan.window, plan.clock, plan.pairs.map((pair): RevenueSourceHistory => ({
    ...catalog.get(pair.source)!, currency: pair.currency, since: pair.since,
    days: daysOf.get(key(pair)) ?? [], reportedThrough: throughOf.get(key(pair)) ?? null,
  })))]));
}

/** A site with no revenue source: its empty window on the fallback clock. */
export function emptyRevenueHistory(now: Date, days: number, fallback: RevenueClock): SiteRevenueHistory {
  return { ...windowOn(fallback, now, days), days: [], reportedThrough: null, bySource: [], partialDates: [] };
}

/** One site's daily revenue for `days` ending yesterday on its sources' clock. */
export async function loadDailyRevenue(store: WorkspaceStore, asset: string, options: Omit<RevenueHistoryOptions, 'assets'>): Promise<SiteRevenueHistory> {
  return (await loadRevenueHistories(store, { ...options, assets: [asset] })).get(asset)
    ?? emptyRevenueHistory(options.now, options.days, options.fallback);
}

/** A reported subtotal, with explicit coverage of every site that reports.
 * The window ends at yesterday on the sources' common clock. A site owes a
 * day from each of its sources' first report onward; it reported a day when
 * every source it owed that day did. A site that has never reported owes
 * nothing yet. Sources in different currencies are not added: `days` is then
 * empty and the coverage still stands. */
export async function loadPortfolioDailyRevenue(store: WorkspaceStore, period: string, now: Date, operatorTimeZone: string): Promise<PortfolioDailyRevenue> {
  const from = `${period}-01`;
  const nextMonth = new Date(`${from}T12:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = shiftRevenueDate(nextMonth.toISOString().slice(0, 10), -1);
  const [catalog, pairs] = await Promise.all([loadRevenueSources(store), readSourcePairs(store, null)]);
  const clock = commonRevenueClock([...new Set(pairs.map((pair) => pair.source))].map((source) => catalog.get(source)!.clock), now);
  const yesterday = shiftRevenueDate(revenueCalendarDate(now, (clock ?? operatorRevenueClock(operatorTimeZone)).timeZone), -1);
  const to = monthEnd < yesterday ? monthEnd : yesterday;
  // Text is ordered byte for byte.
  const { rows, names } = await store.read(async (tx) => ({
    rows: await tx.query<{ asset: string; source: string; date: string; amountMinor: bigint }>(
      `SELECT asset_id AS asset, source, revenue_date::text AS date, SUM(amount_minor)::bigint AS "amountMinor"
         FROM noticeos.current_revenue WHERE revenue_date BETWEEN $1::date AND $2::date
        GROUP BY asset_id, source, revenue_date
        ORDER BY revenue_date, asset_id COLLATE "C", source COLLATE "C"`, [from, to]),
    names: await tx.query<{ asset: string; displayName: string; isOs: boolean }>(
      `SELECT asset_id AS asset, display_name AS "displayName", is_os AS "isOs" FROM noticeos.assets`),
  }));
  const named = new Map(names.map((row) => [row.asset, assetDisplayName(row.isOs, row.displayName)]));
  const owedBy = new Map<string, SourcePair[]>();
  for (const pair of pairs) if (pair.since <= to) owedBy.set(pair.asset, [...(owedBy.get(pair.asset) ?? []), pair]);
  const sources = [...owedBy].map(([asset, sitePairs]) => ({
    asset, displayName: named.get(asset) ?? asset, since: sitePairs.map((pair) => pair.since).sort()[0]!,
  })).sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  const byDate = new Map<string, Map<string, Set<string>>>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const sites = byDate.get(row.date) ?? new Map<string, Set<string>>();
    sites.set(row.asset, (sites.get(row.asset) ?? new Set()).add(row.source));
    byDate.set(row.date, sites);
    totals.set(row.date, (totals.get(row.date) ?? 0) + cents(row.amountMinor));
  }
  const oneCurrency = new Set(pairs.map((pair) => pair.currency)).size <= 1;
  const days: RevenueDay[] = [];
  const coverage: PortfolioDailyRevenue['coverage'] = [];
  for (let date = from; date <= to; date = shiftRevenueDate(date, 1)) {
    const reported = byDate.get(date);
    if (oneCurrency && reported?.size) days.push({ date, amountMinor: totals.get(date)! });
    let complete = 0;
    const missingAssets: string[] = [];
    for (const site of sources) {
      const owed = owedBy.get(site.asset)!.filter((pair) => pair.since <= date);
      if (owed.length === 0) continue;
      if (owed.every((pair) => reported?.get(site.asset)?.has(pair.source))) complete += 1;
      else missingAssets.push(site.asset);
    }
    coverage.push({ date, reported: complete, missingAssets });
  }
  return { from, to, days, sources, coverage, reportedThrough: days.at(-1)?.date ?? null, ...(clock ? { clock } : {}) };
}
