// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefEvidenceSchema, portfolioBriefResultSchema } from '@noticeos/contract/portfolio-brief';
import type { AssetCard, WallPayload } from '../shared/wall';
import type { WorkPayload, WorkProject } from '../shared/work';
import type { DailyRevenueHistory } from '../shared/daily-revenue';
import { buildPortfolioBriefEvidence } from '../worker/portfolio-brief-evidence';
import { shiftRevenueDate } from '../shared/revenue-projection';

const NOW = new Date('2026-10-20T12:00:00Z');
const zero = { currency: 'USD', revenue: 0, cost: 0, net: 0 };
function asset(id = 'example.com', current = 200, previous = 100): AssetCard {
  const signal = { series: Array.from({ length: 14 }, (_, index) => ({ t: shiftRevenueDate('2026-10-19', index - 13), v: index < 7 ? previous : current })), provisionalFrom: null, collectedAt: NOW.toISOString(), timeZone: 'UTC', timeZoneChanges: [] };
  return {
    id, displayName: id, status: 'live', senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: zero, forecast: zero, netPeriod: '2026-10', pulseReceivedAt: null, firstReportAt: null,
    dataSources: [], work: null, activeUsers: signal, searchClicks: { ...signal, series: [] },
    netByMonth: [], netByMonthCurrency: 'USD', netByMonthProvisionalFrom: '2026-10', panelReview: null, latestPanelDate: null,
  };
}
function wall(assets = [asset()]): WallPayload {
  return { generatedAt: NOW.toISOString(), osTimeZone: 'UTC', assets, ledgerRecordedAt: null, attention: [], snoozed: [], operator: null,
    portfolio: { period: '2026-10', periodIsCurrent: true, booked: zero, forecast: zero, firstRun: true, daysIn: 1, bookedDelta: null, residue: { booked: zero, forecast: zero }, netTrend: [], netTrendAll: [], netTrendCurrency: null, netTrendAllCurrency: null, trendGranularity: 'monthly' },
    system: { assetId: null, hasPulse: false, spendTodayUsd: 0, dailyCapUsd: 0, ingest: { expected: 0, fresh: 0, stale: 0, notExpected: 0 }, scheduledLanes: [] },
    dashboard: {} as WallPayload['dashboard'],
  };
}
const work: WorkPayload = { generatedAt: NOW.toISOString(), capturedAt: null, pollCadenceHours: 1 / 60, owner: 'config/beads.json', projects: [], archivedProjects: [], historyDays: 0 };
function revenue(): DailyRevenueHistory {
  const clock = { timeZone: 'UTC', label: 'UTC', readyAfterMinute: 0 };
  const days = Array.from({ length: 14 }, (_, index) => ({ date: shiftRevenueDate('2026-10-19', index - 13), amountMinor: index < 7 ? 1000 : 500 }));
  return { from: '2026-10-06', to: '2026-10-19', reportedThrough: '2026-10-19', partialDates: [], clock, days,
    bySource: [{ source: 'ads', provider: 'example-provider', family: 'ads', displayName: 'Ad revenue', currency: 'USD', since: '2026-10-06', clock, days, reportedThrough: '2026-10-19' }],
  };
}

describe('portfolio briefing evidence', () => {
  it('keeps collection failures and reporting gaps beside the business readings', () => {
    const data = wall();
    data.system.ingest = { expected: 3, fresh: 1, stale: 2, notExpected: 0 };
    data.system.scheduledLanes = [{ job: 'traffic', outcome: 'failed', startedAt: NOW.toISOString(), lastRanAt: null, failedRuns: 3, failingSince: '2026-10-19T12:00:00Z' }];
    const fact = buildPortfolioBriefEvidence(data, work).facts.find(item => item.id === 'system:coverage')!;
    expect(fact.observedAt).toBeNull();
    expect(fact.data.reporting).toEqual(data.system.ingest);
    expect(fact.data.failedJobs).toEqual([{ job: 'traffic', startedAt: NOW.toISOString(), lastRanAt: null, failedRuns: 3, failingSince: '2026-10-19T12:00:00Z' }]);
  });
  it('exposes traffic/revenue divergence only on complete aligned source days', () => {
    const packet = buildPortfolioBriefEvidence(wall(), work, { revenueByAsset: new Map([['example.com', revenue()]]) });
    const fact = packet.facts.find(item => item.id.endsWith(':traffic-revenue'))!;
    expect(fact.period).toEqual({ start: '2026-10-06', end: '2026-10-19' });
    expect(fact.comparison).toEqual({ current: { start: '2026-10-13', end: '2026-10-19' }, previous: { start: '2026-10-06', end: '2026-10-12' }, timeZone: 'UTC' });
    expect(fact.data.changeGapPercentagePoints).toBe(-150);
    expect(fact.data.revenueCurrency).toBe('USD');
    expect(fact.data.revenueFamilies).toEqual(['ads']);
    expect(fact.data.trafficMetric).toBe('daily active users summed over days; not unique weekly people');
    expect(fact.data.monetaryUnit).toBe('minor currency units');
    expect(fact.data.currencyMinorDigits).toBe(2);
    expect(packet.insightEvidenceIds).toContain('asset:example.com:traffic-revenue');
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
    for (const changed of [{ ...revenue(), partialDates: ['2026-10-12'] }, { ...revenue(), clock: { timeZone: 'America/New_York', label: 'Eastern', readyAfterMinute: 0 } }]) {
      expect(buildPortfolioBriefEvidence(wall(), work, { revenueByAsset: new Map([['example.com', changed]]) }).facts.some(item => item.id.endsWith(':traffic-revenue'))).toBe(false);
    }
  });

  it('does not compare holes, provisional dates or estimated calendar days', () => {
    for (const alter of [
      (site: AssetCard) => { site.activeUsers.series.splice(3, 1); },
      (site: AssetCard) => { site.activeUsers.provisionalFrom = '2026-10-12'; },
      (site: AssetCard) => { site.activeUsers.estimatedDates = ['2026-10-12']; },
      (site: AssetCard) => { site.activeUsers.timeZoneChanges = [{ effectiveOn: '2026-10-12', from: 'UTC', to: 'America/New_York' }]; },
    ]) {
      const site = asset(); alter(site);
      expect(buildPortfolioBriefEvidence(wall([site]), work).facts.some(item => item.id.endsWith(':traffic'))).toBe(false);
    }
  });

  it('uses the actual source currency and rejects missing or mixed source metadata', () => {
    const euros = revenue();
    euros.bySource = euros.bySource!.map(source => ({ ...source, currency: 'EUR' }));
    expect(buildPortfolioBriefEvidence(wall(), work, { revenueByAsset: new Map([['example.com', euros]]) }).facts.find(item => item.id.endsWith(':traffic-revenue'))!.data.revenueCurrency).toBe('EUR');
    const base = revenue();
    const source = base.bySource![0]!;
    for (const changed of [
      { ...base, bySource: undefined },
      { ...base, bySource: [] },
      { ...base, bySource: [source, { ...source, source: 'sales', currency: 'EUR' }] },
      { ...base, bySource: [source, { ...source, source: 'sales', clock: { ...source.clock, timeZone: 'America/New_York' } }] },
    ]) {
      expect(buildPortfolioBriefEvidence(wall(), work, { revenueByAsset: new Map([['example.com', changed]]) }).facts.some(item => item.id.endsWith(':traffic-revenue'))).toBe(false);
    }
  });

  it('makes growth masking weaker assets visible on a common full window', () => {
    const packet = buildPortfolioBriefEvidence(wall([asset('a.example', 300, 100), asset('b.example', 50, 100)]), work);
    const comparison = packet.facts.find(item => item.id === 'portfolio:traffic-divergence')!;
    expect(comparison.data.changePercent).toBe(75);
    expect(comparison.comparison).toEqual({ current: { start: '2026-10-13', end: '2026-10-19' }, previous: { start: '2026-10-06', end: '2026-10-12' }, timeZone: 'UTC' });
    expect(comparison.data.decliningAssets).toBe(1);
    expect(packet.insightEvidenceIds).toContain('portfolio:traffic-divergence');
    expect((comparison.data.assets as { currentShare: number }[])[0]!.currentShare).toBeCloseTo(6 / 7);
  });

  it('uses the source reporting calendar and computed windows rather than collection dates', () => {
    const data = wall([asset('a.example', 300, 100), asset('b.example', 50, 100)]);
    for (const site of data.assets) site.activeUsers.timeZone = 'Europe/Paris';
    const history = revenue();
    history.clock = { ...history.clock!, timeZone: 'Europe/Paris' };
    history.bySource = history.bySource!.map(source => ({ ...source, clock: { ...source.clock, timeZone: 'Europe/Paris' } }));
    const packet = buildPortfolioBriefEvidence(data, work, { revenueByAsset: new Map([['a.example', history]]) });
    for (const id of ['asset:a.example:traffic-revenue', 'portfolio:traffic-divergence']) {
      expect(packet.insightEvidenceIds).toContain(id);
      expect(packet.facts.find(fact => fact.id === id)!.comparison).toEqual({
        current: { start: '2026-10-13', end: '2026-10-19' },
        previous: { start: '2026-10-06', end: '2026-10-12' }, timeZone: 'Europe/Paris',
      });
    }
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
    expect(data.assets[0]!.activeUsers.collectedAt).toBe('2026-10-20T12:00:00.000Z');
  });

  it('keeps unavailable projects unknown rather than reporting empty queues', () => {
    const project: WorkProject = { asset: 'example.com', prefix: 'ex', name: 'Example', ok: false, error: 'unavailable', counts: { open: 0, ready: 0, blocked: 0, inProgress: 0, highPriority: null, closedRecent: 0, deferred: null, waiting: null }, history: { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] }, priorities: null, epics: null, ready: [], waiting: [], inProgress: [], deferred: [], recentlyClosed: [] };
    const packet = buildPortfolioBriefEvidence(wall(), { ...work, projects: [project] });
    expect(packet.coverage.readableProjects).toBe(0);
    expect(packet.facts.find(item => item.id === 'work:coverage')!.data.unreadProjects).toEqual(['example.com']);
    expect(packet.facts.find(item => item.id === 'work:coverage')!.data.projects).toEqual([]);
    expect(packet.limitations.join(' ')).toContain('closure does not establish a business outcome');
    project.ok = true;
    project.inProgress = [{ id: 'ex-1', title: 'Improve checkout', status: 'in_progress', priority: 1, issueType: 'task', assignee: 'agent', updatedAt: '2026-10-10T12:00:00Z', createdAt: '2026-09-01T12:00:00Z', closedAt: null, parent: null, deferUntil: null }];
    const taskFact = buildPortfolioBriefEvidence(wall(), { ...work, capturedAt: NOW.toISOString(), projects: [project] }).facts.find(item => item.id === 'task:example.com:ex-1')!;
    expect(taskFact.href).toBe('/tasks/ex-1?project=example.com');
    expect(taskFact.data.daysSinceUpdate).toBe(10);
    expect(taskFact.data.caution).toContain('not time in current status');
  });

  it('does not make an old reporting period current after a recent collection', () => {
    const site = asset();
    site.activeUsers.series = site.activeUsers.series.map(point => ({ ...point, t: shiftRevenueDate(point.t, -30) }));
    const fact = buildPortfolioBriefEvidence(wall([site]), work).facts.find(item => item.id === 'asset:example.com:coverage')!;
    expect(fact.data.trafficCollectionStale).toBe(false);
    expect(fact.data.trafficReportingLagDays).toBe(31);
  });

  it('does not infer a revenue concentration from missing ledger revenue', () => {
    const data = wall();
    data.portfolio.firstRun = false;
    data.portfolio.booked = { ...zero, revenue: 100, net: 100 };
    data.assets[0]!.booked = { currency: null, revenue: null, cost: null, net: null };
    expect(buildPortfolioBriefEvidence(data, work).facts.some(item => item.id === 'portfolio:concentration')).toBe(false);
  });

  it('preserves cost-only and unknown revenue coverage rather than asserting recorded zero revenue', () => {
    const data = wall();
    data.portfolio.firstRun = false;
    data.portfolio.booked = { currency: 'USD', revenue: 0, cost: 50, net: -50 };
    data.portfolio.revenueRecorded = { booked: false, forecast: false };
    data.assets[0]!.netByMonth = [{ t: '2026-09', v: 120 }, { t: '2026-10', v: 20 }];
    const packet = buildPortfolioBriefEvidence(data, work);
    const portfolio = packet.facts.find(item => item.id === 'portfolio:ledger')!;
    expect(portfolio.data.reconciledAccounting).toMatchObject({ revenue: null, cost: 50, revenueAvailability: 'No revenue entry is recorded.' });
    expect(portfolio.data).not.toHaveProperty('revenueRecorded');
    expect(portfolio.data).not.toHaveProperty('firstRun');
    expect(portfolio.data.monetaryUnit).toBe('major currency units');
    const assetLedger = packet.facts.find(item => item.id === 'asset:example.com:ledger')!;
    expect(assetLedger.data.reconciledAccounting).toBeNull();
    expect(assetLedger.data.caution).toContain('not measured zero revenue');
    expect(assetLedger.data.historicalNetMonths).toEqual([{ t: '2026-09', v: 120 }]);
    expect(assetLedger.data.historicalNetClassification).toContain('reconciled entries and estimates');
    delete data.portfolio.revenueRecorded;
    expect(buildPortfolioBriefEvidence(data, work).facts.find(item => item.id === 'portfolio:ledger')!.data.reconciledAccounting).toMatchObject({ revenue: null, revenueAvailability: 'Revenue entry availability is unknown.' });
    data.portfolio.booked = zero;
    data.portfolio.revenueRecorded = { booked: true, forecast: false };
    expect(buildPortfolioBriefEvidence(data, work).facts.find(item => item.id === 'portfolio:ledger')!.data.reconciledAccounting).toMatchObject({ revenue: 0, revenueAvailability: 'A revenue entry is recorded.' });
  });

  it('does not promote missing data, static concentration, flat readings or old windows into insights', () => {
    const missing = asset();
    missing.activeUsers.series = [];
    const unknown = buildPortfolioBriefEvidence(wall([missing]), work);
    expect(unknown.insightEvidenceIds).toEqual([]);
    expect(unknown.facts.some(fact => fact.id.endsWith(':ledger'))).toBe(false);
    const staticData = wall([asset('a.example', 100, 100), asset('b.example', 100, 100)]);
    staticData.portfolio.booked = { ...zero, revenue: 100, net: 100 };
    staticData.assets[0]!.booked = { ...zero, revenue: 99, net: 99 };
    staticData.assets[1]!.booked = { ...zero, revenue: 1, net: 1 };
    const staticPacket = buildPortfolioBriefEvidence(staticData, work);
    expect(staticPacket.facts.some(fact => fact.id === 'portfolio:concentration')).toBe(false);
    expect(staticPacket.insightEvidenceIds).toEqual([]);
    const old = wall([asset('a.example', 300, 100), asset('b.example', 50, 100)]);
    for (const site of old.assets) site.activeUsers.series = site.activeUsers.series.map(point => ({ ...point, t: shiftRevenueDate(point.t, -30) }));
    expect(buildPortfolioBriefEvidence(old, work).insightEvidenceIds).toEqual([]);
    const stale = wall([asset('a.example', 300, 100), asset('b.example', 50, 100)]);
    stale.assets[0]!.activeUsers.collectedAt = '2026-10-19T00:00:00Z';
    expect(buildPortfolioBriefEvidence(stale, work).insightEvidenceIds).toEqual([]);
    for (const [current, previous] of [[100, 100], [50, 100]]) {
      const aligned = revenue();
      aligned.days = aligned.days.map((day, index) => ({ ...day, amountMinor: index < 7 ? previous! : current! }));
      aligned.bySource = aligned.bySource!.map(source => ({ ...source, days: aligned.days }));
      expect(buildPortfolioBriefEvidence(wall([asset('example.com', current, previous)]), work, { revenueByAsset: new Map([['example.com', aligned]]) }).insightEvidenceIds).toEqual([]);
    }
  });

  it('retains immutable insight editions without making every finding current', () => {
    const site = asset();
    site.findings = [{ key: 'search-decline', kind: 'warning', title: 'Organic search is declining' }];
    site.insightSource = {
      snapshotId: 'snapshot-1', generatedAt: NOW.toISOString(), windowStart: '2026-09-01', windowEnd: '2026-09-30',
    };
    const packet = buildPortfolioBriefEvidence(wall([site]), work);
    const fact = packet.facts.find(item => item.id.endsWith(':signals'))!;
    expect(fact.period).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(fact.data.sourceSnapshot).toHaveProperty('snapshotId', 'snapshot-1');
    expect(fact.data.caution).toContain('not necessarily every finding');
  });

  it('bounds asset detail and rejects excessive output or foreign evidence links', () => {
    const packet = buildPortfolioBriefEvidence(wall(Array.from({ length: 45 }, (_, index) => asset(`${index}.example`))), work);
    expect(packet.coverage.includedAssets).toBe(40);
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
    expect(portfolioBriefEvidenceSchema.safeParse({ ...packet, facts: [{ ...packet.facts[0], href: '//example.com' }] }).success).toBe(false);
    expect(portfolioBriefResultSchema.safeParse({ headline: 'No new conclusion', assessment: 'The available observations do not support a new decision.', insights: [] }).success).toBe(true);
    expect(portfolioBriefResultSchema.safeParse({ headline: 'Review', assessment: 'word '.repeat(300), insights: [] }).success).toBe(false);
  });

  it('bounds UTF8 bytes and discloses facts omitted by the packet budget', () => {
    const data = wall(Array.from({ length: 40 }, (_, index) => {
      const site = asset(`${index}.example`);
      site.displayName = '名'.repeat(220);
      site.findings = Array.from({ length: 3 }, (_, number) => ({ key: String(number), kind: 'insight', title: '名'.repeat(240) }));
      return site;
    }));
    const packet = buildPortfolioBriefEvidence(data, work);
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(PORTFOLIO_BRIEF_MAX_BYTES);
    expect(packet.limitations.join(' ')).toContain('facts were omitted');
    expect(packet.facts.some(fact => fact.id === 'work:coverage')).toBe(true);
    expect(packet.facts.some(fact => fact.id === 'portfolio:traffic-divergence')).toBe(true);
    expect(packet.insightEvidenceIds.every(id => packet.facts.some(fact => fact.id === id))).toBe(true);
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
  });
});
