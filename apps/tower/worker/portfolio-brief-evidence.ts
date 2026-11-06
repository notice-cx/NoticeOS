import { PORTFOLIO_BRIEF_MAX_BYTES, type PortfolioBriefEvidence, type PortfolioBriefFact } from '@noticeos/contract/portfolio-brief';
import { calendarDateIn, type DailyRevenueHistory } from '../shared/daily-revenue';
import { shiftRevenueDate } from '../shared/revenue-projection';
import { isAmber } from '../shared/freshness';
import { CADENCE_HOURS, windowSpansTimeZoneChange, type AssetCard, type SignalTrend, type WallPayload } from '../shared/wall';
import type { WorkPayload } from '../shared/work';
import { currencyMinorDigits } from '@noticeos/contract/money';

const ASSET_LIMIT = 40;
const ALERT_LIMIT = 20;
const TASK_LIMIT = 20;
const DAY = 86_400_000;
const change = (current: number, previous: number) => previous > 0 ? (current - previous) / previous * 100 : null;
const clip = (value: string, length = 240) => value.slice(0, length);
const siteHref = (id: string) => `/assets/${encodeURIComponent(id)}`;

function accounting(figure: AssetCard['booked'], recorded?: boolean) {
  if (figure.currency === null || (recorded !== true && !figure.revenue && !figure.cost)) return null;
  return {
    currency: figure.currency,
    revenue: recorded === true || figure.revenue !== 0 ? figure.revenue : null,
    cost: figure.cost !== 0 ? figure.cost : null,
    net: figure.net,
    revenueAvailability: recorded === true || figure.revenue !== 0 ? 'A revenue entry is recorded.' : recorded === false ? 'No revenue entry is recorded.' : 'Revenue entry availability is unknown.',
  };
}

function currentComparison(asset: AssetCard, end: string, now: Date): boolean {
  if (!asset.activeUsers.timeZone || isAmber(now.getTime(), asset.activeUsers.collectedAt, CADENCE_HOURS.signals)) return false;
  const today = calendarDateIn(asset.activeUsers.timeZone)(now);
  // GA4 collection leaves today and yesterday provisional (`ga4ProvisionalFrom`).
  // An older complete window remains context rather than a current insight.
  return end < today && end >= shiftRevenueDate(today, -2);
}

interface WindowComparison {
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
  current: number;
  previous: number;
  changePercent: number | null;
}

function compareDays(values: ReadonlyMap<string, number>, end: string): WindowComparison | null {
  const dates = Array.from({ length: 14 }, (_, index) => shiftRevenueDate(end, index - 13));
  if (dates.some(date => !values.has(date))) return null;
  const previous = dates.slice(0, 7).reduce((sum, date) => sum + values.get(date)!, 0);
  const current = dates.slice(7).reduce((sum, date) => sum + values.get(date)!, 0);
  return { start: dates[7]!, end, previousStart: dates[0]!, previousEnd: dates[6]!, current, previous, changePercent: change(current, previous) };
}

function settledTraffic(trend: SignalTrend): Map<string, number> {
  const estimated = new Set(trend.estimatedDates ?? []);
  return new Map([...(trend.contextSeries ?? []), ...trend.series]
    .filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.t) && Number.isFinite(point.v) && point.v >= 0 &&
      (trend.provisionalFrom === null || point.t < trend.provisionalFrom) && !estimated.has(point.t))
    .map(point => [point.t, point.v]));
}

function trafficComparison(asset: AssetCard, end?: string): WindowComparison | null {
  const values = settledTraffic(asset.activeUsers);
  const through = end ?? [...values.keys()].sort().at(-1);
  if (!through) return null;
  const comparison = compareDays(values, through);
  return comparison && !windowSpansTimeZoneChange(asset.activeUsers.timeZoneChanges, { start: comparison.previousStart, end: through }) ? comparison : null;
}

/** Stored observations only. A capped sample never becomes a complete task or
 * source inventory, and source publication time never substitutes for its period. */
export function buildPortfolioBriefEvidence(
  wall: WallPayload,
  work: WorkPayload,
  options: { now?: Date; revenueByAsset?: ReadonlyMap<string, DailyRevenueHistory> } = {},
): PortfolioBriefEvidence {
  const now = options.now ?? new Date(wall.generatedAt);
  const facts: PortfolioBriefFact[] = [];
  const insightEvidenceIds: string[] = [];
  const limitations = [
    'Comparisons describe observed changes, not causes or measured effects of completed tasks.',
    'Task rows are saved samples; counts cover successful project snapshots. Task closure does not establish a business outcome.',
    'Booked ledger figures are reconciled; forecast ledger figures, provider daily revenue and projections are estimates. Zero ledger figures do not establish recorded zero revenue.',
  ];
  const add = (id: string, label: string, href: string, observedAt: string | null, data: Record<string, unknown>, period: PortfolioBriefFact['period'] = null) => {
    facts.push({ id, label: clip(label), href, observedAt, period, data });
  };
  const assets = [...wall.assets].sort((a, b) => a.id.localeCompare(b.id)).slice(0, ASSET_LIMIT);
  const booked = accounting(wall.portfolio.booked, wall.portfolio.revenueRecorded?.booked);
  const estimated = accounting(wall.portfolio.forecast, wall.portfolio.revenueRecorded?.forecast);
  if (booked || estimated || wall.portfolio.bookedDelta) add('portfolio:ledger', 'Portfolio accounting', '/financials', wall.ledgerRecordedAt, {
    period: wall.portfolio.period, periodIsCurrent: wall.portfolio.periodIsCurrent,
    reconciledAccounting: booked, estimatedAccounting: estimated,
    monetaryUnit: 'major currency units',
    bookedDelta: wall.portfolio.bookedDelta,
    caution: 'Amounts are recorded accounting only. A missing revenue entry is not measured zero revenue or a contradiction. Portfolio entries do not establish complete coverage for every asset.',
  });
  const failedJobs = wall.system.scheduledLanes.filter(job => job.outcome === 'failed');
  add('system:coverage', 'Reporting coverage and failed background jobs', '/health', null, {
    reporting: wall.system.ingest,
    failedJobs: failedJobs.slice(0, 20).map(job => ({ job: job.job, startedAt: job.startedAt, lastRanAt: job.lastRanAt, failedRuns: job.failedRuns, failingSince: job.failingSince })),
    omittedFailedJobs: Math.max(0, failedJobs.length - 20),
    backupLastGoodAt: wall.system.backupLastGoodAt ?? null,
    caution: 'These are saved observations, not proof that a service is running now. Reporting gaps limit conclusions about business changes.',
  });
  for (const asset of assets) {
    const prefix = `asset:${asset.id}`;
    const href = siteHref(asset.id);
    const traffic = trafficComparison(asset);
    const insightSource = asset.insightSource;
    const trafficEnd = [...settledTraffic(asset.activeUsers).keys()].sort().at(-1) ?? null;
    add(`${prefix}:coverage`, `${asset.displayName}: available evidence`, href, asset.activeUsers.collectedAt, {
      trafficThrough: trafficEnd,
      trafficCollectionStale: isAmber(now.getTime(), asset.activeUsers.collectedAt, CADENCE_HOURS.signals),
      trafficReportingLagDays: trafficEnd ? Math.max(0, Math.floor((now.getTime() - Date.parse(`${trafficEnd}T00:00:00Z`)) / DAY)) : null,
      revenueThrough: asset.revenueProjection?.reportedThrough ?? asset.dailyRevenue?.reportedThrough ?? null,
      reportReceivedAt: asset.pulseReceivedAt,
      findingsHaveSourcePeriods: Boolean(insightSource?.windowStart && insightSource?.windowEnd),
    });
    const assetAccounting = accounting(asset.booked);
    const historicalNetMonths = asset.netByMonth.filter(point => point.v !== null && (asset.netByMonthProvisionalFrom === null || point.t < asset.netByMonthProvisionalFrom)).slice(-3);
    if (assetAccounting || historicalNetMonths.length) add(`${prefix}:ledger`, `${asset.displayName}: accounting`, href, wall.ledgerRecordedAt, {
      period: asset.netPeriod, reconciledAccounting: assetAccounting,
      monetaryUnit: 'major currency units',
      historicalNetMonths,
      historicalNetClassification: 'current ledger rows, including reconciled entries and estimates; excludes the open accounting month',
      currency: asset.netByMonthCurrency,
      caution: 'Asset revenue-entry coverage is unavailable. Missing amounts are not measured zero revenue or a contradiction.',
    });
    if (asset.product || asset.findings?.length || asset.watches) add(`${prefix}:signals`, `${asset.displayName}: stored findings and outcome checks`, href, insightSource?.generatedAt ?? asset.product?.observedAt ?? null, {
      sourceSnapshot: insightSource ?? null,
      product: asset.product ? { speed: asset.product.speed, errors: asset.product.errors, errorPeople: asset.product.errorPeople, funnel: asset.product.funnel ? { name: asset.product.funnel.name, largestDrop: asset.product.funnel.largestDrop } : null } : null,
      findings: asset.findings?.slice(0, 3).map(finding => ({ key: clip(finding.key), kind: finding.kind, title: clip(finding.title) })) ?? [],
      watches: asset.watches ?? null,
      caution: insightSource ? 'The edition reporting window covers its combined source archives, not necessarily every finding. Publication time does not establish observation freshness; findings alone do not prove current impact.' : 'Finding reporting periods are absent from this read model. Publication time does not establish observation freshness; findings alone do not prove current impact.',
    }, insightSource?.windowStart && insightSource.windowEnd ? { start: insightSource.windowStart, end: insightSource.windowEnd } : null);
    if (traffic) add(`${prefix}:traffic`, `${asset.displayName}: complete seven-day traffic comparison`, href, asset.activeUsers.collectedAt,
      { ...traffic, metric: 'daily active users summed over days; not unique weekly people', timeZone: asset.activeUsers.timeZone ?? null }, { start: traffic.previousStart, end: traffic.end });
    const revenue = options.revenueByAsset?.get(asset.id);
    const currency = revenue?.bySource?.[0]?.currency;
    const compatibleSources = Boolean(currency && revenue?.bySource?.length && revenue.bySource.every(source =>
      source.currency === currency && source.clock.timeZone === revenue.clock?.timeZone && source.clock.timeZone === asset.activeUsers.timeZone));
    if (compatibleSources && revenue?.clock && revenue.clock.timeZone === asset.activeUsers.timeZone && revenue.reportedThrough && revenue.partialDates !== undefined) {
      const end = [revenue.reportedThrough, trafficEnd].filter((value): value is string => value !== null).sort()[0]!;
      const alignedTraffic = trafficComparison(asset, end);
      const partial = new Set(revenue.partialDates);
      const revenueDays = new Map(revenue.days.filter(day => !partial.has(day.date)).map(day => [day.date, day.amountMinor]));
      const money = compareDays(revenueDays, end);
      if (alignedTraffic && money) add(`${prefix}:traffic-revenue`, `${asset.displayName}: traffic and revenue on matching complete days`, href, asset.activeUsers.collectedAt, {
        timeZone: revenue.clock.timeZone, traffic: alignedTraffic, revenueMinor: money,
        revenuePerDailyUserMinor: alignedTraffic.current > 0 ? money.current / alignedTraffic.current : null,
        previousRevenuePerDailyUserMinor: alignedTraffic.previous > 0 ? money.previous / alignedTraffic.previous : null,
        changeGapPercentagePoints: money.changePercent !== null && alignedTraffic.changePercent !== null ? money.changePercent - alignedTraffic.changePercent : null,
        revenueClassification: 'provider estimate',
        revenueFamilies: [...new Set(revenue.bySource!.map(source => source.family))],
        trafficMetric: 'daily active users summed over days; not unique weekly people',
        revenueCurrency: currency,
        monetaryUnit: 'minor currency units',
        currencyMinorDigits: currency ? currencyMinorDigits(currency) : null,
      }, { start: money.previousStart, end });
      if (alignedTraffic && money && currentComparison(asset, end, now) && alignedTraffic.changePercent !== null && money.changePercent !== null &&
        (alignedTraffic.current !== alignedTraffic.previous || money.current !== money.previous) && Math.abs(alignedTraffic.changePercent - money.changePercent) > 0.000001) insightEvidenceIds.push(`${prefix}:traffic-revenue`);
    }
  }
  if (!options.revenueByAsset) limitations.push('The Home read model lacks complete per-source daily revenue coverage; traffic versus revenue comparisons are unavailable.');
  if (wall.assets.length > ASSET_LIMIT) limitations.push(`Asset details cover ${ASSET_LIMIT} of ${wall.assets.length} assets; portfolio totals cover the full portfolio.`);

  const trafficDates = assets.map(asset => [...settledTraffic(asset.activeUsers).keys()].sort().at(-1));
  const commonEnd = trafficDates.every(Boolean) ? (trafficDates as string[]).sort()[0] : undefined;
  if (assets.length === wall.assets.length && assets.length > 1 && commonEnd && assets.every(asset => asset.activeUsers.timeZone && asset.activeUsers.timeZone === assets[0]!.activeUsers.timeZone)) {
    const rows = assets.map(asset => ({ asset: asset.id, name: asset.displayName, comparison: trafficComparison(asset, commonEnd) }));
    if (rows.every(row => row.comparison !== null)) {
      const current = rows.reduce((sum, row) => sum + row.comparison!.current, 0);
      const previous = rows.reduce((sum, row) => sum + row.comparison!.previous, 0);
      add('portfolio:traffic-divergence', 'Portfolio traffic and individual asset movement on the same complete days', '/assets', null, {
        current, previous, changePercent: change(current, previous), timeZone: assets[0]!.activeUsers.timeZone,
        assets: rows.map(row => ({ asset: row.asset, name: row.name, ...row.comparison!, currentShare: current > 0 ? row.comparison!.current / current : null })),
        decliningAssets: rows.filter(row => row.comparison!.current < row.comparison!.previous).length,
        metric: 'daily active users summed over days; not unique weekly people',
      }, { start: rows[0]!.comparison!.previousStart, end: commonEnd });
      if (assets.every(asset => currentComparison(asset, commonEnd, now)) && rows.some(row => row.comparison!.current > row.comparison!.previous) && rows.some(row => row.comparison!.current < row.comparison!.previous)) insightEvidenceIds.push('portfolio:traffic-divergence');
    }
  }

  const alerts = [...wall.attention].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]) || a.firstFiredAt.localeCompare(b.firstFiredAt) || a.id - b.id).slice(0, ALERT_LIMIT);
  for (const alert of alerts) add(`alert:${alert.id}`, clip(alert.message), '/alerts', alert.firedAt, {
    asset: alert.asset, severity: alert.severity, kind: alert.kind, rule: alert.ruleId,
    firstFiredAt: alert.firstFiredAt, metric: alert.metric,
    linkedTasks: alert.handoffBeads?.slice(0, 3).map(task => ({ id: task.beadId, status: task.status })) ?? null,
  });
  const readable = work.projects.filter(project => project.ok);
  add('work:coverage', 'Saved task coverage and project bottlenecks', '/tasks', work.capturedAt, {
    capturedAt: work.capturedAt, cadenceHours: work.pollCadenceHours,
    stale: isAmber(now.getTime(), work.capturedAt, work.pollCadenceHours),
    unreadProjects: work.projects.filter(project => !project.ok).map(project => project.asset).slice(0, ASSET_LIMIT),
    omittedUnreadProjectNames: Math.max(0, work.projects.filter(project => !project.ok).length - ASSET_LIMIT),
    omittedProjectDetails: Math.max(0, readable.length - ASSET_LIMIT),
    projects: readable.slice(0, ASSET_LIMIT).map(project => ({ asset: project.asset, name: project.name, counts: project.counts, weeks: project.weeks ?? null })),
    outcomeMeasurement: 'Task counts do not establish revenue, traffic or customer impact.',
  });
  const sampled = readable.flatMap(project => [...project.waiting, ...project.inProgress, ...(project.blocked ?? [])].map(task => ({ project, task })));
  const unique = [...new Map(sampled.map(row => [`${row.project.asset}:${row.task.id}`, row])).values()]
    .sort((a, b) => a.task.priority - b.task.priority || (a.task.updatedAt ?? '\uffff').localeCompare(b.task.updatedAt ?? '\uffff') || a.task.id.localeCompare(b.task.id));
  for (const { project, task } of unique.slice(0, TASK_LIMIT)) add(`task:${project.asset}:${task.id}`, clip(task.title), `/tasks/${encodeURIComponent(task.id)}?${new URLSearchParams({ project: project.asset })}`, work.capturedAt, {
    asset: project.asset, id: task.id, priority: task.priority, status: task.status,
    waitingOnHuman: project.waiting.some(item => item.id === task.id),
    createdAt: task.createdAt ?? null, updatedAt: task.updatedAt,
    daysSinceUpdate: task.updatedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(task.updatedAt)) / DAY)) : null,
    dependencies: task.dependencies?.slice(0, 6) ?? null,
    caution: 'Time since last update is not time in current status; the sample does not establish all blocked dependents.',
  });
  const packet: PortfolioBriefEvidence = {
    schemaVersion: 1, asOf: now.toISOString(), timeZone: wall.osTimeZone ?? 'UTC', facts, limitations, insightEvidenceIds,
    coverage: { assets: wall.assets.length, includedAssets: assets.length, projects: work.projects.length, readableProjects: readable.length,
      omittedAlerts: wall.attention.length - alerts.length, omittedTasks: Math.max(0, unique.length - TASK_LIMIT) },
  };
  const size = () => new TextEncoder().encode(JSON.stringify(packet)).byteLength;
  if (size() > PORTFOLIO_BRIEF_MAX_BYTES) {
    const noteIndex = packet.limitations.length;
    packet.limitations.push('');
    let omitted = 0;
    const protectedIds = new Set(['work:coverage', 'system:coverage']);
    while (size() > PORTFOLIO_BRIEF_MAX_BYTES) {
      const priority = (fact: PortfolioBriefFact) => packet.insightEvidenceIds.includes(fact.id) ? 5 : fact.id.startsWith('portfolio:') ? 4 : fact.id.startsWith('task:') || fact.id.startsWith('alert:') ? 3 : fact.id.endsWith(':traffic-revenue') ? 2 : 1;
      const removable = packet.facts.filter(fact => !protectedIds.has(fact.id));
      if (removable.length === 0) break;
      const lowest = Math.min(...removable.map(priority));
      const index = packet.facts.findLastIndex(fact => !protectedIds.has(fact.id) && priority(fact) === lowest);
      if (index < 0) break;
      packet.facts.splice(index, 1);
      packet.insightEvidenceIds = packet.insightEvidenceIds.filter(id => packet.facts.some(fact => fact.id === id));
      packet.limitations[noteIndex] = `${++omitted} evidence facts were omitted to keep this packet within its size limit; absence is not evidence of an empty or healthy state.`;
    }
  }
  return packet;
}
