import { useId, useState, type ReactNode } from "react";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { ClaritySnapshot, ProductDay, SearchIntelligenceSnapshot } from "@shared/asset-detail";
import { MEDIAVINE_REPORTING_CLOCK, siteRevenueWindow, type DailyRevenueHistory } from "@shared/daily-revenue";
import { shiftLabel, windowSeries, type RangeDays } from "@shared/surface";
import type { SeriesPoint, SignalTrend } from "@shared/wall";
import { DailyRevenuePanel } from "@/components/DailyRevenuePanel";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { TimeZoneCaveat } from "@/components/TimeZoneCaveat";
import { HeroChart, type HeroSeries } from "@/components/surface/HeroChart";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import type { SeriesTone } from "@/components/surface/Sparkline";
import { formatCalendarDate, formatCompact, formatInt, formatPercent, formatUsd } from "@/lib/format";
import { rollingDailyAverage, rollingWeeklyChange, spannedTimeZoneChange } from "@/lib/series";
import { leadMetric, metricWindow, type Aggregate, type MergedTrend } from "@/routes/asset-detail/overview-metrics";
import { timelineAnnotations } from "@/routes/asset-detail/shared";

/**
 * THE FIRST THING A SITE'S PAGE DRAWS: its own numbers, fused to their chart
 * (doc 21; beads `ro-ujb9.124`, `ro-ujb9.127`, `ro-ujb9.146`).
 *
 * One composition in two places — the site's Overview, and Home when the
 * installation has one site — so the two can never state the site differently.
 *
 * IT LEADS WITH WHAT THE SITE HAS. A site's first source may be Search
 * Console, Bing or Analytics, ad revenue, PostHog or DataForSEO, and four
 * traffic dashes over a site that only earns money say nothing about it. So
 * the lead is chosen from the data (`siteLead`), in this order:
 *
 * 1. Traffic from Analytics, Search Console or Bing — the four KPIs and their
 *    chart, as the Overview has always drawn them.
 * 2. Daily ad revenue — the panel the site's Financials tab draws (money
 *    leads, D13).
 * 3. PostHog's daily site use — people, page views and sessions in the same
 *    traffic strip, read from the source the site has.
 * 4. Clarity's latest reported page or explicitly unattributed bucket.
 * 5. DataForSEO's latest rankings, which carry no daily series.
 * 6. Nothing collected yet — the four traffic KPIs as dashes and no chart.
 */
export type SiteLeadData = AssetDetailFor<"overview">;

export type MetricKey =
  | "activeUsers"
  | "sessions"
  | "clicks"
  | "impressions"
  | "people"
  | "pageviews"
  | "productSessions";

export interface SignalKpi {
  key: MetricKey;
  label: string;
  /** The daily chart names the measure itself, not the period aggregate. */
  chartLabel: string;
  value: string;
  note?: string;
  delta: ReturnType<typeof metricWindow>["delta"];
  spark: SeriesPoint[];
  chart: HeroSeries[];
  trend: MergedTrend;
  format: (value: number) => string;
  selectable: boolean;
  /** Latest complete 7 days against the 7 before, for a measure whose chart
   * carries last week's marks (daily users, bead `ro-trai.10`). */
  weekly?: WeeklyComparison;
}

interface WeeklyComparison {
  change: number;
  trend: SignalTrend;
  /** The window, when it straddles a reporting-timezone change. */
  distorted: { start: string; end: string } | null;
}

/** What the lead draws, from the site's own data. */
export type SiteLeadChoice =
  | { kind: "traffic"; source: "providers" | "posthog" | "none"; metrics: SignalKpi[] }
  | { kind: "revenue"; history: DailyRevenueHistory }
  | { kind: "clarity"; snapshot: ClaritySnapshot }
  | { kind: "rankings"; snapshot: SearchIntelligenceSnapshot };

const hasPoints = (trend: SignalTrend) => trend.series.length > 0 || (trend.contextSeries?.length ?? 0) > 0;

/** The lead is chosen from whether a source HAS data, not from the range, so
 * switching 7 · 28 · 90 re-derives the numbers without swapping the lead. */
export function siteLead(data: SiteLeadData, days: RangeDays, nowMs: number): SiteLeadChoice {
  const { performance } = data;
  const traffic = [
    performance.activeUsers,
    performance.sessions,
    performance.webSearchClicks.google,
    performance.webSearchClicks.bing,
    performance.webSearchImpressions.google,
    performance.webSearchImpressions.bing,
  ];
  if (traffic.some(hasPoints)) return { kind: "traffic", source: "providers", metrics: signalMetrics(data, days) };
  if ((data.dailyRevenue?.days.length ?? 0) > 0) {
    return { kind: "revenue", history: siteRevenueWindow(data.dailyRevenue, nowMs, MEDIAVINE_REPORTING_CLOCK.timeZone, days) };
  }
  const product = data.executive?.product?.webDaily?.days ?? [];
  if (product.length > 0) return { kind: "traffic", source: "posthog", metrics: productMetrics(product, days) };
  const clarity = data.executive?.clarity ?? null;
  if (clarity) return { kind: "clarity", snapshot: clarity };
  const rankings = data.executive?.searchIntelligence ?? null;
  if (rankings) return { kind: "rankings", snapshot: rankings };
  return { kind: "traffic", source: "none", metrics: signalMetrics(data, days) };
}

export function SiteLead({
  data,
  days,
  nowMs,
  aside,
}: {
  data: SiteLeadData;
  days: RangeDays;
  nowMs: number;
  /** The end of the header row: on Home's one-site lead, the site itself —
   * its state and the way to its page. */
  aside?: ReactNode;
}) {
  const [picked, setPicked] = useState<MetricKey | null>(null);
  const lead = siteLead(data, days, nowMs);
  if (lead.kind === "revenue") {
    return (
      <div data-site-lead="revenue">
        <DailyRevenuePanel
          history={lead.history}
          range={days}
          aside={aside}
          setupHref={`/assets/${encodeURIComponent(data.asset.id)}/sources`}
        />
      </div>
    );
  }
  if (lead.kind === "rankings") return <RankingsLead snapshot={lead.snapshot} aside={aside} />;
  if (lead.kind === "clarity") return <ClarityLead snapshot={lead.snapshot} aside={aside} />;
  return (
    <TrafficLead
      source={lead.source}
      metrics={lead.metrics}
      days={days}
      annotations={timelineAnnotations(data.annotations.items)}
      aside={aside}
      picked={picked}
      onPick={setPicked}
    />
  );
}

/** A rolling provider read stays a snapshot when the daily range changes. */
function ClarityLead({ snapshot, aside }: { snapshot: ClaritySnapshot; aside?: ReactNode }) {
  const id = useId();
  const reason = "One rolling report; no daily trend";
  const value = (count: number | null) => count === null ? "Unknown" : formatInt(count);
  const observed = snapshot.collectedAt?.slice(0, 10) ?? snapshot.reportDate;
  return (
    <section aria-labelledby={id} data-site-lead="clarity" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <SectionLabel id={id} title="Clarity · 72-hour report"
        caption={`${snapshot.collectedAt ? "Collected" : "Reported"} ${formatCalendarDate(observed)}${snapshot.truncated ? " · Limited export" : ""}`}
        className="border-b border-border/60 px-4 py-3">{aside}</SectionLabel>
      {snapshot.page ? (
        <div className="flex min-w-0 items-baseline gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          <span className="shrink-0">Reported page</span>
          <a href={snapshot.page.url} className="min-w-0 truncate underline underline-offset-4" title={snapshot.page.url}>
            {snapshot.page.url.replace(/^https?:\/\//, "")}
          </a>
        </div>
      ) : null}
      <KpiStrip columns={snapshot.page ? 2 : 1}>
        {snapshot.page ? <>
          <Kpi label="Page sessions" value={value(snapshot.page.sessions)} caption="72-hour count" seriesUnavailable={reason} />
          <Kpi label="Script errors" value={value(snapshot.page.scriptErrors)} caption="72-hour count" seriesUnavailable={reason} />
        </> : <Kpi label="Unattributed sessions" value={value(snapshot.unattributedSessions)} caption="72-hour count" seriesUnavailable={reason} />}
      </KpiStrip>
    </section>
  );
}

function TrafficLead({
  source,
  metrics,
  days,
  annotations,
  aside,
  picked,
  onPick,
}: {
  source: "providers" | "posthog" | "none";
  metrics: SignalKpi[];
  days: RangeDays;
  annotations: ReturnType<typeof timelineAnnotations>;
  aside?: ReactNode;
  picked: MetricKey | null;
  onPick: (key: MetricKey) => void;
}) {
  // One lead per page (the Overview, or Home with one site), so one id.
  const id = "overview-traffic";
  const metric = leadMetric(metrics, picked);
  const selected = metrics.find((one) => one.key === metric) ?? null;
  return (
    <section
      aria-labelledby={id}
      data-traffic-window
      data-site-lead={source === "posthog" ? "posthog" : undefined}
      className="overflow-hidden rounded-[10px] border border-border bg-card"
    >
      {/* No explanation beside the title (doc 21 principle 3a): each KPI
          names its own aggregate ("Avg. daily users", a period total for the
          rest) and its plotted method ("Trend: 7-day average"), and the chart
          legend names the provider. A tooltip restating them was a second
          copy of facts already on screen. */}
      <SectionLabel
        id={id}
        title={`Traffic · last ${days} days`}
        className="border-b border-border/60 px-4 py-3"
      >
        {aside}
      </SectionLabel>
      <KpiStrip columns={metrics.length}>
        {metrics.map((one, index) => (
          <Kpi
            key={one.key}
            label={one.label}
            value={one.value}
            note={one.note}
            delta={one.delta}
            spark={one.spark.length >= 3 ? one.spark : undefined}
            seriesUnavailable={one.spark.length === 0 ? "No reports in this period." : "At least three reported days are needed for a trend."}
            sparkPreAveragedWindow={7}
            format={one.format}
            selected={metric === one.key}
            onSelect={one.selectable ? () => onPick(one.key) : undefined}
            // An odd last KPI spans a phone's two columns rather than leave a hole.
            className={metrics.length % 2 === 1 && index === metrics.length - 1 ? "col-span-2 sm:col-span-1" : undefined}
          />
        ))}
      </KpiStrip>

      {/* No series anywhere in the strip, no chart: its dashes already say
          so once, and an empty 240px box would say it again. */}
      {selected ? (
        <div className="border-t border-border/60 p-4">
          <HeroChart
            title={`${selected.chartLabel} · daily`}
            titleAside={selected.weekly ? <WeeklyChange weekly={selected.weekly} /> : null}
            series={selected.chart}
            range={days}
            annotations={annotations}
            provisionalFrom={selected.trend.provisionalFrom}
            format={selected.format}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * DataForSEO's latest weekly rankings: four figures and no chart. The saved
 * analysis keeps only the newest report, so each KPI declares that rather than
 * drawing a line through one reading (doc 21's `seriesUnavailable`).
 */
function RankingsLead({ snapshot, aside }: { snapshot: SearchIntelligenceSnapshot; aside?: ReactNode }) {
  const id = useId();
  const { rankings } = snapshot;
  const reason = "Only the latest weekly report is kept";
  return (
    <section aria-labelledby={id} data-site-lead="rankings" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <SectionLabel
        id={id}
        title="Search position"
        caption={snapshot.observedAt ? `DataForSEO · ${formatCalendarDate(snapshot.observedAt)}` : "DataForSEO"}
        className="border-b border-border/60 px-4 py-3"
      >
        {aside}
      </SectionLabel>
      <KpiStrip columns={4}>
        <Kpi label="Keywords" value={formatInt(rankings.keywords)} caption="ranking somewhere" seriesUnavailable={reason} />
        <Kpi label="Top 10" value={formatInt(rankings.top10)} caption={`top 3 · ${formatInt(rankings.top3)}`} seriesUnavailable={reason} />
        <Kpi label="Visits a month" value={formatInt(rankings.estimatedVisits)} caption="modelled" seriesUnavailable={reason} />
        <Kpi label="Traffic value" value={formatUsd(rankings.estimatedPaidTrafficCost)} caption="visits priced as ads" improvement="none" seriesUnavailable={reason} />
      </KpiStrip>
    </section>
  );
}

/**
 * "Latest 7 days vs the 7 before" beside the daily-users chart — what the
 * Wall's 30-day bars carried before they left it for this page (D28, bead
 * `ro-trai.10`). A window across a reporting-timezone change keeps its number
 * and loses its colour, with the ⚠ saying why (doc 14, `ro-jkp2`).
 */
function WeeklyChange({ weekly }: { weekly: WeeklyComparison }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-weekly-change>
      7 days vs the 7 before
      <DeltaChip
        value={weekly.change}
        render={(value) => `${formatPercent(value)}%`}
        tone={weekly.distorted ? "neutral" : performanceTone(weekly.change)}
        className="text-xs"
      />
      {weekly.distorted ? <TimeZoneCaveat trend={weekly.trend} window={weekly.distorted} /> : null}
    </span>
  );
}

/** The same weekday one week earlier, drawn on each visible date: the marks
 * the Wall's daily bars carried. A date with no reading a week before draws
 * nothing, never a zero. */
function lastWeekSeries(trend: SignalTrend, visible: ReadonlySet<string>): SeriesPoint[] {
  const byDate = new Map([...(trend.contextSeries ?? []), ...trend.series].map((point) => [point.t, point.v]));
  return [...visible].sort().flatMap((date) => {
    const value = byDate.get(shiftLabel(date, -7));
    return value === undefined ? [] : [{ t: date, v: value }];
  });
}

interface TrendInput {
  name: string;
  tone: SeriesTone;
  trend: SignalTrend;
}

function signalMetrics(data: SiteLeadData, days: number): SignalKpi[] {
  const performance = data.performance;
  return [
    signalKpi({
      key: "activeUsers",
      // Repeated visitors cannot be summed into a period-unique audience.
      label: "Avg. daily users",
      chartLabel: "Active users",
      kind: "mean",
      trends: [{ name: "GA4", tone: "primary", trend: performance.activeUsers }],
      lastWeek: performance.activeUsers,
      days,
      format: formatInt,
    }),
    signalKpi({
      key: "sessions",
      label: "Sessions",
      kind: "sum",
      trends: [{ name: "GA4", tone: "primary", trend: performance.sessions }],
      days,
      format: formatInt,
    }),
    signalKpi({
      key: "clicks",
      label: "Search clicks",
      kind: "sum",
      trends: [
        { name: "Google", tone: "primary", trend: performance.webSearchClicks.google },
        { name: "Bing", tone: "bing", trend: performance.webSearchClicks.bing },
      ],
      days,
      format: formatInt,
    }),
    signalKpi({
      key: "impressions",
      label: "Impressions",
      kind: "sum",
      trends: [
        { name: "Google", tone: "primary", trend: performance.webSearchImpressions.google },
        { name: "Bing", tone: "bing", trend: performance.webSearchImpressions.bing },
      ],
      days,
      format: formatCompact,
    }),
  ];
}

/** One PostHog measure as a daily series. A day PostHog sent no figure for is
 * absent, never zero; the analysis reads closed days only, so none is
 * provisional. */
function productTrend(days: readonly ProductDay[], pick: (day: ProductDay) => number | null): SignalTrend {
  return {
    series: days.flatMap((day) => {
      const value = pick(day);
      return value === null ? [] : [{ t: day.date, v: value }];
    }),
    provisionalFrom: null,
    collectedAt: null,
    timeZoneChanges: [],
  };
}

/** PostHog's daily site use in the traffic strip's shape, named as the Growth
 * tab's Product section names it: people are a daily count of distinct people
 * (a mean, never a sum); page views and sessions add up. */
function productMetrics(days: readonly ProductDay[], range: number): SignalKpi[] {
  return [
    signalKpi({
      key: "people",
      label: "People a day",
      chartLabel: "People",
      kind: "mean",
      trends: [{ name: "PostHog", tone: "primary", trend: productTrend(days, (day) => day.people) }],
      days: range,
      format: formatInt,
    }),
    signalKpi({
      key: "pageviews",
      label: "Page views",
      kind: "sum",
      trends: [{ name: "PostHog", tone: "primary", trend: productTrend(days, (day) => day.pageviews) }],
      days: range,
      format: formatCompact,
    }),
    signalKpi({
      key: "productSessions",
      label: "Sessions",
      kind: "sum",
      trends: [{ name: "PostHog", tone: "primary", trend: productTrend(days, (day) => day.sessions) }],
      days: range,
      format: formatCompact,
    }),
  ];
}

function signalKpi({
  key,
  label,
  chartLabel,
  kind,
  note,
  trends,
  lastWeek,
  days,
  format,
}: {
  key: MetricKey;
  label: string;
  chartLabel?: string;
  kind: Aggregate;
  note?: string;
  trends: TrendInput[];
  /** Draw this series' same weekday last week and its weekly change. */
  lastWeek?: SignalTrend;
  days: number;
  format: (value: number) => string;
}): SignalKpi {
  // The asset page's ONE derivation for a metric over a window (bead
  // `ro-78qo.4`). Growth's chart pairs read the same function, so the strip and
  // the charts cannot state different totals for the same measure.
  const { merged, enough, value, delta, spark } = metricWindow(
    trends.map((one) => one.trend),
    days,
    kind,
  );
  const visible = new Set(windowSeries(merged.series, days).map((point) => point.t));
  const lead = trends.flatMap((one): HeroSeries[] => {
    const points = one.trend.series.filter((point) => visible.has(point.t));
    return points.length === 0
      ? []
      : [{ name: one.name, points, tone: one.tone }];
  });
  const previous = lastWeek && lead.length > 0 ? lastWeekSeries(lastWeek, visible) : [];
  const chart: HeroSeries[] = previous.length > 0
    ? [...lead, { name: "Same day last week", points: previous, provisionalFrom: null, reference: true }]
    : lead;
  const change = lastWeek
    ? rollingWeeklyChange(rollingDailyAverage([...(lastWeek.contextSeries ?? []), ...lastWeek.series], 7, lastWeek.provisionalFrom))
    : null;
  return {
    key,
    label,
    chartLabel: chartLabel ?? label,
    value: value === null ? "—" : format(value),
    note: enough ? note : undefined,
    delta,
    spark,
    chart,
    trend: merged,
    format,
    selectable: chart.length > 0,
    weekly: lastWeek && change !== null
      ? { change, trend: lastWeek, distorted: spannedTimeZoneChange(lastWeek)?.window ?? null }
      : undefined,
  };
}
