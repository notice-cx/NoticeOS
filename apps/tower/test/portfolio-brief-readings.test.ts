// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import { loadPortfolioBriefReadings } from '../worker/portfolio-brief-readings';
import { createTestStore } from './postgres-store';
import { portfolioBriefEvidenceSchema } from '@noticeos/contract/portfolio-brief';
import { addSites } from './sites';
import { bookLedger, type LedgerRow } from './money';

const now = new Date('2026-11-06T12:00:00.000Z');
const options = { now, timeZone: 'UTC', assets: [{ id: 'example.com', displayName: 'Example' }] };
function fixture(rows: { finance?: unknown[]; product?: unknown[]; outcomes?: unknown[]; changes?: unknown[] } = {}) {
  const query = vi.fn(async (sql: string) => sql.includes('financial_ledger') ? rows.finance ?? [] : sql.includes('asset_insight_snapshots') ? rows.product ?? [] : sql.includes('watch_windows') ? rows.outcomes ?? [] : rows.changes ?? []);
  const store = { read: async (run: (tx: { query: typeof query }) => unknown) => run({ query }) } as unknown as WorkspaceStore;
  return { store, query };
}
const product = (end: string) => ({ source: 'posthog', observedAt: '2026-11-05', exceptions: {
  windowStart: '2026-10-01', windowEnd: end, reportDate: '2026-11-05', total: 0, truncated: false, top: [],
}, funnels: [{ id: 'signup', name: 'Signup', windowStart: '2026-10-01', windowEnd: end,
  steps: [{ step: 1, event: 'start', path: null, people: 100 }, { step: 2, event: 'finish', path: null, people: 20 }], conversion: 0.2,
}], vitals: { windowStart: '2026-10-01', windowEnd: end, reportDate: '2026-11-05', minMeasurements: 100,
  lines: { lcp: { good: 2500, poor: 4000 }, inp: { good: 200, poor: 500 }, cls: { good: 0.1, poor: 0.25 } },
  segments: [], unmeasuredSegments: 2 } });

describe('bounded stored briefing reads', () => {
  it('executes all four statements against a disposable store', async () => {
    const context = await createTestStore();
    try { await expect(loadPortfolioBriefReadings(context.call, options)).resolves.toEqual({ facts: [], insightEvidenceIds: [] }); }
    finally { await context.close(); }
  });

  it('aggregates real ledger entries by supported cost families while preserving missing counterparts and separate accounting classes', async () => {
    const context = await createTestStore();
    try {
      await addSites(context, [{ id: 'example.com', displayName: 'Example', status: 'live', createdAt: '2026-09-01T00:00:00.000Z' }]);
      const row = (period: string, kind: LedgerRow['kind'], family: string, amount_minor: number): LedgerRow => ({
        asset: 'example.com', period, kind, family, amount_minor, booking_state: 'reconciled', recorded_at: '2026-11-05T00:00:00.000Z',
      });
      await bookLedger(context.call, [
        row('2026-09', 'revenue', 'subs', 1000), row('2026-10', 'revenue', 'subs', 2000), row('2026-11', 'revenue', 'subs', 3000),
        row('2026-09', 'cost', 'inference', 6), row('2026-09', 'cost', 'api', 5),
        row('2026-09', 'cost', 'infra', 1), row('2026-09', 'cost', 'operator', 3),
        row('2026-10', 'cost', 'inference', 10), row('2026-10', 'cost', 'api', 9),
        row('2026-10', 'cost', 'infra', 40), row('2026-10', 'cost', 'infra', 60),
        row('2026-10', 'cost', 'operator', 7), row('2026-10', 'cost', 'os-overhead', 200),
        ...['inference', 'api', 'infra', 'operator', 'os-overhead'].map((family, i) => row('2026-11', 'cost', family, i + 1)),
        row('2026-11', 'cost', 'infra', 6), row('2026-11', 'cost', 'infra', 7),
        { ...row('2026-11', 'revenue', 'subs', 999), booking_state: 'estimated' },
        { ...row('2026-11', 'cost', 'infra', 5), currency: 'JPY' },
        { ...row('2026-11', 'cost', 'infra', 99999), recorded_at: '2026-11-07T00:00:00.000Z' },
      ]);
      const packet = await loadPortfolioBriefReadings(context.call, options);
      const completed = packet.facts.find(fact => fact.id === 'finance:USD:reconciled:completed')!;
      const current = packet.facts.find(fact => fact.id === 'finance:USD:reconciled:current')!;
      expect(completed.data.periods).toMatchObject([{ costMinor: 15, revenueMinor: 1000 }, { costMinor: 326, revenueMinor: 2000 }]);
      expect(completed.data.costDrivers).toEqual(expect.arrayContaining([
        expect.objectContaining({ family: 'infra', previousMinor: 1, currentMinor: 100, changeMinor: 99 }),
        expect.objectContaining({ family: 'os-overhead', previousMinor: null, currentMinor: 200, changeMinor: null }),
      ]));
      expect(current.data.accounting).toMatchObject({ costMinor: 28, revenueMinor: 3000 });
      expect(current.data.costDrivers).toHaveLength(5);
      expect(current.data.omittedCostFamilies).toBe(0);
      expect(packet.facts.find(fact => fact.id === 'finance:USD:estimated:current')!.data.accounting).toMatchObject({ revenueMinor: 999, costMinor: null });
      expect(packet.facts.find(fact => fact.id === 'finance:JPY:reconciled:current')!.data).toMatchObject({ minorDigits: 0, accounting: { revenueMinor: null, costMinor: 5 } });
      await addSites(context, [{ id: 'ignored.example', displayName: 'Ignored', status: 'live', createdAt: '2026-09-01T00:00:00.000Z' }]);
      await bookLedger(context.call, [{ ...row('2026-11', 'revenue', 'subs', 1_000_000), asset: 'ignored.example' }]);
      const scoped = await loadPortfolioBriefReadings(context.call, { ...options, reviewAssetIds: ['example.com'] });
      expect(scoped.facts.find(fact => fact.id === 'finance:USD:reconciled:current')!.data.accounting).toMatchObject({ revenueMinor: 3000 });
      expect(scoped.facts.find(fact => fact.id === 'finance:USD:reconciled:current')!.data.selectedAssetIds).toEqual(['example.com']);
      const all = await loadPortfolioBriefReadings(context.call, options);
      expect(all.facts.find(fact => fact.id === 'finance:USD:reconciled:current')!.data.accounting).toMatchObject({ revenueMinor: 1_003_000 });
    } finally { await context.close(); }
  });

  it('uses one immutable upper bound and bounded source reads', async () => {
    const { store, query } = fixture();
    await loadPortfolioBriefReadings(store, options);
    expect(query).toHaveBeenCalledTimes(4);
    for (const [, params] of query.mock.calls as unknown as [string, unknown[]][]) expect(params).toContain(now.toISOString());
    expect(query.mock.calls[0]![0]).toContain('GROUPING SETS');
    expect(query.mock.calls[1]![0]).toContain('LIMIT 40');
    expect(query.mock.calls[2]![0]).toContain('LIMIT 12');
    expect(query.mock.calls[3]![0]).toContain('LIMIT 10');
  });

  it('preserves recorded zero versus absent accounting kinds and separates estimates', async () => {
    const base = { currency: 'USD', family: null, isTotal: true, entries: 1, recordedAt: now.toISOString(), currencyCount: 1 };
    const { store } = fixture({ finance: [
      { ...base, month: '2026-09-01', state: 'reconciled', kind: 'revenue', amount: '0' },
      { ...base, month: '2026-10-01', state: 'reconciled', kind: 'cost', amount: '100' },
      { ...base, month: '2026-11-01', state: 'estimated', kind: 'revenue', amount: '200' },
    ] });
    const packet = await loadPortfolioBriefReadings(store, options);
    expect(packet.facts).toHaveLength(2);
    expect(packet.facts[0]!.data.periods).toMatchObject([
      { revenueMinor: 0, costMinor: null, netMinor: null }, { revenueMinor: null, costMinor: 100, netMinor: null },
    ]);
    expect(packet.facts[0]!.comparison).toBeUndefined();
    expect(packet.facts[1]!.data.bookingState).toBe('estimated');
    const parsed = portfolioBriefEvidenceSchema.safeParse({ schemaVersion: 1, asOf: now.toISOString(), timeZone: 'UTC', ...packet, limitations: [], coverage: { assets: 1, includedAssets: 1, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 } });
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
  });

  it('qualifies source windows independently of publication, keeping stale and future data as context', async () => {
    const { store } = fixture({ product: ['2026-11-05', '2026-10-20', '2026-11-07'].map((end, i) => ({
      asset: `example${i}.com`, generatedAt: now.toISOString(), product: product(end),
    })) });
    const packet = await loadPortfolioBriefReadings(store, options);
    expect(packet.facts).toHaveLength(9);
    expect(packet.insightEvidenceIds).toHaveLength(3);
    expect(packet.insightEvidenceIds.every(id => id.startsWith('product:example0.com:'))).toBe(true);
    expect(packet.facts.every(fact => new TextEncoder().encode(JSON.stringify(fact)).byteLength <= 1800)).toBe(true);
  });

  it('keeps entirely unrepresentable accounting as context without authorizing an insight', async () => {
    const { store } = fixture({ finance: [{ currency: 'USD', state: 'reconciled', month: '2026-11-01', kind: 'revenue',
      family: null, isTotal: true, amount: '999999999999999999999999', entries: 1, recordedAt: now.toISOString(), currencyCount: 1, familyCount: 0 }] });
    const packet = await loadPortfolioBriefReadings(store, options);
    expect(packet.facts[0]!.data.accounting).toMatchObject({ revenueMinor: null, costMinor: null, netMinor: null });
    expect(packet.insightEvidenceIds).toEqual([]);
  });

  it('keeps completed-month comparisons separate from partial current accounting and pairs cost families without invented zeros', async () => {
    const base = { currency: 'JPY', state: 'reconciled', entries: 1, recordedAt: now.toISOString(), currencyCount: 1, familyCount: 2 };
    const finance = ['2026-09-01', '2026-10-01', '2026-11-01'].flatMap((month, index) => [
      { ...base, month, family: null, isTotal: true, kind: 'revenue', amount: String(1000 + index) },
      { ...base, month, family: null, isTotal: true, kind: 'cost', amount: String(100 + index) },
    ]);
    const { store } = fixture({ finance: [...finance,
      { ...base, month: '2026-09-01', family: 'hosting', isTotal: false, kind: 'cost', amount: '40' },
      { ...base, month: '2026-10-01', family: 'hosting', isTotal: false, kind: 'cost', amount: '60' },
      { ...base, month: '2026-10-01', family: 'contractors', isTotal: false, kind: 'cost', amount: '30' },
      { ...base, month: '2026-11-01', family: 'hosting', isTotal: false, kind: 'cost', amount: '99' },
    ] });
    const packet = await loadPortfolioBriefReadings(store, options);
    const completed = packet.facts.find(fact => fact.id.endsWith(':completed'))!;
    const current = packet.facts.find(fact => fact.id.endsWith(':current'))!;
    expect(completed.comparison).toMatchObject({ current: { start: '2026-10-01', end: '2026-10-31' }, previous: { start: '2026-09-01', end: '2026-09-30' } });
    expect(JSON.stringify(completed.data)).not.toContain('2026-11');
    expect(completed.data.costDrivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'hosting', previousMinor: 40, currentMinor: 60, changeMinor: 20 }),
      expect.objectContaining({ family: 'contractors', previousMinor: null, currentMinor: 30, changeMinor: null }),
    ]));
    expect(current.basis).toBe('current-state');
    expect(current.period).toBeNull();
    expect(current.data).toMatchObject({ accountingMonth: '2026-11', through: now.toISOString(), minorDigits: 0, accounting: { costMinor: 102 } });
  });

  it('rejects impossible dates and does not qualify future or invalid source observations', async () => {
    const { store } = fixture({ product: [
      { asset: 'invalid-date', generatedAt: now.toISOString(), product: product('2026-02-30') },
      { asset: 'future-source', generatedAt: now.toISOString(), product: { ...product('2026-11-05'), observedAt: '2026-11-07' } },
      { asset: 'invalid-source', generatedAt: now.toISOString(), product: { ...product('2026-11-05'), observedAt: 'yesterday' } },
    ] });
    const packet = await loadPortfolioBriefReadings(store, options);
    expect(packet.facts).toHaveLength(6);
    expect(packet.insightEvidenceIds).toEqual([]);
  });

  it('bounds changes and outcome text without making change chronology eligible', async () => {
    const { store } = fixture({ outcomes: [{ asset: 'example.com', id: 'check1', metric: 'clicks', integration: 'gsc', scope: null,
      ref: 'change1', registeredAt: now.toISOString(), nextCheckDate: '2026-11-06', readbackTask: 'sys-1', status: 'open', outcome: null,
      note: 'x'.repeat(5000), closedAt: null, total: 30 }], changes: [{ asset: 'example.com', id: 1, at: now.toISOString(), kind: 'release', ref: 'commit', note: 'y'.repeat(5000), total: 40 }] });
    const packet = await loadPortfolioBriefReadings(store, options);
    expect(packet.insightEvidenceIds).toEqual(['outcome:check1']);
    expect(packet.facts[0]!.data).toMatchObject({ totalMatchingWindows: 30, returnedWindows: 1, readbackTask: 'sys-1' });
    expect(packet.facts[1]!.data.note).toHaveLength(160);
  });
});
