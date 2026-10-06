// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '@/lib/api';
import { dailyRevenueHistory, dailyRevenueSummary, portfolioDailyRevenue, revenueProjection, moneyFigureValue, moneyLine,
  decodeFinancials, decodeWallMoney, decodeAssetMoney } from '@/lib/money-response';
import { projectRevenue } from '@shared/revenue-projection';
import { yesterdayRevenue, siteRevenueWindow, MEDIAVINE_REPORTING_CLOCK } from '@shared/daily-revenue';

const now = new Date('2026-10-01T12:00:00.000Z');
const days = [{ date: '2026-09-30', amountMinor: 0 }];
const history = () => ({ from: '2026-09-29', to: '2026-09-30', reportedThrough: '2026-09-30', days: structuredClone(days) });
const forecast = () => projectRevenue(now, MEDIAVINE_REPORTING_CLOCK, [], { series: [], contextSeries: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] });
const figure = (currency = 'EUR') => ({ currency, revenue: 0, cost: 2, net: -2 });
const unknown = () => ({ currency: null, revenue: null, cost: null, net: null });
function financials() { return { generatedAt: now.toISOString(), period: '2026-09', currentPeriod: '2026-10', periodIsCurrent: false,
  periods: ['2026-09'], empty: false, months: [{ period: '2026-09', booked: figure(), estimated: figure(), total: figure() }],
  properties: [{ asset: 'site.example', displayName: 'Site', isOs: false, figure: figure(),
    months: [{ period: '2026-09', figure: figure() }], revenueReported: true }], overhead: figure(),
  costLines: [{ family: 'hosting', provenance: 'stated', source: null, rows: 1, amount: 2, currency: 'EUR' }],
  domains: [], recurringCosts: [], domainOrders: [] }; }
function wall() { return { generatedAt: now.toISOString(), ledgerRecordedAt: null,
  portfolio: { period: '2026-09', periodIsCurrent: false, booked: figure(), forecast: figure(),
    residue: { booked: figure(), forecast: figure() }, netTrend: [{ t: '2026-09', v: -2 }], netTrendCurrency: 'EUR',
    netTrendAll: [], netTrendAllCurrency: null, trendGranularity: 'monthly', bookedDelta: null, firstRun: false, daysIn: 1 },
  assets: [{ id: 'site.example', booked: figure(), forecast: figure(), netPeriod: '2026-09',
    netByMonth: [{ t: '2026-09', v: -2 }], netByMonthCurrency: 'EUR', netByMonthProvisionalFrom: '2026-10' }] }; }
function asset() { return { generatedAt: now.toISOString(), asset: { id: 'site.example' }, osTimeZone: 'Etc/UTC', integrations: { lanes: [] },
  ledger: { currency: 'EUR', empty: false, periods: [{ period: '2026-09',
    booked: { figure: figure(), revenueByFamily: [], costByFamily: [{ family: 'hosting', amount: 2, currency: 'EUR' }] },
    forecast: { figure: figure(), revenueByFamily: [], costByFamily: [] } }], recentRows: [{ id: 1, kind: 'cost', period: '2026-09',
      family: 'hosting', amount: 2, currency: 'EUR', bookingState: 'reconciled', source: null, ref: null, note: null, recordedAt: now.toISOString() }] } }; }

describe('critical money payloads', () => {
  it('validates the actual API decoder paths before returning received money', async () => {
    const financial = financials();
    const wallValue = wall();
    const detail = asset();
    const transport = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).startsWith('/api/financials')
      ? financial : String(input) === '/api/wall' ? wallValue : detail));
    const api = createApi(transport);
    expect(await api.fetchFinancials('2026-09')).toEqual(financial);
    expect(await api.fetchWall()).toEqual(wallValue);
    expect(await api.fetchAssetDetail('site.example')).toEqual(detail);
    expect(transport.mock.calls.map(([path]) => path)).toEqual(['/api/financials?period=2026-09', '/api/wall', '/api/assets/site.example']);
  });
  it('refuses malformed wire money and asset identity before exposing a result', async () => {
    const malformed = createApi(async () => Response.json({ ...financials(), overhead: { revenue: 0, cost: 0, net: 0 } }));
    await expect(malformed.fetchFinancials()).rejects.toThrow('invalid response');
    await expect(createApi(async () => Response.json({ ...wall(), ledgerRecordedAt: 'yesterday' })).fetchWall()).rejects.toThrow('invalid response');
    await expect(createApi(async () => Response.json(asset())).fetchAssetDetail('foreign.example')).rejects.toThrow('invalid response');
    await expect(createApi(async () => new Response('{private-account-secret')).fetchFinancials()).rejects.toThrow('Financials returned an invalid response.');
  });
  it('returns stated-currency figures, zero observations and null sums verbatim', () => {
    const value = financials(); expect(decodeFinancials(value, '2026-09')).toBe(value);
    const mixed = { ...value, overhead: unknown() }; expect(decodeFinancials(mixed)).toBe(mixed);
    const portfolio = wall(); expect(decodeWallMoney(portfolio)).toBe(portfolio);
    const detail = asset(); expect(decodeAssetMoney(detail, 'site.example')).toBe(detail);
  });
  it.each([
    { ...financials(), period: '2026-13' }, { ...financials(), overhead: { revenue: 0, cost: 0, net: 0 } },
    { ...financials(), costLines: [{ ...financials().costLines[0], currency: 'ZZZ' }] },
    { ...financials(), recurringCosts: [{ id: 'hosting', label: 'Hosting', asset: 'site.example', family: 'hosting', amountUsdPerMonth: 0, from: '2026-09', currency: 'EUR' }] },
    { ...financials(), domainOrders: [{ domain: 'site.example', asset: 'site.example', kind: 'renewal', paidUsd: 0, paidOn: '2026-02-30' }] },
  ])('rejects malformed financial data %#', value => expect(() => decodeFinancials(value)).toThrow('invalid response'));
  it('refuses a different requested accounting period instead of repointing a saved edit guard', () => {
    expect(() => decodeFinancials(financials(), '2026-08')).toThrow('invalid response');
  });
  it('keeps mixed-axis charts unavailable rather than rendering received numeric points as one currency', () => {
    const value = wall(); Object.assign(value.portfolio, { netTrendCurrency: null });
    expect(() => decodeWallMoney(value)).toThrow('invalid response');
    value.portfolio.netTrend = []; expect(decodeWallMoney(value)).toBe(value);
    const card = wall(); Object.assign(card.assets[0]!, { netByMonthCurrency: null });
    expect(() => decodeWallMoney(card)).toThrow('invalid response');
  });
  it('verifies asset identity and only requires the ledger on views that actually own it', () => {
    const value = asset(); expect(() => decodeAssetMoney(value, 'foreign.example')).toThrow('invalid response');
    const { ledger: _ledger, ...withoutLedger } = value;
    expect(() => decodeAssetMoney(withoutLedger, 'site.example', 'financials')).toThrow('invalid response');
    expect(decodeAssetMoney({ ...withoutLedger, view: 'settings' }, 'site.example', 'settings')).toMatchObject({ view: 'settings' });
    expect(() => decodeAssetMoney({ ...withoutLedger, view: 'settings' }, 'site.example', 'growth')).toThrow('invalid response');
  });
  it('validates each raw row and family currency independently from an unavailable ledger-wide basis', () => {
    const value = asset(); Object.assign(value.ledger, { currency: null });
    expect(decodeAssetMoney(value, 'site.example')).toBe(value);
    Reflect.deleteProperty(value.ledger.recentRows[0]!, 'currency');
    expect(() => decodeAssetMoney(value, 'site.example')).toThrow('invalid response');
    const family = asset(); family.ledger.periods[0]!.booked.costByFamily[0]!.amount = Infinity;
    expect(() => decodeAssetMoney(family, 'site.example')).toThrow('invalid response');
  });
  it.each([1, -1, -81])('preserves recorded ledger row number %s, including generated provider estimates', async id => {
    const value = asset(); value.ledger.recentRows[0]!.id = id;
    expect(decodeAssetMoney(value, 'site.example')).toBe(value);
    expect(await createApi(async () => Response.json(value)).fetchAssetDetail('site.example')).toEqual(value);
  });
  it.each([0, 0.5, -0.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])(
    'refuses malformed ledger row number %s', id => {
      const value = asset(); value.ledger.recentRows[0]!.id = id;
      expect(() => decodeAssetMoney(value, 'site.example')).toThrow('invalid response');
    });
});

describe('stated ledger currency', () => {
  it.each(['USD', 'EUR', 'JPY', 'KWD'])('preserves explicit %s values without exchange-rate arithmetic', currency => {
    const value = { currency, revenue: 0, cost: 2, net: -2 };
    expect(moneyFigureValue(value)).toBe(true);
    expect(moneyLine({ currency, amount: 0 })).toBe(true);
  });
  it('accepts an entirely unknown sum without changing it to USD or zero', () => {
    const value = { currency: null, revenue: null, cost: null, net: null };
    expect(moneyFigureValue(value)).toBe(true); expect(value.currency).toBeNull(); expect(value.net).toBeNull();
  });
  it.each([
    { revenue: 0, cost: 0, net: 0 }, { currency: 'ZZZ', revenue: 0, cost: 0, net: 0 },
    { currency: 'usd', revenue: 0, cost: 0, net: 0 }, { currency: null, revenue: 0, cost: null, net: null },
    { currency: 'USD', revenue: null, cost: 0, net: 0 }, { currency: 'USD', revenue: '0', cost: 0, net: 0 },
    { currency: 'USD', revenue: Infinity, cost: 0, net: 0 },
  ])('refuses missing/mixed/malformed currency figures %#', value => expect(moneyFigureValue(value)).toBe(false));
});

describe('recorded provider money', () => {
  it('accepts current source-clock builders and distinguishes unknown from observed zero', () => {
    const zero = yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, days);
    const unknown = yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, []);
    expect(dailyRevenueSummary(zero)).toBe(true);
    expect(dailyRevenueSummary(unknown)).toBe(true);
    expect(zero.amountMinor).toBe(0); expect(unknown.amountMinor).toBeNull();
    expect(dailyRevenueHistory(siteRevenueWindow(undefined, now.getTime(), MEDIAVINE_REPORTING_CLOCK.timeZone, 28))).toBe(true);
    expect(dailyRevenueHistory(history())).toBe(true);
    expect(dailyRevenueHistory({ ...history(), days: [{ date: '2026-09-30', amountMinor: -20 }] })).toBe(true);
  });
  it.each([
    { ...history(), from: '2026-02-30' }, { ...history(), to: '2026-09-28' },
    { ...history(), reportedThrough: 'yesterday' }, { ...history(), days: [{ date: '2026-09-30', amountMinor: '0' }] },
    { ...history(), days: [{ date: '2026-09-30', amountMinor: Infinity }] },
    { ...history(), days: [{ date: '2026-09-30', amountMinor: 0.5 }] },
    { ...history(), days: [{ date: '2026-09-28', amountMinor: 0 }] },
    { ...history(), days: [...days, ...days] },
  ])('refuses malformed recorded history %#', value => expect(dailyRevenueHistory(value)).toBe(false));
  it('refuses invalid reporting clocks without substituting the operator clock', () => {
    const value = yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, days);
    expect(dailyRevenueSummary({ ...value, timeZone: 'invalid-zone' })).toBe(false);
    expect(dailyRevenueSummary({ ...value, date: '2026-09-31' })).toBe(false);
    expect(dailyRevenueSummary({ ...value, amountMinor: undefined })).toBe(false);
    expect(dailyRevenueSummary({ ...value, currency: 'EUR' })).toBe(false);
    expect(dailyRevenueHistory({ ...history(), currency: 'EUR' })).toBe(false);
    expect(dailyRevenueHistory({ ...history(), days: [{ ...days[0]!, currency: 'EUR' }] })).toBe(false);
  });
  it('checks named coverage without manufacturing missing asset reports', () => {
    const value = { ...history(), sources: [{ asset: 'site.example', displayName: 'Site', since: '2026-09-30' }],
      coverage: [{ date: '2026-09-30', reported: 1, missingAssets: [] }] };
    expect(portfolioDailyRevenue(value)).toBe(true);
    expect(portfolioDailyRevenue({ ...value, coverage: [{ date: '2026-09-29', reported: 0, missingAssets: [] }] })).toBe(true);
    expect(portfolioDailyRevenue({ ...value, coverage: [{ date: '2026-09-30', reported: 0, missingAssets: ['foreign.example'] }] })).toBe(false);
    expect(portfolioDailyRevenue({ ...value, coverage: [{ date: '2026-09-30', reported: 2, missingAssets: [] }] })).toBe(false);
    expect(portfolioDailyRevenue({ ...value, sources: [...value.sources, ...value.sources] })).toBe(false);
  });
  it('preserves an empty open-month provider window before its first completed reporting day', () => {
    const value = { from: '2026-10-01', to: '2026-09-30', reportedThrough: null, days: [], sources: [], coverage: [] };
    expect(portfolioDailyRevenue(value)).toBe(true);
    expect(portfolioDailyRevenue({ ...value, days: [{ date: '2026-09-30', amountMinor: 0 }] })).toBe(false);
    expect(portfolioDailyRevenue({ ...value, reportedThrough: '2026-09-30' })).toBe(false);
  });
});

describe('received forecast facts', () => {
  it('accepts the current pure builder without filling unknown forecasts with zero', () => {
    const value = forecast();
    expect(revenueProjection(value)).toBe(true);
    expect(value.status).toBe('no-revenue'); expect(value.projectedMinor).toBeNull();
    expect(revenueProjection({ ...value, earnedMinor: 0, projectedMinor: 0, dailyPaceMinor: 0,
      points: [{ date: '2026-10-01', cumulativeMinor: 0, projected: false }] })).toBe(true);
  });
  it.each([
    { ...forecast(), status: 'success' }, { ...forecast(), period: '2026-13' },
    { ...forecast(), previousMonthMinor: '0' }, { ...forecast(), changePercent: Infinity },
    { ...forecast(), holidayHistoryDays: -1 }, { ...forecast(), projectedMinor: 1.5 },
    { ...forecast(), currency: 'EUR' },
    { ...forecast(), points: [{ date: '2026-09-30', cumulativeMinor: 0, projected: false }] },
    { ...forecast(), points: [{ date: '2026-10-01', cumulativeMinor: 0, projected: 'false' }] },
  ])('refuses malformed projection %#', value => expect(revenueProjection(value)).toBe(false));
});
