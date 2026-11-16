import { STRIPE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import { assetDisplayName } from '@noticeos/contract/asset-name';
import type { WorkspaceStore } from '@noticeos/postgres';
import {
  commonRevenueClock, operatorRevenueClock, revenueCalendarDate,
  type PortfolioDailyRevenue, type RevenueClock, type RevenueSource, type RevenueSourceHistory, type SiteRevenueHistory,
} from '../shared/daily-revenue';
import { revenueExpectedThrough, shiftRevenueDate } from '../shared/revenue-projection';
import type { RevenueDay } from '../shared/revenue-projection';
import { calendarDayStart } from '../shared/reporting-calendar';
import type { AssetCard } from '../shared/wall';
import { cents } from './ledger-history';
import { loadStripeCalendar, stripeCalendarKey } from './stripe-calendar';

// Daily revenue from the revenue ledger (`noticeos.current_revenue`). Stripe
// receipts have timestamps and follow the operator's selected day.

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
async function readSourcePairs(store: WorkspaceStore, assets: readonly string[] | null, timeZone: string): Promise<SourcePair[]> {
  return store.read((tx) => tx.query<SourcePair>(
    `SELECT asset_id AS asset, source, currency,
            MIN(CASE WHEN source = $1 THEN COALESCE(
                  (COALESCE(to_jsonb(r)->>'occurred_at', to_jsonb(r)->>'covered_from')::timestamptz AT TIME ZONE $2)::date,
                  revenue_date) ELSE revenue_date END)::text AS since
       FROM noticeos.current_revenue r ${assets === null ? '' : 'WHERE asset_id = ANY($3::text[])'}
      GROUP BY asset_id, source, currency
      ORDER BY asset_id COLLATE "C", source COLLATE "C", currency`,
    assets === null ? [STRIPE_REVENUE_SOURCE, timeZone] : [STRIPE_REVENUE_SOURCE, timeZone, [...assets]]));
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
        if (day.date < window.from || day.date > window.to) continue;
        totals.set(day.date, (totals.get(day.date) ?? 0) + day.amountMinor);
        if (!source.partialDates?.includes(day.date)) reporters.set(day.date, (reporters.get(day.date) ?? 0) + 1);
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
    partialDates: dates.filter((date) => (reporters.get(date) ?? 0) < owed(date)),
  };
}

export interface RevenueHistoryOptions {
  now: Date;
  /** How many days the window holds, ending yesterday on the site's clock. */
  days: number;
  /** The operator's clock for Stripe receipts and empty histories. */
  fallback: RevenueClock;
  /** The sites to read; absent reads every site with a source. */
  assets?: readonly string[];
  /** Also read dates through yesterday on each source's own clock. */
  includeSourceDays?: boolean;
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
  const [catalog, pairs] = await Promise.all([loadRevenueSources(store), readSourcePairs(store, assets, fallback.timeZone)]);
  const sourceClock = (source: string) => source === STRIPE_REVENUE_SOURCE ? fallback : catalog.get(source)!.clock;
  const bySite = new Map<string, SourcePair[]>();
  for (const pair of pairs) bySite.set(pair.asset, [...(bySite.get(pair.asset) ?? []), pair]);
  const plans = [...bySite].map(([asset, sitePairs]) => {
    const clock = sitePairs.some(({ source }) => source === STRIPE_REVENUE_SOURCE) ? fallback
      : commonRevenueClock(sitePairs.map((pair) => sourceClock(pair.source)), now) ?? fallback;
    const window = windowOn(clock, now, days);
    const sourceThrough = options.includeSourceDays
      ? sitePairs.reduce((latest, pair) => {
          const yesterday = windowOn(sourceClock(pair.source), now, 1).to;
          return yesterday > latest ? yesterday : latest;
        }, window.to)
      : window.to;
    return { asset, pairs: sitePairs, clock, window, sourceThrough };
  });
  if (plans.length === 0) return new Map();
  const assetIds = plans.map((plan) => plan.asset);
  const fromDates = plans.map((plan) => plan.window.from);
  const stripeWindow = windowOn(fallback, now, days);
  const stripeAssets = [...new Set(pairs.filter(pair => pair.source === STRIPE_REVENUE_SOURCE).map(pair => pair.asset))];
  const [stripe, { dayRows, throughRows }] = await Promise.all([
    loadStripeCalendar(store, fallback.timeZone, stripeWindow.from, stripeWindow.to, stripeAssets),
    store.read(async (tx) => ({
      dayRows: await tx.query<{ asset: string; source: string; currency: string; date: string; amountMinor: bigint; salesMinor: bigint | null; refundsMinor: bigint | null; feesMinor: bigint | null; payments: number | null; refunds: number | null }>(
        `SELECT r.asset_id AS asset, r.source, r.currency, r.revenue_date::text AS date, SUM(r.amount_minor)::bigint AS "amountMinor",
                CASE WHEN bool_and(r.sales_minor IS NOT NULL) THEN SUM(r.sales_minor)::bigint END AS "salesMinor",
                CASE WHEN bool_and(r.sales_minor IS NOT NULL) THEN SUM(r.refunds_minor)::bigint END AS "refundsMinor",
                CASE WHEN bool_and(r.sales_minor IS NOT NULL) THEN SUM(r.fees_minor)::bigint END AS "feesMinor",
                CASE WHEN bool_and(r.sales_minor IS NOT NULL) THEN SUM(r.payment_count)::int END AS payments,
                CASE WHEN bool_and(r.sales_minor IS NOT NULL) THEN SUM(r.refund_count)::int END AS refunds
           FROM noticeos.current_revenue r
           JOIN unnest($1::text[], $2::date[], $3::date[]) AS b(asset_id, from_date, to_date) ON b.asset_id = r.asset_id
           JOIN noticeos_ref.revenue_sources s ON s.source = r.source
          WHERE r.revenue_date BETWEEN b.from_date AND b.to_date AND r.source <> 'stripe'
            AND r.revenue_date < ($4::timestamptz AT TIME ZONE s.time_zone)::date
          GROUP BY r.asset_id, r.source, r.currency, r.revenue_date
          ORDER BY r.revenue_date`, [assetIds, fromDates, plans.map((plan) => plan.sourceThrough), now.toISOString()]),
      throughRows: await tx.query<{ asset: string; source: string; currency: string; through: string }>(
        `SELECT r.asset_id AS asset, r.source, r.currency, MAX(r.revenue_date)::text AS through
           FROM noticeos.current_revenue r
           JOIN unnest($1::text[], $2::date[], $3::date[]) AS b(asset_id, from_date, to_date) ON b.asset_id = r.asset_id
           JOIN noticeos_ref.revenue_sources s ON s.source = r.source
          WHERE r.revenue_date <= b.to_date AND r.source <> 'stripe'
            AND r.revenue_date < ($4::timestamptz AT TIME ZONE s.time_zone)::date
          GROUP BY r.asset_id, r.source, r.currency`, [assetIds, fromDates, plans.map((plan) => plan.window.to), now.toISOString()]),
    })),
  ]);
  const key = (row: { asset: string; source: string; currency: string }) => `${row.asset}\u0000${row.source}\u0000${row.currency}`;
  const daysOf = new Map<string, RevenueSourceHistory['days']>();
  for (const row of dayRows) daysOf.set(key(row), [...(daysOf.get(key(row)) ?? []), { date: row.date, amountMinor: cents(row.amountMinor),
    ...(row.salesMinor === null ? {} : { sales: { salesMinor: cents(row.salesMinor), refundsMinor: cents(row.refundsMinor!),
      feesMinor: cents(row.feesMinor!), payments: Number(row.payments), refunds: Number(row.refunds) } }) }]);
  const throughOf = new Map(throughRows.map((row) => [key(row), row.through]));
  return new Map(plans.map((plan) => [plan.asset, siteHistory(plan.window, plan.clock, plan.pairs.map((pair): RevenueSourceHistory => {
    const source = catalog.get(pair.source)!;
    if (pair.source === STRIPE_REVENUE_SOURCE) {
      const calendar = stripe.get(stripeCalendarKey(pair.asset, pair.currency));
      return { ...source, clock: fallback, currency: pair.currency, since: pair.since, days: calendar?.days ?? [],
        reportedThrough: calendar?.reportedThrough ?? null, partialDates: calendar?.partialDates };
    }
    return { ...source, currency: pair.currency, since: pair.since,
      days: daysOf.get(key(pair)) ?? [], reportedThrough: throughOf.get(key(pair)) ?? null };
  }))]));
}

/** Keep observed Stripe receipts separate from traffic-based forecasts when
 * the asset also has other revenue. Sparse receipts can still contribute to
 * the observed total while the other sources supply the forecast. */
export function revenueForForecast(history: SiteRevenueHistory, now: Date, days: number): SiteRevenueHistory {
  const recurring = history.bySource.filter(source => source.source !== STRIPE_REVENUE_SOURCE);
  if (recurring.length === 0 || recurring.length === history.bySource.length) return history;
  const clock = commonRevenueClock(recurring.map(source => source.clock), now)!;
  return siteHistory(windowOn(clock, now, days), clock, recurring);
}

/** Sum saved portions of yesterday and track missing source days separately.
 * A provider day that spans two display dates is weighted by elapsed time. */
export function wallYesterdayRevenue(history: SiteRevenueHistory, today: string, timeZone: string, now: Date): NonNullable<AssetCard['wallDailyRevenue']> | null {
  const date = shiftRevenueDate(today, -1);
  const start = calendarDayStart(date, timeZone);
  const end = calendarDayStart(today, timeZone);
  let amount = 0;
  let observed = false;
  let due = false;
  let complete = true;
  let estimated = false;
  for (const source of history.bySource) {
    if (source.currency !== 'USD') continue;
    const zone = source.clock.timeZone;
    const first = revenueCalendarDate(new Date(start), zone);
    const last = revenueCalendarDate(new Date(end - 1), zone);
    if (source.since > last) continue;
    due = true;
    const sourceToday = revenueCalendarDate(now, zone);
    const latestComplete = last < sourceToday ? last : shiftRevenueDate(sourceToday, -1);
    // An older boundary slice cannot stand in for this source's missing report.
    if (!source.days.some((reading) => reading.date === latestComplete)) {
      complete = false;
      continue;
    }
    for (let day = first < source.since ? source.since : first; day <= last; day = shiftRevenueDate(day, 1)) {
      const recorded = source.days.find((reading) => reading.date === day)?.amountMinor;
      if (recorded === undefined || day >= sourceToday) {
        complete = false;
        continue;
      }
      const from = calendarDayStart(day, zone);
      const through = calendarDayStart(shiftRevenueDate(day, 1), zone);
      const overlap = Math.min(end, through) - Math.max(start, from);
      observed = true;
      if (source.partialDates?.includes(day)) complete = false;
      amount += recorded * overlap / (through - from);
      estimated ||= overlap !== through - from;
    }
  }
  return due ? { date, timeZone, amountMinor: observed ? Math.round(amount) : null, complete, estimated } : null;
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
 * Stripe keeps local yesterday visible while other sources finish reporting.
 * A site owes a day from each of its sources' first report onward. Sources in
 * different currencies are not added. */
export async function loadPortfolioDailyRevenue(store: WorkspaceStore, period: string, now: Date, operatorTimeZone: string): Promise<PortfolioDailyRevenue> {
  const from = `${period}-01`;
  const nextMonth = new Date(`${from}T12:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = shiftRevenueDate(nextMonth.toISOString().slice(0, 10), -1);
  const [catalog, pairs] = await Promise.all([loadRevenueSources(store), readSourcePairs(store, null, operatorTimeZone)]);
  const operatorClock = operatorRevenueClock(operatorTimeZone);
  const stripeAssets = [...new Set(pairs.filter(pair => pair.source === STRIPE_REVENUE_SOURCE).map(pair => pair.asset))];
  const clocks = new Map(pairs.map(({ source }) => [source, catalog.get(source)!.clock]));
  const clock = stripeAssets.length ? operatorClock : commonRevenueClock([...clocks.values()], now);
  const yesterday = windowOn(clock ?? operatorClock, now, 1).to;
  const to = monthEnd < yesterday ? monthEnd : yesterday;
  const expected = new Map([...clocks].map(([source, clock]) => [source, revenueExpectedThrough(now,
    source === STRIPE_REVENUE_SOURCE ? { ...clock, timeZone: operatorTimeZone } : clock)]));
  const closed = new Map([...clocks].map(([source, clock]) => [source, windowOn(clock, now, 1).to]));
  // Text is ordered byte for byte.
  const [stripe, { rows, names }] = await Promise.all([
    loadStripeCalendar(store, operatorTimeZone, from, to, stripeAssets),
    store.read(async (tx) => ({
      rows: await tx.query<{ asset: string; source: string; date: string; amountMinor: bigint }>(
        `SELECT asset_id AS asset, source, revenue_date::text AS date, SUM(amount_minor)::bigint AS "amountMinor"
           FROM noticeos.current_revenue WHERE revenue_date BETWEEN $1::date AND $2::date AND source <> 'stripe'
          GROUP BY asset_id, source, revenue_date
          ORDER BY revenue_date, asset_id COLLATE "C", source COLLATE "C"`, [from, to]),
      names: await tx.query<{ asset: string; displayName: string; isOs: boolean }>(
        `SELECT asset_id AS asset, display_name AS "displayName", is_os AS "isOs" FROM noticeos.assets`),
    })),
  ]);
  const named = new Map(names.map((row) => [row.asset, assetDisplayName(row.isOs, row.displayName)]));
  const owedBy = new Map<string, SourcePair[]>();
  for (const pair of pairs) {
    if (pair.since <= to) owedBy.set(pair.asset, [...(owedBy.get(pair.asset) ?? []), pair]);
  }
  const sources = [...owedBy].map(([asset, sitePairs]) => ({
    asset, displayName: named.get(asset) ?? asset, since: sitePairs.map((pair) => pair.since).sort()[0]!,
  })).sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  const byDate = new Map<string, Map<string, Set<string>>>();
  const totals = new Map<string, number>();
  const add = (date: string, asset: string, source: string, amountMinor: number, complete: boolean) => {
    totals.set(date, (totals.get(date) ?? 0) + amountMinor);
    if (!complete) return;
    const sites = byDate.get(date) ?? new Map<string, Set<string>>();
    sites.set(asset, (sites.get(asset) ?? new Set()).add(source));
    byDate.set(date, sites);
  };
  for (const row of rows) {
    if (row.date <= closed.get(row.source)!) add(row.date, row.asset, row.source, cents(row.amountMinor), true);
  }
  for (const calendar of stripe.values()) {
    for (const day of calendar.days) add(day.date, calendar.asset, STRIPE_REVENUE_SOURCE, day.amountMinor, !calendar.partialDates.includes(day.date));
  }
  const oneCurrency = new Set(pairs.map((pair) => pair.currency)).size <= 1;
  const days: RevenueDay[] = [];
  const coverage: PortfolioDailyRevenue['coverage'] = [];
  for (let date = from; date <= to; date = shiftRevenueDate(date, 1)) {
    const reported = byDate.get(date);
    if (oneCurrency && totals.has(date)) days.push({ date, amountMinor: totals.get(date)! });
    let complete = 0;
    const missingAssets: string[] = [];
    const pendingAssets: string[] = [];
    for (const site of sources) {
      const owed = owedBy.get(site.asset)!.filter((pair) => pair.since <= date);
      if (owed.length === 0) continue;
      const absent = owed.filter((pair) => !reported?.get(site.asset)?.has(pair.source));
      if (absent.length === 0) complete += 1;
      else if (stripeAssets.length && absent.every((pair) => date > expected.get(pair.source)!)) pendingAssets.push(site.asset);
      else missingAssets.push(site.asset);
    }
    coverage.push({ date, reported: complete, missingAssets, ...(pendingAssets.length ? { pendingAssets } : {}) });
  }
  return { from, to, days, sources, coverage, reportedThrough: days.at(-1)?.date ?? null, ...(clock ? { clock } : {}) };
}
