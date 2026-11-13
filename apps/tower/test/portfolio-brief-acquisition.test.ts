// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStore } from '@noticeos/postgres';
import type { SignalTrend, SignalTrendSet } from '../shared/wall';
import { emptySignalTrendSet, loadSignalTrends } from '../worker/signal-trends';
import { loadPortfolioBriefAcquisition } from '../worker/portfolio-brief-acquisition';

vi.mock('../worker/signal-trends', async importOriginal => ({ ...await importOriginal<typeof import('../worker/signal-trends')>(), loadSignalTrends: vi.fn() }));
const now = new Date('2026-11-06T12:00:00.000Z');
const store = {} as WorkspaceStore;
const assets = [{ id: 'example.com', displayName: 'Example' }];
function trend(previous = 10, current = 20, timeZone = 'UTC'): SignalTrend {
  return { timeZone, collectedAt: now.toISOString(), provisionalFrom: null, timeZoneChanges: [],
    series: Array.from({ length: 14 }, (_, index) => ({ t: new Date(Date.UTC(2026, 9, 22 + index)).toISOString().slice(0, 10), v: index < 7 ? previous : current })) };
}
let set: SignalTrendSet;
const read = () => loadPortfolioBriefAcquisition(store, { now, assets });
beforeEach(() => {
  set = emptySignalTrendSet();
  set.webSearchClicks.google = trend();
  set.webSearchImpressions.google = trend(100, 100);
  vi.mocked(loadSignalTrends).mockImplementation(async () => new Map([['example.com', set]]));
});
describe('briefing acquisition comparisons', () => {
  it('uses canonical native-calendar trends and derives CTR from summed counts', async () => {
    const result = await read();
    expect(loadSignalTrends).toHaveBeenCalledWith(store, 14, { assets: ['example.com'], nowMs: now.getTime(), includeWebSearch: true, includeSecondarySeries: true });
    expect(result.insightEvidenceIds).toEqual(['acquisition:example.com:google']);
    expect(result.facts[0]).toMatchObject({ domain: 'acquisition', comparison: { current: { start: '2026-10-29', end: '2026-11-04' }, previous: { start: '2026-10-22', end: '2026-10-28' }, timeZone: 'UTC' },
      data: { provider: 'google', metrics: { clicks: { current: 140, previous: 70, changePercent: 100 }, impressions: { current: 700, previous: 700 }, ctr: { current: 0.2, previous: 0.1 } }, lagDays: 2 } });
    expect(new TextEncoder().encode(JSON.stringify(result.facts[0])).byteLength).toBeLessThanOrEqual(1_600);
  });
  it('keeps providers separate and accepts their distinct native calendars', async () => {
    set.webSearchClicks.bing = trend(2, 3, 'America/Los_Angeles');
    set.webSearchImpressions.bing = trend(20, 30, 'America/Los_Angeles');
    set.sessions = trend(50, 100, 'Europe/London');
    set.pageViews = trend(100, 300, 'Europe/London');
    const result = await read();
    expect(result.facts).toHaveLength(3);
    expect(result.facts.map(fact => fact.comparison!.timeZone)).toEqual(['UTC', 'America/Los_Angeles', 'Europe/London']);
    expect(result.facts[1]!.data).toMatchObject({ provider: 'bing', metrics: { clicks: { current: 21, previous: 14 } } });
    expect(result.facts[2]!.data).toMatchObject({ provider: 'ga4', metrics: { sessions: { current: 700, previous: 350 }, pageViews: { current: 2100, previous: 700 }, pageViewsPerSession: { current: 3, previous: 2 } } });
  });
  it('excludes partial provider windows without treating missing days as zero', async () => {
    set.webSearchImpressions.google.series.splice(4, 1);
    expect(await read()).toEqual({ facts: [], insightEvidenceIds: [] });
  });
  it('retains real zeros and leaves zero-denominator changes unknown', async () => {
    set.webSearchClicks.google = trend(0, 0);
    set.webSearchImpressions.google = trend(0, 100);
    const result = await read();
    expect(result.facts[0]!.data).toMatchObject({ metrics: { clicks: { current: 0, previous: 0, changePercent: null }, ctr: { current: 0, previous: null } } });
  });
  it.each(['provisional', 'estimated', 'timeZoneChange', 'mixedTimeZone'] as const)('excludes %s window contamination', async kind => {
    if (kind === 'provisional') set.webSearchClicks.google.provisionalFrom = '2026-11-04';
    if (kind === 'estimated') set.webSearchClicks.google.estimatedDates = ['2026-10-25'];
    if (kind === 'timeZoneChange') set.webSearchClicks.google.timeZoneChanges = [{ effectiveOn: '2026-10-29', from: 'UTC', to: 'Europe/London' }];
    if (kind === 'mixedTimeZone') set.webSearchImpressions.google.timeZone = 'Europe/London';
    expect((await read()).facts).toEqual([]);
  });
  it('keeps old measurement pairs as context and excludes future collection timestamps entirely', async () => {
    const moveEarlier = (value: SignalTrend) => { value.series = value.series.map(point => ({ ...point, t: new Date(Date.parse(point.t) - 10 * 86_400_000).toISOString().slice(0, 10) })); };
    moveEarlier(set.webSearchClicks.google); moveEarlier(set.webSearchImpressions.google);
    expect(await read()).toMatchObject({ facts: [expect.any(Object)], insightEvidenceIds: [] });
    set.webSearchClicks.google.collectedAt = new Date(now.getTime() + 1_000).toISOString();
    expect((await read()).facts).toEqual([]);
  });
  it('keeps unchanged pairs as context while allowing equal-growth pairs for model judgement', async () => {
    set.webSearchClicks.google = trend(10, 10);
    set.webSearchImpressions.google = trend(100, 100);
    expect(await read()).toMatchObject({ facts: [expect.any(Object)], insightEvidenceIds: [] });
    set.webSearchClicks.google = trend(10, 20);
    set.webSearchImpressions.google = trend(100, 200);
    expect((await read()).insightEvidenceIds).toEqual(['acquisition:example.com:google']);
  });
  it('ages acquisition evidence according to each provider’s collection schedule', async () => {
    set.webSearchClicks.bing = trend();
    set.webSearchImpressions.bing = trend(100, 100);
    const observed = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
    set.webSearchClicks.google.collectedAt = observed(1);
    set.webSearchClicks.bing.collectedAt = observed(25);
    expect((await read()).insightEvidenceIds).toEqual(['acquisition:example.com:google', 'acquisition:example.com:bing']);

    set.webSearchClicks.google.collectedAt = observed(3);
    expect((await read()).insightEvidenceIds).toEqual(['acquisition:example.com:bing']);

    set.webSearchClicks.bing.collectedAt = observed(49);
    expect(await read()).toMatchObject({ facts: [expect.any(Object), expect.any(Object)], insightEvidenceIds: [] });
  });
});
