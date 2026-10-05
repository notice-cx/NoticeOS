import { beforeEach, describe, expect, it } from 'vitest';
import { buildFinancialsPayload } from '../worker/financials-payload';
import { buildWallPayload } from '../worker/wall-payload';
import { buildAssetDetailPayload, type AssetDetailDeps } from '../worker/asset-detail-payload';
import { formatMoney } from '../src/lib/format';
import { createTestStore, type TestStore } from './postgres-store';
import { addSites } from './sites';
import { bookLedger } from './money';
import { buildWallFeed } from '../worker/wall-feed';
import { mergeLane } from '../worker/integration-evidence';
const now = new Date('2026-08-15T12:00:00Z');
const deps: AssetDetailDeps = { now, flagDefaults: {}, pullConfig: [], monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2, integrations: { catalog: [], assets: {} }, counters: { assets: {} },
  serpPanel: { assets: {} }, signalPanels: { assets: {} }, valueEvents: { assets: {} },
  ga4EventParams: { assets: {} }, osTimeZone: 'UTC' };
const wallDeps = { now, constants: { dataUsd: 25 }, integrations: { catalog: [], assets: {} },
  pullConfig: [], dashboard: {}, serpPanel: { assets: {} }, osTimeZone: 'UTC' };
let ctx: TestStore;
beforeEach(async () => {
  ctx = await createTestStore();
  await addSites(ctx, ['meals.example','nosh.example'].map(id => ({ id, domain: id,
    displayName: id, status: 'live', senseOnly: 0, isOs: 0, createdAt: '2026-01-01T00:00:00Z' })));
});
const row = (currency: string, minor: number, asset = 'meals.example', period = '2026-08') => ({
  kind: 'revenue' as const, asset, period, family: 'ads', amount_minor: minor,
  currency, booking_state: 'reconciled' as const });
describe('Currency survives every ledger reader', () => {
  it.each([['EUR', 12345, 123.45, '€123.45'], ['JPY', 12345, 12345, '¥12,345'], ['KWD', 12345, 12.345, 'KWD 12.345']])(
    'states %s precision on Financials, Wall and the asset ledger', async (currency, minor, major, label) => {
      await bookLedger(ctx.call, [row(String(currency), Number(minor))]);
      const financials = await buildFinancialsPayload(ctx.call, { now, domainOrders: [], osTimeZone: 'UTC' });
      const wall = await buildWallPayload(ctx.call, wallDeps);
      const detail = await buildAssetDetailPayload(ctx.call, 'meals.example', deps);
      const figure = { currency, revenue: major, cost: 0, net: major };
      expect(financials.months[0]?.booked).toEqual(figure);
      expect(wall.portfolio.booked).toEqual(figure);
      expect(detail?.ledger?.periods[0]?.booked.figure).toEqual(figure);
      expect(detail?.ledger?.recentRows[0]).toMatchObject({ currency, amount: major });
      expect(formatMoney(Number(major), String(currency), { cents: true })).toBe(label);
    });
  it('keeps pure asset figures readable while a mixed portfolio total and trend are unavailable', async () => {
    await bookLedger(ctx.call, [row('EUR', 10000), row('USD', 20000, 'nosh.example')]);
    const financials = await buildFinancialsPayload(ctx.call, { now, domainOrders: [], osTimeZone: 'UTC' });
    const wall = await buildWallPayload(ctx.call, wallDeps);
    const unknown = { currency: null, revenue: null, cost: null, net: null };
    expect(financials.months[0]?.total).toEqual(unknown);
    expect(wall.portfolio.booked).toEqual(unknown);
    expect(financials.properties.find(property => property.asset === 'meals.example')?.figure).toMatchObject({ currency: 'EUR', net: 100 });
    expect(wall.portfolio.netTrend).toEqual([]);
    expect(wall.portfolio.netTrendCurrency).toBeNull();
    expect(wall.assets.find(asset => asset.id === 'meals.example')?.booked).toMatchObject({ currency: 'EUR', net: 100 });
  });
  it('states each feed entry in its own currency and refuses a mixed supporting evidence sum', async () => {
    await bookLedger(ctx.call, [{ ...row('EUR', 12345), recorded_at: '2026-08-15T10:00:00Z' },
      { ...row('JPY', 12345), recorded_at: '2026-08-15T11:00:00Z' }]);
    const feed = await buildWallFeed(ctx.call, { now, osTimeZone: 'UTC' });
    expect(feed.items.filter(item => item.id.startsWith('ledger:')).map(item => item.text)).toEqual([
      'Booked ¥12,345 ad revenue for August', 'Booked €123.45 ad revenue for August']);
    const evidenceRow = { family: 'ads', source: 'raptive-report', note: null, period: '2026-08' };
    expect(mergeLane('needs-setup', 'ad-network', { revenueRows: [{ ...evidenceRow, currency: 'KWD', amountMinor: 12345 }] }).evidence[0]?.detail)
      .toBe('KWD 12.345 · latest 2026-08');
    expect(mergeLane('needs-setup', 'ad-network', { revenueRows: [{ ...evidenceRow, currency: 'EUR', amountMinor: 1000 },
      { ...evidenceRow, currency: 'USD', amountMinor: 2000 }] }).evidence[0]?.detail).toBe('Currency unavailable · latest 2026-08');
  });
  it('groups currencies before ranking asset contributions and cost lines', async () => {
    await addSites(ctx, [{ id: 'third.example', domain: 'third.example', displayName: 'Third', status: 'live',
      senseOnly: 0, isOs: 0, createdAt: '2026-01-01T00:00:00Z' }]);
    await bookLedger(ctx.call, [row('EUR', 1000), row('EUR', 2000, 'third.example'), row('USD', 9999, 'nosh.example'),
      { ...row('EUR', 100), kind: 'cost', family: 'infra' },
      { ...row('USD', 10000, 'nosh.example'), kind: 'cost', family: 'infra' }]);
    const financials = await buildFinancialsPayload(ctx.call, { now, domainOrders: [], osTimeZone: 'UTC' });
    expect(financials.properties.map(property => property.asset)).toEqual(['third.example', 'meals.example', 'nosh.example']);
    expect(financials.costLines.map(line => [line.currency, line.amount])).toEqual([['EUR', 1], ['USD', 100]]);
  });
  it('withholds a closed-period difference that exceeds exact integer minor units', async () => {
    await bookLedger(ctx.call, [row('EUR', -Number.MAX_SAFE_INTEGER, 'meals.example', '2026-06'),
      row('EUR', Number.MAX_SAFE_INTEGER, 'meals.example', '2026-07')]);
    const wall = await buildWallPayload(ctx.call, wallDeps);
    expect(wall.portfolio.booked.currency).toBe('EUR');
    expect(Number.isFinite(wall.portfolio.booked.net)).toBe(true);
    expect(wall.portfolio.bookedDelta).toBeNull();
  });
  it('does not merge same-family currencies and suppresses unlike-period deltas', async () => {
    await bookLedger(ctx.call, [row('EUR', 10000, 'meals.example', '2026-06'),
      row('USD', 20000, 'meals.example', '2026-07'), row('EUR', 1000), row('JPY', 3000)]);
    const detail = await buildAssetDetailPayload(ctx.call, 'meals.example', deps);
    expect(detail?.ledger?.currency).toBeNull();
    expect(detail?.ledger?.periods[0]?.booked.figure.currency).toBeNull();
    expect(detail?.ledger?.periods[0]?.booked.revenueByFamily).toEqual([
      { family: 'ads', currency: 'EUR', amount: 10 }, { family: 'ads', currency: 'JPY', amount: 3000 }]);
    const wall = await buildWallPayload(ctx.call, wallDeps);
    expect(wall.portfolio.bookedDelta).toBeNull();
    expect(wall.assets.find(asset => asset.id === 'meals.example')?.netByMonth.every(point => point.v === null)).toBe(true);
  });
});
