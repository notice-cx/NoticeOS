// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import { createTestStore } from "./postgres-store";
import { addSites } from './sites';
import { seedRevenueHistory } from './revenue-fixture';
import { mapMediavineSite, writeMediavine, writeRevenue } from './money';
import { loadDailyRevenue, loadPortfolioDailyRevenue, loadRevenueHistories } from '../worker/daily-revenue';
import { operatorRevenueClock, revenueWindowDays } from '../shared/daily-revenue';
import { MEDIAVINE_REPORTING_CLOCK } from '../../../packages/mediavine/src/index';

const MEDIAVINE_CLOCK = { timeZone: MEDIAVINE_REPORTING_CLOCK.timeZone, label: MEDIAVINE_REPORTING_CLOCK.label,
  readyAfterMinute: MEDIAVINE_REPORTING_CLOCK.readyAfterMinute };
const FALLBACK = operatorRevenueClock('UTC');

// Each test writes its Mediavine days into its own copy of the store.

const dailyRows = async (store: WorkspaceStore) =>
  (await store.read((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM noticeos.revenue_observations')))[0]?.n;

describe('saved daily earnings', () => {
  it('tracks same-named sites independently while excluding unfinished and future dates', async () => {
    const ctx = await createTestStore();
    const raw = ctx;
    const at = '2026-09-10T15:00:00Z';
    try {
      for (const asset of ['first.test', 'second.test']) {
        await addSites(raw, [{ id: asset, domain: null, displayName: 'Blog', status: 'live', senseOnly: 0, createdAt: at }]);
      }
      const store = ctx.call;
      await writeMediavine(store, [
        { id: 'first.test', asset: 'first.test', siteId: 'first.test', start: '2026-09-08', end: '2026-09-10', attemptedAt: at,
          days: [['2026-09-08', 1234], ['2026-09-09', 0], ['2026-09-10', 999999]] },
        { id: 'second.test', asset: 'second.test', siteId: 'second.test', start: '2026-09-08', end: '2026-09-10', attemptedAt: at,
          days: [['2026-09-08', 501]] },
      ]);
      const before = await dailyRows(store);
      const result = await loadPortfolioDailyRevenue(store, '2026-09', new Date(at), 'UTC');
      expect(result.days).toEqual([{ date: '2026-09-08', amountMinor: 1735 }, { date: '2026-09-09', amountMinor: 0 }]);
      expect(result.coverage.at(-2)).toEqual({ date: '2026-09-08', reported: 2, missingAssets: [] });
      expect(result.coverage.at(-1)).toEqual({ date: '2026-09-09', reported: 1, missingAssets: ['second.test'] });
      // Both sites first reported on the 8th, so the week before owes nothing.
      expect(result.coverage[0]).toEqual({ date: '2026-09-01', reported: 0, missingAssets: [] });
      expect(result.sources).toEqual([
        { asset: 'first.test', displayName: 'Blog', since: '2026-09-08' },
        { asset: 'second.test', displayName: 'Blog', since: '2026-09-08' },
      ]);
      const past = await loadPortfolioDailyRevenue(store, '2026-08', new Date(at), 'UTC');
      expect(past.to).toBe('2026-08-31');
      expect(past.days).toEqual([]);
      expect(past.sources).toEqual([]);
      expect(past.coverage.every(day => day.missingAssets.length === 0)).toBe(true);
      const future = await loadPortfolioDailyRevenue(store, '2026-10', new Date(at), 'UTC');
      expect(revenueWindowDays(future.from, future.to)).toBe(0);
      expect(future.days).toEqual([]);
      expect(await dailyRows(store)).toEqual(before);
    } finally { await raw.close(); }
  });
  /** A site owes a day only from its first report onward: a site that joined
   * Mediavine on Aug 10 and then missed Sep 14–16 must not read 0/30 in June,
   * must not have the nine days before it joined counted in August, and must
   * still show the real three-day outage in September. */
  it('owes a source only the days on or after its first report, and still names a later outage', async () => {
    const ctx = await createTestStore();
    const raw = ctx;
    const at = '2026-09-22T19:30:00Z';
    try {
      for (const [asset, name] of [['meadow.example', 'Meadow Board'], ['northwind.example', 'Northwind']] as const) {
        await addSites(raw, [{ id: asset, domain: null, displayName: name, status: 'live', senseOnly: 0, createdAt: at }]);
      }
      // Mapped, never reported: owes nothing yet.
      await addSites(raw, [{ id: 'ferns.example', domain: null, displayName: 'Fin', status: 'live', senseOnly: 0, createdAt: at }]);
      const store = ctx.call;
      const shift = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const meadow: [string, number][] = [];
      const northwind: [string, number][] = [];
      for (let date = '2026-06-01'; date <= '2026-09-21'; date = shift(date)) {
        meadow.push([date, 700]);
        const nomOut = date >= '2026-09-14' && date <= '2026-09-16';
        if (date >= '2026-08-10' && !nomOut) northwind.push([date, 40]);
      }
      await writeMediavine(store, [
        { id: 'run-meadow.example', asset: 'meadow.example', siteId: 'mv-meadow.example', start: '2026-06-01', end: '2026-09-21', attemptedAt: at, days: meadow },
        { id: 'run-northwind.example', asset: 'northwind.example', siteId: 'mv-northwind.example', start: '2026-08-10', end: '2026-09-21', attemptedAt: at, days: northwind },
      ]);
      await mapMediavineSite(store, 'mv-fin', 'ferns.example');
      const load = (period: string) => loadPortfolioDailyRevenue(store, period, new Date(at), 'UTC');
      const missingDays = (result: Awaited<ReturnType<typeof load>>) =>
        result.coverage.filter(day => day.missingAssets.length > 0).map(day => [day.date, day.missingAssets]);

      // June: Northwind had not started, so it is not a source and no day is partial.
      const june = await load('2026-06');
      expect(june.sources.map(source => source.asset)).toEqual(['meadow.example']);
      expect(missingDays(june)).toEqual([]);

      // August: Northwind is owed from the 10th, which it reported every day.
      const august = await load('2026-08');
      expect(august.sources).toEqual([
        { asset: 'meadow.example', displayName: 'Meadow Board', since: '2026-06-01' },
        { asset: 'northwind.example', displayName: 'Northwind', since: '2026-08-10' },
      ]);
      expect(missingDays(august)).toEqual([]);
      expect(august.coverage.find(day => day.date === '2026-08-09')).toEqual({ date: '2026-08-09', reported: 1, missingAssets: [] });

      // September: only the real outage is missing.
      const september = await load('2026-09');
      expect(september.to).toBe('2026-09-21');
      expect(missingDays(september)).toEqual([
        ['2026-09-14', ['northwind.example']], ['2026-09-15', ['northwind.example']], ['2026-09-16', ['northwind.example']],
      ]);
    } finally { await raw.close(); }
  });

  it('uses the current revision, keeps exact zero, names its source, and ends yesterday on the source\'s clock', async () => {
    const ctx = await createTestStore();
    const raw = ctx;
    const at = '2026-09-10T15:00:00Z';
    try {
      await addSites(raw, [{ id: 'sample.test', displayName: 'Sample', status: 'live', senseOnly: 0, createdAt: at }]);
      const store = ctx.call;
      await seedRevenueHistory(store, 'sample.test', at, '2026-09-09');
      await writeMediavine(store, [{ id: 'revised-revenue', asset: 'sample.test', siteId: 'forecast-site', start: '2026-09-09', end: '2026-09-09',
        attemptedAt: at, days: [['2026-09-09', 0]] }]);
      const now = new Date(at);
      const history = await loadDailyRevenue(store, 'sample.test', { now, days: 2, fallback: FALLBACK });
      expect(history).toMatchObject({
        from: '2026-09-08', to: '2026-09-09', reportedThrough: '2026-09-09', clock: MEDIAVINE_CLOCK, partialDates: [], days: [
          { date: '2026-09-08', amountMinor: 2000 }, { date: '2026-09-09', amountMinor: 0 },
        ],
      });
      expect(history.bySource.map(({ days, since, ...source }) => source)).toEqual([{
        source: 'mediavine-journey', provider: 'mediavine', family: 'ads', displayName: 'Mediavine Journey ad revenue',
        clock: MEDIAVINE_CLOCK, currency: 'USD', reportedThrough: '2026-09-09',
      }]);
      // A site with no source: its empty window on the operator's clock, which
      // names no reporting day.
      expect(await loadDailyRevenue(store, 'other.test', { now, days: 2, fallback: FALLBACK })).toEqual({
        from: '2026-09-08', to: '2026-09-09', days: [], reportedThrough: null, bySource: [], partialDates: [],
      });
      // A window past the last report holds no day and still names it.
      const later = await loadDailyRevenue(store, 'sample.test', { now: new Date('2026-09-13T15:00:00Z'), days: 1, fallback: FALLBACK });
      expect([later.from, later.to, later.days, later.reportedThrough]).toEqual(['2026-09-12', '2026-09-12', [], '2026-09-09']);
    } finally { await raw.close(); }
  });

  it('sums a site\'s sources per day, marks a day a source it owes missed as partial, and never adds two currencies', async () => {
    const ctx = await createTestStore();
    const raw = ctx;
    const at = '2026-09-10T15:00:00Z';
    try {
      for (const id of ['two.test', 'euro.test']) {
        await addSites(raw, [{ id, displayName: id, status: 'live', senseOnly: 0, createdAt: at }]);
      }
      const store = ctx.call;
      const dates = ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'];
      await writeRevenue(store, [
        ...dates.map(date => ({ asset: 'two.test', date, amountMinor: 100 })),
        // A second source, from the 7th, that missed the 8th.
        ...['2026-09-07', '2026-09-09'].map(date => ({ asset: 'two.test', source: 'mediavine', account: 'second-account', date, amountMinor: 50 })),
        { asset: 'euro.test', date: '2026-09-09', amountMinor: 100 },
        { asset: 'euro.test', source: 'mediavine', account: 'euro-account', date: '2026-09-09', amountMinor: 80, currency: 'EUR' },
      ]);
      const now = new Date(at);
      const histories = await loadRevenueHistories(store, { now, days: 7, fallback: FALLBACK });
      const two = histories.get('two.test')!;
      expect(two.days).toEqual([
        { date: '2026-09-05', amountMinor: 100 }, { date: '2026-09-06', amountMinor: 100 }, { date: '2026-09-07', amountMinor: 150 },
        { date: '2026-09-08', amountMinor: 100 }, { date: '2026-09-09', amountMinor: 150 },
      ]);
      expect(two.partialDates).toEqual(['2026-09-08']);
      expect(two.bySource.map(source => [source.source, source.since, source.days.length])).toEqual([
        ['mediavine', '2026-09-07', 2], ['mediavine-journey', '2026-09-05', 5],
      ]);
      const euro = histories.get('euro.test')!;
      expect([euro.days, euro.partialDates, euro.reportedThrough]).toEqual([[], [], '2026-09-09']);
      expect(euro.bySource.map(source => [source.source, source.currency, source.days])).toEqual([
        ['mediavine', 'EUR', [{ date: '2026-09-09', amountMinor: 80 }]], ['mediavine-journey', 'USD', [{ date: '2026-09-09', amountMinor: 100 }]],
      ]);
      expect([...histories.keys()].sort()).toEqual(['euro.test', 'two.test']);

      // The portfolio owes a site a day only when each source it owes reported
      // it, and adds no two currencies.
      const portfolio = await loadPortfolioDailyRevenue(store, '2026-09', now, 'UTC');
      expect(portfolio.coverage.find(day => day.date === '2026-09-08')).toEqual({ date: '2026-09-08', reported: 0, missingAssets: ['two.test'] });
      expect(portfolio.coverage.find(day => day.date === '2026-09-09')).toEqual({ date: '2026-09-09', reported: 2, missingAssets: [] });
      expect(portfolio.days).toEqual([]);
    } finally { await raw.close(); }
  });
});
