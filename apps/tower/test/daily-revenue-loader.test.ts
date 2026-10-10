// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import { createTestStore } from "./postgres-store";
import { addSites } from './sites';
import { seedRevenueHistory } from './revenue-fixture';
import { mapMediavineSite, writeMediavine } from './money';
import { loadDailyRevenue, loadPortfolioDailyRevenue } from '../worker/daily-revenue';
import { revenueWindowDays } from '../shared/daily-revenue';

// Each test writes its Mediavine days into its own copy of the store.

const dailyRows = async (store: WorkspaceStore) =>
  (await store.read((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM noticeos.mediavine_daily')))[0]?.n;

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
      const result = await loadPortfolioDailyRevenue(store, '2026-09', new Date(at));
      expect(result.days).toEqual([{ date: '2026-09-08', amountMinor: 1735 }, { date: '2026-09-09', amountMinor: 0 }]);
      expect(result.coverage.at(-2)).toEqual({ date: '2026-09-08', reported: 2, missingAssets: [] });
      expect(result.coverage.at(-1)).toEqual({ date: '2026-09-09', reported: 1, missingAssets: ['second.test'] });
      // Both sites first reported on the 8th, so the week before owes nothing.
      expect(result.coverage[0]).toEqual({ date: '2026-09-01', reported: 0, missingAssets: [] });
      expect(result.sources).toEqual([
        { asset: 'first.test', displayName: 'Blog', since: '2026-09-08' },
        { asset: 'second.test', displayName: 'Blog', since: '2026-09-08' },
      ]);
      const past = await loadPortfolioDailyRevenue(store, '2026-08', new Date(at));
      expect(past.to).toBe('2026-08-31');
      expect(past.days).toEqual([]);
      expect(past.sources).toEqual([]);
      expect(past.coverage.every(day => day.missingAssets.length === 0)).toBe(true);
      const future = await loadPortfolioDailyRevenue(store, '2026-10', new Date(at));
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
      const load = (period: string) => loadPortfolioDailyRevenue(store, period, new Date(at));
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

  it('uses the current revision, keeps exact zero, and respects the requested asset and dates', async () => {
    const ctx = await createTestStore();
    const raw = ctx;
    const at = '2026-09-10T15:00:00Z';
    try {
      await addSites(raw, [{ id: 'sample.test', displayName: 'Sample', status: 'live', senseOnly: 0, createdAt: at }]);
      const store = ctx.call;
      await seedRevenueHistory(store, 'sample.test', at, '2026-09-09');
      await writeMediavine(store, [{ id: 'revised-revenue', asset: 'sample.test', siteId: 'forecast-site', start: '2026-09-09', end: '2026-09-09',
        attemptedAt: at, days: [['2026-09-09', 0]] }]);
      expect(await loadDailyRevenue(store, 'sample.test', '2026-09-08', '2026-09-10')).toEqual({
        from: '2026-09-08', to: '2026-09-10', reportedThrough: '2026-09-09', days: [
          { date: '2026-09-08', amountMinor: 2000 }, { date: '2026-09-09', amountMinor: 0 },
        ],
      });
      expect((await loadDailyRevenue(store, 'other.test', '2026-09-08', '2026-09-10')).days).toEqual([]);
      expect((await loadDailyRevenue(store, 'sample.test', '2026-09-10', '2026-09-11')).reportedThrough).toBe('2026-09-09');
    } finally { await raw.close(); }
  });
});
