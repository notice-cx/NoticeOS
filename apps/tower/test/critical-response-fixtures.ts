import { buildSettingsPayload } from '../worker/settings-payload';

/** Current public settings shape, built by the actual pure server builder. */
export function settingsResponse(extra: Record<string, unknown> = {}) {
  return { ...buildSettingsPayload({ now: new Date('2026-10-01T12:00:00.000Z'),
    osTimeZone: 'Etc/UTC', timeZoneChosen: false, monthlyCaps: { dataUsd: 0 },
    operatorRateUsdPerMin: 0, flagDefaults: {}, signalPanels: {}, pullConfig: [],
    integrations: { catalog: [], assets: {} }, dashboard: {}, entities: [], beads: { spokes: [] } }), ...extra };
}

const emptyMoney = () => ({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
/** Money-only response fixtures for transport/lifetime tests. Actual complete
 * producer compatibility is covered by money-response-payload.test.ts. */
export function wallMoneyResponse(extra: Record<string, unknown> = {}) {
  return { generatedAt: '2026-10-01T12:00:00.000Z', ledgerRecordedAt: null, assets: [],
    portfolio: { period: '2026-10', periodIsCurrent: true, booked: emptyMoney(), forecast: emptyMoney(),
      residue: { booked: emptyMoney(), forecast: emptyMoney() }, netTrend: [], netTrendAll: [],
      netTrendCurrency: null, netTrendAllCurrency: null, trendGranularity: 'monthly', bookedDelta: null,
      firstRun: true, daysIn: 0 }, ...extra };
}
export function assetMoneyResponse(id: string) {
  return { generatedAt: '2026-10-01T12:00:00.000Z', asset: { id }, osTimeZone: 'Etc/UTC',
    integrations: { lanes: [] }, ledger: { currency: 'USD', empty: true, periods: [], recentRows: [] } };
}
