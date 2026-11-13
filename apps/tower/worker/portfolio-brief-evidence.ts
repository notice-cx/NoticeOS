import { PORTFOLIO_BRIEF_MAX_BYTES, type PortfolioBriefEvidence, type PortfolioBriefFact } from '@noticeos/contract/portfolio-brief';
import { calendarDateIn, type DailyRevenueHistory } from '../shared/daily-revenue';
import { shiftRevenueDate } from '../shared/revenue-projection';
import { isAmber } from '../shared/freshness';
import { CADENCE_HOURS, windowSpansTimeZoneChange, type AssetCard, type SignalTrend, type WallPayload } from '../shared/wall';
import type { WorkPayload } from '../shared/work';
import { TASK_BLOCKING_DEPENDENCIES } from '@noticeos/contract/task-gate';
import { currencyMinorDigits } from '@noticeos/contract/money';

const ASSET_LIMIT = 40;
const ALERT_LIMIT = 20;
const TASK_LIMIT = 20;
const DAY = 86_400_000;
const change = (current: number, previous: number) => previous > 0 ? (current - previous) / previous * 100 : null;
const clip = (value: string, length = 240) => value.slice(0, length);
const component = (value: string) => encodeURIComponent(value).replace(/[!~*'()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const siteHref = (id: string) => `/assets/${component(id)}`;

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
  if (!asset.activeUsers.timeZone || Date.parse(asset.activeUsers.collectedAt ?? '') > now.getTime() || isAmber(now.getTime(), asset.activeUsers.collectedAt, CADENCE_HOURS.googleSignals)) return false;
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

function comparisonPeriods(window: WindowComparison, timeZone: string): NonNullable<PortfolioBriefFact['comparison']> {
  return { current: { start: window.start, end: window.end }, previous: { start: window.previousStart, end: window.previousEnd }, timeZone };
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

function newestAlignedComparison(asset: AssetCard, revenueDays: ReadonlyMap<string, number>, latestEnd: string) {
  // A partial newest day does not invalidate an earlier complete pair.
  for (const end of [...revenueDays.keys()].filter(date => date <= latestEnd).sort().reverse()) {
    const traffic = trafficComparison(asset, end);
    const money = compareDays(revenueDays, end);
    if (traffic && money) return { end, traffic, money };
  }
  return null;
}

/** Stored observations only. A capped sample never becomes a complete task or
 * source inventory, and source publication time never substitutes for its period. */
export function buildPortfolioBriefEvidence(
  wall: WallPayload,
  work: WorkPayload,
  options: { now?: Date; revenueByAsset?: ReadonlyMap<string, DailyRevenueHistory>; reviewAssetIds?: readonly string[] | null } = {},
): PortfolioBriefEvidence {
  const now = options.now ?? new Date(wall.generatedAt);
  const scoped = Array.isArray(options.reviewAssetIds);
  if (scoped) {
    const selected = new Set(options.reviewAssetIds);
    wall = { ...wall, assets: wall.assets.filter(asset => selected.has(asset.id)), attention: wall.attention.filter(alert => selected.has(alert.asset)) };
    work = { ...work, projects: work.projects.filter(project => selected.has(project.asset)), archivedProjects: work.archivedProjects?.filter(project => selected.has(project.asset)) };
  }
  if (scoped && options.reviewAssetIds!.length === 0) return { schemaVersion: 1, asOf: now.toISOString(), timeZone: wall.osTimeZone ?? 'UTC',
    reviewAssetIds: [...options.reviewAssetIds!], facts: [], insightEvidenceIds: [], limitations: [],
    coverage: { assets: 0, includedAssets: 0, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 } };
  const facts: PortfolioBriefFact[] = [];
  const insightEvidenceIds: string[] = [];
  const limitations = [
    'Comparisons describe observed changes, not causes or measured effects of completed tasks.',
    'Task rows are saved samples; counts cover successful project snapshots. Task closure does not establish a business outcome.',
    'Booked ledger figures are reconciled; forecast ledger figures, provider daily revenue and projections are estimates. Zero ledger figures do not establish recorded zero revenue.',
  ];
  if (scoped) limitations.push('Business evidence covers selected assets only. Unassigned portfolio accounting is excluded; system health and operational spending cover the whole installation.');
  const add = (id: string, label: string, href: string, observedAt: string | null, data: Record<string, unknown>, period: PortfolioBriefFact['period'] = null, comparison?: PortfolioBriefFact['comparison']) => {
    facts.push({ id, label: clip(label), href, observedAt, period, data, ...(comparison ? { comparison } : {}) });
  };
  const assets = [...wall.assets].sort((a, b) => b.openError - a.openError || b.openWarn - a.openWarn ||
    (Date.parse(b.activeUsers.collectedAt ?? '') || 0) - (Date.parse(a.activeUsers.collectedAt ?? '') || 0) || a.id.localeCompare(b.id)).slice(0, ASSET_LIMIT);
  const booked = accounting(wall.portfolio.booked, wall.portfolio.revenueRecorded?.booked);
  const estimated = accounting(wall.portfolio.forecast, wall.portfolio.revenueRecorded?.forecast);
  if (!scoped && (booked || estimated || wall.portfolio.bookedDelta)) add('portfolio:ledger', 'Portfolio accounting', '/financials', wall.ledgerRecordedAt, {
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
  const recentFailures = failedJobs.filter(job => {
    const at = Date.parse(job.startedAt);
    return Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= 7 * DAY;
  }).sort((a, b) => b.failedRuns - a.failedRuns || b.startedAt.localeCompare(a.startedAt)).slice(0, 6);
  const operations: PortfolioBriefFact = {
    id: 'operations:recent', domain: 'operations', basis: 'current-state', label: 'Recent execution and spending', href: '/health', observedAt: now.toISOString(), period: null,
    data: { failedJobs: recentFailures, omittedFailures: failedJobs.length - recentFailures.length,
      spendTodayUsd: wall.system.spendTodayUsd, spendingDateUTC: now.toISOString().slice(0, 10), dailyDataBudgetPaceUsd: wall.system.dailyCapUsd,
      backupLastGoodAt: wall.system.backupLastGoodAt ?? null,
      reporting: { expected: wall.system.ingest.expected, fresh: wall.system.ingest.fresh, stale: wall.system.ingest.stale },
      caution: 'Latest stored run outcomes, not live availability. Daily budget pace is not a spending forecast. Missing reports are not business decline.' },
  };
  facts.push(operations);
  if (recentFailures.length || wall.system.spendTodayUsd > wall.system.dailyCapUsd && wall.system.dailyCapUsd > 0) insightEvidenceIds.push(operations.id);
  for (const asset of assets) {
    const prefix = `asset:${asset.id}`;
    const href = siteHref(asset.id);
    const traffic = trafficComparison(asset);
    const insightSource = asset.insightSource;
    const trafficEnd = [...settledTraffic(asset.activeUsers).keys()].sort().at(-1) ?? null;
    add(`${prefix}:coverage`, `${asset.displayName}: available evidence`, href, asset.activeUsers.collectedAt, {
      trafficThrough: trafficEnd,
      trafficCollectionStale: isAmber(now.getTime(), asset.activeUsers.collectedAt, CADENCE_HOURS.googleSignals),
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
    if (traffic) {
      add(`${prefix}:traffic`, `${asset.displayName}: complete seven-day traffic comparison`, href, asset.activeUsers.collectedAt,
        { ...traffic, metric: 'daily active users summed over days; not unique weekly people', timeZone: asset.activeUsers.timeZone ?? null }, { start: traffic.previousStart, end: traffic.end }, asset.activeUsers.timeZone ? comparisonPeriods(traffic, asset.activeUsers.timeZone) : undefined);
      if (currentComparison(asset, traffic.end, now) && traffic.current !== traffic.previous) insightEvidenceIds.push(`${prefix}:traffic`);
    }
    const revenue = options.revenueByAsset?.get(asset.id);
    const currency = revenue?.bySource?.[0]?.currency;
    const compatibleSources = Boolean(currency && revenue?.bySource?.length && revenue.bySource.every(source =>
      source.currency === currency && source.clock.timeZone === revenue.clock?.timeZone && source.clock.timeZone === asset.activeUsers.timeZone));
    if (compatibleSources && revenue?.clock && revenue.clock.timeZone === asset.activeUsers.timeZone && revenue.reportedThrough && revenue.partialDates !== undefined) {
      const latestEnd = [revenue.reportedThrough, trafficEnd].filter((value): value is string => value !== null).sort()[0]!;
      const partial = new Set(revenue.partialDates);
      const revenueDays = new Map(revenue.days.filter(day => !partial.has(day.date)).map(day => [day.date, day.amountMinor]));
      const aligned = newestAlignedComparison(asset, revenueDays, latestEnd);
      if (aligned) {
        const { end, traffic: alignedTraffic, money } = aligned;
        add(`${prefix}:traffic-revenue`, `${asset.displayName}: traffic and revenue on matching complete days`, href, asset.activeUsers.collectedAt, {
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
        }, { start: money.previousStart, end }, comparisonPeriods(money, revenue.clock.timeZone));
        if (currentComparison(asset, end, now) && (alignedTraffic.current !== alignedTraffic.previous || money.current !== money.previous)) insightEvidenceIds.push(`${prefix}:traffic-revenue`);
      }
    }
  }
  if (!options.revenueByAsset) limitations.push('The Home read model lacks complete per-source daily revenue coverage; traffic versus revenue comparisons are unavailable.');
  if (wall.assets.length > ASSET_LIMIT) limitations.push(`Asset details cover ${ASSET_LIMIT} of ${wall.assets.length} ${scoped ? 'selected assets' : 'assets; portfolio totals cover the full portfolio'}.`);

  const trafficDates = assets.map(asset => [...settledTraffic(asset.activeUsers).keys()].sort().at(-1));
  const commonEnd = trafficDates.every(Boolean) ? (trafficDates as string[]).sort()[0] : undefined;
  if (assets.length === wall.assets.length && assets.length > 1 && commonEnd && assets.every(asset => asset.activeUsers.timeZone && asset.activeUsers.timeZone === assets[0]!.activeUsers.timeZone)) {
    const rows = assets.map(asset => ({ asset: asset.id, name: asset.displayName, comparison: trafficComparison(asset, commonEnd) }));
    if (rows.every(row => row.comparison !== null)) {
      const current = rows.reduce((sum, row) => sum + row.comparison!.current, 0);
      const previous = rows.reduce((sum, row) => sum + row.comparison!.previous, 0);
      add('portfolio:traffic-divergence', `${scoped ? 'Selected asset' : 'Portfolio'} traffic and individual asset movement on the same complete days`, '/assets', null, {
        current, previous, changePercent: change(current, previous), timeZone: assets[0]!.activeUsers.timeZone,
        assets: rows.map(row => ({ asset: row.asset, name: row.name, ...row.comparison!, currentShare: current > 0 ? row.comparison!.current / current : null })),
        decliningAssets: rows.filter(row => row.comparison!.current < row.comparison!.previous).length,
        metric: 'daily active users summed over days; not unique weekly people',
      }, { start: rows[0]!.comparison!.previousStart, end: commonEnd }, comparisonPeriods(rows[0]!.comparison!, assets[0]!.activeUsers.timeZone!));
      if (assets.every(asset => currentComparison(asset, commonEnd, now)) && rows.some(row => row.comparison!.current !== row.comparison!.previous)) insightEvidenceIds.push('portfolio:traffic-divergence');
    }
  }

  const alerts = [...wall.attention].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]) || a.firstFiredAt.localeCompare(b.firstFiredAt) || a.id - b.id).slice(0, ALERT_LIMIT);
  for (const alert of alerts) add(`alert:${alert.id}`, clip(alert.message), '/alerts', alert.firedAt, {
    asset: alert.asset, severity: alert.severity, kind: alert.kind, rule: alert.ruleId,
    firstFiredAt: alert.firstFiredAt, metric: alert.metric,
    linkedTasks: alert.handoffTasks?.slice(0, 3).map(task => ({ id: task.taskId, status: task.status })) ?? null,
  });
  const readable = work.projects.filter(project => project.ok);
  const workFresh = work.capturedAt !== null && Date.parse(work.capturedAt) <= now.getTime() && !isAmber(now.getTime(), work.capturedAt, work.pollCadenceHours);
  for (const project of readable.slice(0, ASSET_LIMIT)) {
    const weeks = project.weeks;
    const fact: PortfolioBriefFact = { id: `work:${project.asset}:progress`, domain: 'delivery',
      ...(workFresh ? { basis: 'current-state' as const } : {}), label: `${clip(project.name, 100)}: delivery progress`, href: '/tasks', observedAt: work.capturedAt, period: null,
      data: { asset: project.asset, name: clip(project.name, 100), counts: project.counts,
        weeklyProgress: weeks ? { weekStart: weeks.weekStart, timeZone: weeks.timeZone ?? null, daysIn: weeks.daysIn,
          closedThisWeek: weeks.done.now, closedLastWeekAtSameElapsedTime: weeks.done.before, closedWithoutShipping: weeks.done.notDone,
          closedObservedAt: weeks.done.observedAt ?? null,
          currentAnd7DaysAgo: Object.fromEntries((['waiting', 'urgent', 'inProgress', 'blocked'] as const).map(key => [key, { current: weeks[key].now, previous: weeks[key].before }])) } : null,
        caution: 'Counts overlap: blocked and ready are subsets of open; waiting and urgent cut across states. Closure is not measured business impact. Missing history is unknown.' },
    };
    facts.push(fact);
    if (workFresh && (project.counts.open || project.counts.inProgress || project.counts.closedRecent)) insightEvidenceIds.push(fact.id);
  }
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
  for (const { project, task } of unique.slice(0, TASK_LIMIT)) add(`task:${project.asset}:${task.id}`, clip(task.title), `/tasks/${component(task.id)}?project=${component(project.asset)}`, work.capturedAt, {
    asset: project.asset, id: task.id, priority: task.priority, status: task.status,
    waitingOnHuman: project.waiting.some(item => item.id === task.id),
    createdAt: task.createdAt ?? null, updatedAt: task.updatedAt,
    daysSinceUpdate: task.updatedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(task.updatedAt)) / DAY)) : null,
    dependencies: task.dependencies?.slice(0, 6) ?? null,
    caution: 'Time since last update is not time in current status; the sample does not establish all blocked dependents.',
  });
  const dependencyFacts: PortfolioBriefFact[] = [];
  if (workFresh) for (const project of readable) {
    const open = (task: typeof project.waiting[number]) => ['open', 'blocked'].includes(task.status) && !task.closedAt && !task.deferUntil;
    const waiting = [...new Map(project.waiting.filter(open).map(task => [task.id, task])).values()];
    const blocked = [...new Map((project.blocked ?? []).filter(open).map(task => [task.id, task])).values()];
    for (const decision of waiting) {
      const dependents = blocked.flatMap(task => {
        if (task.id === decision.id) return [];
        const edge = task.dependencies?.find(edge => edge.id === decision.id && TASK_BLOCKING_DEPENDENCIES.includes(edge.type) && edge.status !== 'closed' && edge.status !== 'deferred');
        if (!edge) return [];
        const other = task.dependencies!.filter(edge => edge.id !== decision.id && TASK_BLOCKING_DEPENDENCIES.includes(edge.type) && edge.status !== 'closed' && edge.status !== 'deferred');
        return [{ id: task.id, title: clip(task.title), priority: task.priority, status: task.status,
          href: `/tasks/${component(task.id)}?project=${component(project.asset)}`, dependencyType: edge.type,
          otherBlockingDependencyIds: [...new Set(other.map(edge => edge.id))],
          otherBlockingDependencyStatusesKnown: other.every(edge => typeof edge.status === 'string'),
        }];
      }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      if (!dependents.length) continue;
      dependencyFacts.push({ id: `task-dependency:${project.asset}:${decision.id}`, label: clip(`${decision.title}: sampled blocked work`),
        href: `/tasks/${component(decision.id)}?project=${component(project.asset)}`, observedAt: work.capturedAt, period: null, basis: 'task-dependency',
        data: { project: project.asset, decision: { id: decision.id, title: clip(decision.title), priority: decision.priority, status: decision.status, waitingOnHuman: true },
          sampledBlockedDependentCount: dependents.length, sampledBlockedDependents: dependents.slice(0, 6), omittedDependentDetails: Math.max(0, dependents.length - 6),
          caution: 'Only explicit blocking links in the saved same-project sample are included. Other blockers may be absent or have unknown status; resolving this decision does not establish that dependent tasks are ready. Snapshot freshness does not establish time waiting or task impact.',
        } });
    }
  }
  dependencyFacts.sort((a, b) => a.id.localeCompare(b.id));
  for (const fact of dependencyFacts.slice(0, TASK_LIMIT)) { facts.push(fact); insightEvidenceIds.push(fact.id); }
  if (dependencyFacts.length > TASK_LIMIT) limitations.push(`Task dependency evidence covers ${TASK_LIMIT} of ${dependencyFacts.length} sampled decisions with blocked work.`);
  const packet: PortfolioBriefEvidence = {
    schemaVersion: 1, asOf: now.toISOString(), timeZone: wall.osTimeZone ?? 'UTC', facts, limitations, insightEvidenceIds,
    ...(options.reviewAssetIds !== undefined ? { reviewAssetIds: options.reviewAssetIds === null ? null : [...options.reviewAssetIds] } : {}),
    coverage: { assets: wall.assets.length, includedAssets: assets.length, projects: work.projects.length, readableProjects: readable.length,
      omittedAlerts: wall.attention.length - alerts.length, omittedTasks: Math.max(0, unique.length - TASK_LIMIT) },
  };
  const size = () => new TextEncoder().encode(JSON.stringify(packet)).byteLength;
  for (const fact of packet.facts) {
    if (fact.id !== 'work:coverage' && fact.id !== 'system:coverage') continue;
    if (new TextEncoder().encode(JSON.stringify(fact)).byteLength <= 16_000) continue;
    fact.data = fact.id === 'work:coverage' ? {
      capturedAt: work.capturedAt, cadenceHours: work.pollCadenceHours,
      stale: isAmber(now.getTime(), work.capturedAt, work.pollCadenceHours),
      projectCount: work.projects.length, readableProjectCount: readable.length,
      unreadProjectCount: work.projects.length - readable.length,
      omittedProjectDetails: readable.length, omittedUnreadProjectNames: work.projects.length - readable.length,
      projects: [], unreadProjects: [],
      caution: 'Project details and names were omitted for the evidence size limit; unread projects remain unknown, not empty.',
    } : {
      reporting: { expected: wall.system.ingest.expected, fresh: wall.system.ingest.fresh, stale: wall.system.ingest.stale, notExpected: wall.system.ingest.notExpected },
      failedJobCount: failedJobs.length, failedJobs: [], omittedFailedJobs: failedJobs.length,
      backupLastGoodAt: wall.system.backupLastGoodAt ?? null,
      caution: 'Failed job details were omitted for the evidence size limit. The failure count and reporting gaps are retained.',
    };
    packet.limitations.push(`${fact.id === 'work:coverage' ? 'Task project' : 'Background job'} details were compacted for the evidence size limit; missing detail does not establish a healthy or empty state.`);
  }
  if (size() > PORTFOLIO_BRIEF_MAX_BYTES || packet.facts.length > 260) {
    const noteIndex = packet.limitations.length;
    packet.limitations.push('Evidence details exceed the packet size limit.');
    let omitted = 0;
    const protectedIds = new Set(['work:coverage', 'system:coverage']);
    while (size() > PORTFOLIO_BRIEF_MAX_BYTES || packet.facts.length > 260) {
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
