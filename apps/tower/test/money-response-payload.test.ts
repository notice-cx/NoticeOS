import { expect, it } from 'vitest';
import { decodeFinancials, decodeWallMoney, decodeAssetMoney } from '@/lib/money-response';
import { buildFinancialsPayload } from '../worker/financials-payload';
import { buildWallPayload } from '../worker/wall-payload';
import { buildAssetDetailPayload, buildAssetDetailView, type AssetDetailDeps } from '../worker/asset-detail-payload';
import { createTestStore } from './postgres-store';
import { addSites } from './sites';
import { bookLedger, writeMediavine } from './money';

const now = new Date('2026-10-01T12:00:00.000Z');
const id = 'software.example';
const integrations = { catalog: [], assets: {} };
const counters = { assets: {} };
const serpPanel = { assets: {} };
const detail: AssetDetailDeps = { now, osTimeZone: 'Etc/UTC', integrations, counters, serpPanel,
  flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
  pullConfig: [], monthlyCaps: { dataUsd: 25 }, operatorRateUsdPerMin: 2,
  signalPanels: { assets: {} }, valueEvents: { assets: {} }, ga4EventParams: { assets: {} } };

it.each(['USD', 'EUR', 'JPY', 'KWD', 'mixed', 'empty'])('accepts actual stored %s payloads without rewriting money or edit guards', async currency => {
  const fixture = await createTestStore();
  await addSites(fixture, [{ id, domain: id, displayName: 'Software', status: 'live', senseOnly: 0, isOs: 0,
    createdAt: '2026-07-01T00:00:00.000Z' }]);
  if (currency !== 'empty') {
    await bookLedger(fixture.call, [
      { kind: 'revenue', asset: id, period: '2026-09', family: 'licensing', amount_minor: 1200,
        currency: currency === 'mixed' ? 'EUR' : currency, booking_state: 'reconciled', recorded_at: now.toISOString() },
      { kind: 'cost', asset: id, period: '2026-09', family: 'infra', amount_minor: 300,
        currency: currency === 'mixed' ? 'USD' : currency, booking_state: 'reconciled', recorded_at: now.toISOString() },
      { kind: 'revenue', asset: id, period: '2026-08', family: 'licensing', amount_minor: 0,
        currency: currency === 'mixed' ? 'EUR' : currency, booking_state: 'reconciled', recorded_at: now.toISOString() },
    ]);
  }
  const finances = await buildFinancialsPayload(fixture.call, { now, osTimeZone: detail.osTimeZone,
    domainOrders: [{ domain: id, asset: id, kind: 'registration', paidUsd: 12, paidOn: '2026-07-01' }],
    recurringCosts: [{ id: 'hosting', label: 'Hosting', asset: id, family: 'hosting', amountUsdPerMonth: 2, from: '2026-07' }] });
  expect(decodeFinancials(finances, finances.period)).toBe(finances);
  const wall = await buildWallPayload(fixture.call, { now, osTimeZone: detail.osTimeZone, constants: { dataUsd: 25 },
    integrations, counters, serpPanel, pullConfig: [], dashboard: {} });
  expect(decodeWallMoney(wall)).toBe(wall);
  const asset = await buildAssetDetailPayload(fixture.call, id, detail);
  expect(asset).not.toBeNull();
  expect(decodeAssetMoney(asset, id)).toBe(asset);
  for (const view of ['financials', 'settings'] as const) {
    const partial = await buildAssetDetailView(fixture.call, id, detail, view);
    expect(decodeAssetMoney(partial, id, view)).toBe(partial);
  }
  if (currency === 'mixed') {
    expect(finances.months.find(row => row.period === '2026-09')?.booked.currency).toBeNull();
    expect(wall.portfolio.booked.currency).toBeNull();
  }
});

it('accepts real monthly provider estimates alongside numbered booked entries', async () => {
  const fixture = await createTestStore();
  await addSites(fixture, [{ id, domain: id, displayName: 'Software', status: 'live', senseOnly: 0, isOs: 0,
    createdAt: '2026-07-01T00:00:00.000Z' }]);
  await bookLedger(fixture.call, [{ kind: 'cost', asset: id, period: '2026-09', family: 'infra',
    amount_minor: 300, currency: 'USD', booking_state: 'reconciled', recorded_at: now.toISOString() }]);
  await writeMediavine(fixture.call, [{ id: 'provider-estimates', asset: id, siteId: 'provider-site',
    start: '2026-09-28', end: '2026-09-30', attemptedAt: now.toISOString(),
    days: [['2026-09-28', 0], ['2026-09-29', 120], ['2026-09-30', 200]] }]);
  for (const view of ['overview', 'financials'] as const) {
    const payload = await buildAssetDetailView(fixture.call, id, detail, view);
    expect(payload).not.toBeNull();
    const decoded = decodeAssetMoney(payload, id, view);
    expect(decoded).toBe(payload);
    const rows = decoded.ledger!.recentRows;
    expect(rows.find(row => row.source === 'mediavine-journey')).toMatchObject({
      id: expect.any(Number), kind: 'revenue', amount: 3.2, currency: 'USD', bookingState: 'estimated',
    });
    expect(rows.find(row => row.source === 'mediavine-journey')!.id).toBeLessThan(0);
    expect(rows.find(row => row.family === 'infra')!.id).toBeGreaterThan(0);
  }
});
