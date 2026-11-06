// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefEvidenceSchema, portfolioBriefResultSchema } from '@noticeos/contract/portfolio-brief';
import type { AssetCard, WallPayload } from '../shared/wall';
import type { WorkItem, WorkPayload, WorkProject } from '../shared/work';
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
function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return { asset: 'example.com', prefix: 'ex', name: 'Example', ok: true, error: null, counts: { open: 0, ready: 0, blocked: 0, inProgress: 0, highPriority: null, closedRecent: 0, deferred: null, waiting: null }, history: { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] }, priorities: null, epics: null, ready: [], waiting: [], inProgress: [], deferred: [], recentlyClosed: [], ...overrides };
}
function task(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return { id, title: id, status: 'open', priority: 1, issueType: 'task', assignee: null, updatedAt: '2026-10-01T00:00:00Z',
    closedAt: null, parent: null, deferUntil: null, ...overrides };
}
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

  it('selects the newest earlier complete aligned window when the last revenue day is partial', () => {
    const site = asset();
    site.activeUsers.series.unshift({ t: '2026-10-05', v: 100 });
    const history = revenue();
    history.days.unshift({ date: '2026-10-05', amountMinor: 1000 });
    history.partialDates = ['2026-10-19'];
    const packet = buildPortfolioBriefEvidence(wall([site]), work, { revenueByAsset: new Map([[site.id, history]]) });
    const fact = packet.facts.find(item => item.id.endsWith(':traffic-revenue'))!;
    expect(fact.comparison).toEqual({ current: { start: '2026-10-12', end: '2026-10-18' }, previous: { start: '2026-10-05', end: '2026-10-11' }, timeZone: 'UTC' });
    expect(packet.insightEvidenceIds).toContain(fact.id);
    history.partialDates = ['2026-10-12', '2026-10-19'];
    expect(buildPortfolioBriefEvidence(wall([site]), work, { revenueByAsset: new Map([[site.id, history]]) }).facts.some(item => item.id.endsWith(':traffic-revenue'))).toBe(false);
    site.activeUsers.series.unshift({ t: '2026-10-04', v: 100 });
    history.days.unshift({ date: '2026-10-04', amountMinor: 1000 });
    history.partialDates = ['2026-10-18', '2026-10-19'];
    const old = buildPortfolioBriefEvidence(wall([site]), work, { revenueByAsset: new Map([[site.id, history]]) });
    expect(old.facts.find(item => item.id.endsWith(':traffic-revenue'))!.comparison!.current.end).toBe('2026-10-17');
    expect(old.insightEvidenceIds).not.toContain('asset:example.com:traffic-revenue');
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

  it('uses the source calendar for eligibility across a UTC midnight boundary', () => {
    const now = new Date('2026-10-20T22:30:00Z');
    const site = asset();
    site.activeUsers.collectedAt = now.toISOString();
    site.activeUsers.series = site.activeUsers.series.map(point => ({ ...point, t: shiftRevenueDate(point.t, -1) }));
    const history = revenue();
    history.days = history.days.map(day => ({ ...day, date: shiftRevenueDate(day.date, -1) }));
    history.reportedThrough = '2026-10-18';
    const generate = () => buildPortfolioBriefEvidence(wall([site]), work, { now, revenueByAsset: new Map([[site.id, history]]) });
    expect(generate().insightEvidenceIds).toContain('asset:example.com:traffic-revenue');
    site.activeUsers.timeZone = 'Europe/Paris';
    history.clock = { ...history.clock!, timeZone: 'Europe/Paris' };
    history.bySource = history.bySource!.map(source => ({ ...source, clock: { ...source.clock, timeZone: 'Europe/Paris' }, days: history.days }));
    const paris = generate();
    expect(paris.facts.find(fact => fact.id.endsWith(':traffic-revenue'))!.comparison!.timeZone).toBe('Europe/Paris');
    expect(paris.insightEvidenceIds).toEqual([]);
  });

  it('strictly encodes source and task links while retaining their original values', () => {
    const identity = "example !~*'()+ site";
    const taskId = "ex-!~*'()+ one";
    const held = project({ asset: identity, inProgress: [{ id: taskId, title: 'Improve checkout', status: 'in_progress', priority: 1, issueType: 'task', assignee: null, updatedAt: null, createdAt: null, closedAt: null, parent: null, deferUntil: null }] });
    const packet = buildPortfolioBriefEvidence(wall([asset(identity)]), { ...work, projects: [held] });
    const task = packet.facts.find(fact => fact.id.startsWith('task:'))!;
    const taskUrl = new URL(task.href, 'https://tower.example');
    expect(decodeURIComponent(taskUrl.pathname.split('/').at(-1)!)).toBe(taskId);
    expect(taskUrl.searchParams.get('project')).toBe(identity);
    expect(task.href).not.toMatch(/[!~*'()+]/);
    const source = packet.facts.find(fact => fact.id === `asset:${identity}:coverage`)!;
    expect(decodeURIComponent(source.href.split('/').at(-1)!)).toBe(identity);
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
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
    expect(buildPortfolioBriefEvidence(stale, work).insightEvidenceIds).toEqual(['asset:b.example:traffic']);
    for (const [current, previous] of [[100, 100]]) {
      const aligned = revenue();
      aligned.days = aligned.days.map((day, index) => ({ ...day, amountMinor: index < 7 ? previous! : current! }));
      aligned.bySource = aligned.bySource!.map(source => ({ ...source, days: aligned.days }));
      expect(buildPortfolioBriefEvidence(wall([asset('example.com', current, previous)]), work, { revenueByAsset: new Map([['example.com', aligned]]) }).insightEvidenceIds).toEqual([]);
    }
  });

  it.each([[200, 100], [50, 100], [100, 0], [0, 100]])('offers each fresh complete changed traffic comparison (%s versus %s) for judgment', (current, previous) => {
    const packet = buildPortfolioBriefEvidence(wall([asset('example.com', current, previous)]), work);
    expect(packet.insightEvidenceIds).toContain('asset:example.com:traffic');
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
  });

  it('offers proportional traffic and revenue changes without requiring a divergence', () => {
    const history = revenue();
    history.days = history.days.map((day, index) => ({ ...day, amountMinor: index < 7 ? 1000 : 2000 }));
    history.bySource = history.bySource!.map(source => ({ ...source, days: history.days }));
    const packet = buildPortfolioBriefEvidence(wall(), work, { revenueByAsset: new Map([['example.com', history]]) });
    expect(packet.insightEvidenceIds).toContain('asset:example.com:traffic');
    expect(packet.insightEvidenceIds).toContain('asset:example.com:traffic-revenue');
    expect(packet.facts.find(fact => fact.id.endsWith(':traffic-revenue'))!.data.changeGapPercentagePoints).toBe(0);
  });

  it('offers same-direction portfolio changes and keeps fresh individual evidence when another asset is stale or unmatched', () => {
    const data = wall([asset('a.example', 200, 100), asset('b.example', 300, 100)]);
    expect(buildPortfolioBriefEvidence(data, work).insightEvidenceIds).toEqual(['asset:a.example:traffic', 'asset:b.example:traffic', 'portfolio:traffic-divergence']);
    data.assets[1]!.activeUsers.collectedAt = '2026-10-01T00:00:00Z';
    expect(buildPortfolioBriefEvidence(data, work).insightEvidenceIds).toEqual(['asset:a.example:traffic']);
    data.assets[1]!.activeUsers.series = [];
    expect(buildPortfolioBriefEvidence(data, work).insightEvidenceIds).toEqual(['asset:a.example:traffic']);
  });

  it.each(['blocks', 'waits-for', 'conditional-blocks'])('offers fresh explicit sampled %s dependencies as current operational evidence', type => {
    const decision = task('ex-decision', { title: 'Choose the checkout flow' });
    const blocked = task('ex-build', { dependencies: [{ id: decision.id, type, status: 'open' }, { id: 'ex-other', type: 'blocks' }] });
    const packet = buildPortfolioBriefEvidence(wall([]), { ...work, capturedAt: NOW.toISOString(), projects: [project({ waiting: [decision], blocked: [blocked] })] });
    const fact = packet.facts.find(fact => fact.basis === 'task-dependency')!;
    expect(packet.insightEvidenceIds).toEqual([fact.id]);
    expect(fact.observedAt).toBe(NOW.toISOString());
    expect(fact.period).toBeNull();
    expect(fact.comparison).toBeUndefined();
    expect(fact.data.sampledBlockedDependentCount).toBe(1);
    expect(fact.data.sampledBlockedDependents).toEqual([expect.objectContaining({ id: blocked.id, dependencyType: type,
      otherBlockingDependencyIds: ['ex-other'], otherBlockingDependencyStatusesKnown: false })]);
    expect(fact.data.caution).toContain('does not establish that dependent tasks are ready');
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
  });

  it('does not infer operational evidence from task age, related links, closed or missing decisions, foreign projects or stale snapshots', () => {
    const decision = task('ex-decision');
    const dependent = task('ex-build', { dependencies: [{ id: decision.id, type: 'blocks', status: 'open' }] });
    const source = project({ waiting: [decision], blocked: [dependent] });
    const scenarios: WorkPayload[] = [
      { ...work, capturedAt: null, projects: [source] },
      { ...work, capturedAt: '2026-10-20T11:00:00Z', projects: [source] },
      { ...work, capturedAt: '2026-10-21T12:00:00Z', projects: [source] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, ok: false }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, waiting: [] }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, waiting: [{ ...decision, status: 'closed' }] }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, blocked: [{ ...dependent, status: 'closed' }] }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, blocked: [{ ...dependent, dependencies: [{ id: decision.id, type: 'related' }] }] }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, blocked: [{ ...dependent, dependencies: [{ id: decision.id, type: 'blocks', status: 'closed' }] }] }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, blocked: [{ ...dependent, dependencies: undefined }] }] },
      { ...work, capturedAt: NOW.toISOString(), projects: [{ ...source, blocked: [] }, project({ asset: 'other.example', blocked: [dependent] })] },
    ];
    for (const snapshot of scenarios) expect(buildPortfolioBriefEvidence(wall([]), snapshot).insightEvidenceIds).toEqual([]);
  });

  it('offers current delivery counts only from fresh nonfuture project snapshots', () => {
    const active = project();
    active.counts = { ...active.counts, open: 8, inProgress: 2, blocked: 3, waiting: 1, closedRecent: 4 };
    const fresh = buildPortfolioBriefEvidence(wall([]), { ...work, capturedAt: NOW.toISOString(), projects: [active] });
    const id = 'work:example.com:progress';
    expect(fresh.insightEvidenceIds).toContain(id);
    expect(fresh.facts.find(fact => fact.id === id)).toMatchObject({ domain: 'delivery', basis: 'current-state', observedAt: NOW.toISOString(), period: null,
      data: { counts: active.counts, weeklyProgress: null } });
    for (const capturedAt of [null, '2026-10-20T11:00:00Z', '2026-10-21T12:00:00Z']) {
      const packet = buildPortfolioBriefEvidence(wall([]), { ...work, capturedAt, projects: [active] });
      expect(packet.insightEvidenceIds).not.toContain(id);
      expect(packet.facts.find(fact => fact.id === id)).not.toHaveProperty('basis');
    }
    const unread = buildPortfolioBriefEvidence(wall([]), { ...work, capturedAt: NOW.toISOString(), projects: [{ ...active, ok: false }] });
    expect(unread.facts.some(fact => fact.id === id)).toBe(false);
  });

  it('offers recent operational failures while retaining old failed runs only as coverage context', () => {
    const data = wall([]);
    const old = { job: 'old-job', outcome: 'failed' as const, startedAt: '2026-10-01T12:00:00Z', lastRanAt: null, failedRuns: 2, failingSince: '2026-10-01T12:00:00Z' };
    const recent = { ...old, job: 'recent-job', startedAt: '2026-10-20T11:00:00Z' };
    const future = { ...old, job: 'future-job', startedAt: '2026-10-21T12:00:00Z' };
    data.system.scheduledLanes = [old, recent, future];
    const packet = buildPortfolioBriefEvidence(data, work);
    expect(packet.insightEvidenceIds).toContain('operations:recent');
    const current = packet.facts.find(fact => fact.id === 'operations:recent')!;
    expect(current).toMatchObject({ domain: 'operations', basis: 'current-state', observedAt: NOW.toISOString(), period: null });
    expect(current.data.failedJobs).toEqual([recent]);
    expect(current.data.omittedFailures).toBe(2);
    expect(packet.facts.find(fact => fact.id === 'system:coverage')!.data.failedJobs).toHaveLength(3);
    data.system.scheduledLanes = [old, future];
    expect(buildPortfolioBriefEvidence(data, work).insightEvidenceIds).not.toContain('operations:recent');
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

  it('compacts oversized protected facts while retaining failure and unread-project coverage', () => {
    const data = wall([]);
    data.system.ingest = { expected: 3, fresh: 1, stale: 2, notExpected: 0 };
    data.system.scheduledLanes = [{ job: '名'.repeat(40_000), outcome: 'failed', startedAt: NOW.toISOString(), lastRanAt: null, failedRuns: 2, failingSince: NOW.toISOString() }];
    const packet = buildPortfolioBriefEvidence(data, { ...work, projects: [project({ name: '名'.repeat(40_000) }), project({ asset: '名'.repeat(40_000), ok: false })] });
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(PORTFOLIO_BRIEF_MAX_BYTES);
    expect(packet.facts.find(fact => fact.id === 'work:coverage')!.data).toMatchObject({ projectCount: 2, readableProjectCount: 1, unreadProjectCount: 1, omittedProjectDetails: 1, omittedUnreadProjectNames: 1 });
    expect(packet.facts.find(fact => fact.id === 'system:coverage')!.data).toMatchObject({ reporting: data.system.ingest, failedJobCount: 1, omittedFailedJobs: 1 });
    expect(packet.limitations.every(value => value.trim().length > 0)).toBe(true);
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
  });
});
