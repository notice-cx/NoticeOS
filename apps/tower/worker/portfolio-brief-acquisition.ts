import type { WorkspaceStore } from '@noticeos/postgres';
import type { PortfolioBriefFact } from '@noticeos/contract/portfolio-brief';
import { calendarDateIn } from '../shared/daily-revenue';
import { shiftRevenueDate } from '../shared/revenue-projection';
import { isAmber } from '../shared/freshness';
import { CADENCE_HOURS, windowSpansTimeZoneChange, type SignalTrend } from '../shared/wall';
import { loadSignalTrends } from './signal-trends';

interface MetricComparison { current: number; previous: number; changePercent: number | null }
const metric = (current: number, previous: number): MetricComparison => ({ current, previous,
  changePercent: previous > 0 ? Math.round((current - previous) / previous * 10_000) / 100 : null });

function settled(trend: SignalTrend, latest: string): Map<string, number> {
  const estimated = new Set(trend.estimatedDates ?? []);
  return new Map([...(trend.contextSeries ?? []), ...trend.series]
    .filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.t) && point.t <= latest && Number.isFinite(point.v) && point.v >= 0
      && !estimated.has(point.t) && (!trend.provisionalFrom || point.t < trend.provisionalFrom))
    .map(point => [point.t, point.v]));
}

function paired(trends: readonly SignalTrend[], now: Date, lag: number, cadenceHours: number) {
  const timeZone = trends[0]?.timeZone;
  if (!timeZone || trends.some(trend => trend.timeZone !== timeZone || !Number.isFinite(Date.parse(trend.collectedAt ?? '')) || Date.parse(trend.collectedAt!) > now.getTime())) return null;
  let today: string;
  try { today = calendarDateIn(timeZone)(now); } catch { return null; }
  const values = trends.map(trend => settled(trend, shiftRevenueDate(today, -lag)));
  for (const end of [...values[0]!.keys()].sort().reverse()) {
    const dates = Array.from({ length: 14 }, (_, index) => shiftRevenueDate(end, index - 13));
    if (values.some(series => dates.some(date => !series.has(date)))) continue;
    if (trends.some(trend => windowSpansTimeZoneChange(trend.timeZoneChanges, { start: dates[0]!, end }))) continue;
    const metrics = values.map(series => metric(dates.slice(7).reduce((sum, date) => sum + series.get(date)!, 0), dates.slice(0, 7).reduce((sum, date) => sum + series.get(date)!, 0)));
    const lagDays = Math.round((Date.parse(today) - Date.parse(end)) / 86_400_000);
    return { metrics, lagDays, comparison: { current: { start: dates[7]!, end }, previous: { start: dates[0]!, end: dates[6]! }, timeZone },
      observedAt: new Date(Math.min(...trends.map(trend => Date.parse(trend.collectedAt!)))).toISOString(),
      fresh: trends.every(trend => !isAmber(now.getTime(), trend.collectedAt, cadenceHours)) };
  }
  return null;
}

export async function loadPortfolioBriefAcquisition(store: WorkspaceStore, { now, assets }: {
  now: Date; assets: readonly { id: string; displayName: string }[];
}): Promise<{ facts: PortfolioBriefFact[]; insightEvidenceIds: string[] }> {
  const trends = await loadSignalTrends(store, 14, { assets: assets.map(asset => asset.id), nowMs: now.getTime(), includeWebSearch: true, includeSecondarySeries: true });
  const facts: PortfolioBriefFact[] = [];
  const insightEvidenceIds: string[] = [];
  for (const asset of assets) {
    const set = trends.get(asset.id);
    if (!set) continue;
    for (const provider of ['google', 'bing', 'ga4'] as const) {
      const search = provider !== 'ga4';
      const series = search ? [set.webSearchClicks[provider], set.webSearchImpressions[provider]] : [set.sessions, set.pageViews];
      const pair = paired(series, now, search ? 1 : 2, provider === 'bing' ? CADENCE_HOURS.bingSignals : CADENCE_HOURS.googleSignals);
      if (!pair) continue;
      const [first, second] = pair.metrics as [MetricComparison, MetricComparison];
      const ratio = (left: number, right: number) => right > 0 ? Math.round(left / right * 100_000) / 100_000 : null;
      const derived = (current: number | null, previous: number | null) => ({ current, previous,
        changePercent: current !== null && previous !== null && previous > 0 ? metric(current, previous).changePercent : null });
      const metrics = search ? { clicks: first, impressions: second, ctr: derived(ratio(first.current, second.current), ratio(first.previous, second.previous)) }
        : { sessions: first, pageViews: second, pageViewsPerSession: derived(ratio(second.current, first.current), ratio(second.previous, first.previous)) };
      const fact: PortfolioBriefFact = { id: `acquisition:${asset.id}:${provider}`, domain: 'acquisition', label: `${asset.displayName.slice(0, 80)} · ${provider === 'ga4' ? 'GA4 usage' : provider === 'google' ? 'Google search' : 'Bing search'}`,
        href: `/assets/${encodeURIComponent(asset.id)}`, observedAt: pair.observedAt, period: pair.comparison.current, comparison: pair.comparison,
        data: { asset: asset.id, name: asset.displayName.slice(0, 80), provider, metrics, lagDays: pair.lagDays,
          caution: search ? 'Clicks and impressions belong to this provider only.' : 'Page views per session is a usage ratio, not an engagement rate.' } };
      if (new TextEncoder().encode(JSON.stringify(fact)).byteLength > 1_600) continue;
      facts.push(fact);
      if (pair.fresh && pair.lagDays <= (search ? 7 : 2) && pair.metrics.some(value => value.current !== value.previous)) insightEvidenceIds.push(fact.id);
    }
  }
  return { facts, insightEvidenceIds };
}
