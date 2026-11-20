import { STRIPE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import type { WorkspaceStore } from '@noticeos/postgres';
import { operatorRevenueClock, revenueCalendarDate, yesterdayRevenue, type SiteRevenueHistory } from '../shared/daily-revenue';
import type { IntegrationsConfig } from '../shared/integrations';
import { projectRevenue, REVENUE_HISTORY_DAYS } from '../shared/revenue-projection';
import type { SignalTrendSet } from '../shared/wall';
import { emptyRevenueHistory, loadRevenueHistories, revenueForForecast, wallYesterdayRevenue } from './daily-revenue';
import { revenueHolidays } from './revenue-holidays';
import { emptySignalTrendSet, loadSignalTrends } from './signal-trends';
import type { loadWallLedger } from './wall-ledger';

type Ledger = Awaited<ReturnType<typeof loadWallLedger>>;

export async function loadWallAssetRevenue(
  store: WorkspaceStore,
  ledger: Ledger,
  assets: readonly string[],
  { now, osTimeZone, integrations }: { now: Date; osTimeZone: string; integrations: IntegrationsConfig },
) {
  const { ledgerRows, shifts, portfolio: { period, wallRevenueUsd: { period: wallPeriod } } } = ledger;
  const operatorToday = revenueCalendarDate(now, osTimeZone);
  // Each site's saved daily revenue from every source, on its sources' own
  // reporting clock, back as far as the projection reads.
  const revenueClockFallback = operatorRevenueClock(osTimeZone);
  const revenueHistories = await loadRevenueHistories(store, {
    now, days: REVENUE_HISTORY_DAYS + 1, fallback: revenueClockFallback, includeSourceDays: true, assets,
  });
  const dailyLedgerSources = new Map(ledgerRows.filter(row => wallPeriod === period && row.currency === 'USD' && row.dailySources)
    .map(row => [row.asset, new Set(row.dailySources)]));
  for (const row of shifts) {
    if (row.toPeriod !== wallPeriod) continue;
    const sources = dailyLedgerSources.get(row.asset) ?? new Set<string>();
    sources.add(STRIPE_REVENUE_SOURCE);
    dailyLedgerSources.set(row.asset, sources);
  }
  /** The days every source the site owed reported: a partial day is not yet
   * the day's revenue. */
  const completeRevenueDays = (history: SiteRevenueHistory) =>
    history.days.filter((day) => !history.partialDates.includes(day.date));
  // Skip the longer traffic read until a daily revenue source has supplied
  // history, and read it only for the assets that have: `projectRevenue`
  // answers "no revenue" before it looks at traffic.
  const revenueTraffic = revenueHistories.size ? await loadSignalTrends(store, REVENUE_HISTORY_DAYS, { includeWebSearch: false, includeSessions: true, assets: [...revenueHistories.keys()], nowMs: now.getTime(), timeZone: osTimeZone }) : new Map<string, SignalTrendSet>();
  return new Map(assets.map(asset => {
    const history = revenueHistories.get(asset) ?? emptyRevenueHistory(now, REVENUE_HISTORY_DAYS + 1, revenueClockFallback);
    const revenueClock = history.clock ?? revenueClockFallback;
    const forecastHistory = revenueForForecast(history, now, REVENUE_HISTORY_DAYS + 1);
    const forecastClock = forecastHistory.clock ?? revenueClockFallback;
    const projection = projectRevenue(now, forecastClock, completeRevenueDays(forecastHistory), revenueTraffic.get(asset)?.sessions ?? emptySignalTrendSet().sessions,
        revenueHolidays(integrations.assets[asset]?.['ad-network']?.revenueHolidayCalendar,
          Number(revenueCalendarDate(now, forecastClock.timeZone).slice(0, 4))));
    const observed = new Set(projection.points.filter(point => !point.projected).map(point => point.date));
    const wallDailyRevenue = history.bySource.length ? wallYesterdayRevenue(history, operatorToday, osTimeZone, now) : undefined;
    const revenueProjectionSources = history.bySource.flatMap(source => {
      if (source.currency !== "USD") return [];
      // The financial ledger resolves overlap with imported monthly entries.
      // A site without a forecast can still chart its recognized daily revenue.
      const recorded = dailyLedgerSources.get(asset)?.has(source.source);
      const sourceToday = revenueCalendarDate(now, source.clock.timeZone);
      const outsideForecast = source.source === STRIPE_REVENUE_SOURCE && forecastHistory !== history;
      const days = source.days.filter(day => projection.status === 'ready' && !outsideForecast
        ? observed.has(day.date)
        : recorded && day.date.startsWith(wallPeriod) && day.date < sourceToday)
        .map(({ date, amountMinor }) => ({ date, amountMinor }));
      return days.length ? [{ source: source.source, displayName: source.displayName, days,
        ...(outsideForecast ? { includedInProjection: false as const } : {}) }] : [];
    });
    return [asset, {
      dailyRevenue: history.bySource.some(source => source.source === STRIPE_REVENUE_SOURCE) && wallDailyRevenue
        ? { date: wallDailyRevenue.date, timeZone: osTimeZone, amountMinor: wallDailyRevenue.amountMinor,
          reportedThrough: wallDailyRevenue.complete ? wallDailyRevenue.date : null }
        : { ...yesterdayRevenue(now, revenueClock.timeZone, completeRevenueDays(history)),
          timeZoneLabel: revenueClock.label },
      revenueProjection: projection,
      ...(wallDailyRevenue !== undefined ? { wallDailyRevenue } : {}),
      ...(revenueProjectionSources.length ? { revenueProjectionSources } : {}),
    }];
  }));
}
