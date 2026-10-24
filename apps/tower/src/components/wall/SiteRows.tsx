import type { Ga4RealtimeAsset, Ga4RealtimePayload, Ga4RealtimeDay } from "@noticeos/contract";
import { useMemo, type CSSProperties } from "react";
import { ChartNoAxesCombined, Globe, Layers, ListTodo, TrendingUp } from "lucide-react";
import type { AssetCard } from "@shared/wall";
import { wallMetricTiles, type WallWidget, type WallMetricTile } from "@shared/wall-layout";
import { CADENCE_HOURS } from "@shared/wall";
import { WORK_POLL_CADENCE_HOURS } from "@shared/work";
import { ageMs, isAmber } from "@shared/freshness";
import { currentRealtimeDay, realtimeActivity } from "@/lib/realtime-day";
import { clockHourNow, intradayUsersPace, paceWindowLabel, type IntradayUsersPace } from "@/lib/intraday-pace";
import { wallTrafficTone } from "@/lib/wall-traffic-tone";
import { todayUserCounts } from "@/lib/wall-today";
import { DeltaChip, paceDirectionLabel, performanceToneClass } from "@/components/DeltaChip";
import { AgeBadge } from "@/components/AgeBadge";
import { visiblePulseCounters, type WallPulseMetrics } from "@/lib/wall-counters";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { ChartArea, ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import { LiveUsers } from "@/components/wall/LiveUsers";
import { MultiMetric, NumberMetric, SparklineCompareMetric } from "@/components/wall/MetricWidgets";
import { WallMetricBinding, useWallMetricBinding } from "./WallMetricEditing";
import { readingRuns, type ChartPoint } from "@/lib/chart-path";
import { formatInt, formatPercent, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { currentHourlyReading, fourWeeks, type FourWeeks, type HourlyActiveUsers } from "@/lib/wall-sites";
import "./SiteRows.css";
import "./WallRowHeading.css";

export interface SiteRowsProps {
  assets: readonly AssetCard[];
  pulseMetrics?: WallPulseMetrics;
  ga4Realtime?: Ga4RealtimePayload;
  ga4RealtimeError?: boolean;
  nowMs: number;
  /** Work visibility is separate from an asset's TV visibility. */
  workAssets?: ReadonlySet<string>;
  widget?: WallWidget;
}

export function SiteRows({ assets, pulseMetrics, ga4Realtime, ga4RealtimeError = false, nowMs, workAssets, widget }: SiteRowsProps) {
  const tiles = wallMetricTiles(widget ?? { id: "sites", type: "sites", width: 1 });
  const configured = widget?.settings?.metrics !== undefined;
  const ordered = [...tiles.filter(tile => tile.source !== "product-counts"), ...tiles.filter(tile => tile.source === "product-counts")];
  if (assets.length === 0) return <section aria-label="Portfolio" className="flex items-center gap-3 text-wall-body text-muted-foreground" data-wall-sites="none"><Globe aria-hidden />No assets yet</section>;
  return <section aria-label="Portfolio" className="wall-portfolio" data-wall-sites data-row-separators={widget?.settings?.rowBackground === false ? "hidden" : undefined}>
    <header className="wall-portfolio-header"><h2 className="wall-portfolio-heading">Portfolio</h2><div className="wall-portfolio-legend" aria-label="Chart legend"><span><i aria-hidden />Current</span><span><i aria-hidden />Reference period</span></div></header>
    <div className="wall-portfolio-list">
      {assets.map(asset => {
        const snapshot = ga4Realtime?.assets.find(reading => reading.asset === asset.id);
        const renderTile = (tile: WallMetricTile) => {
          switch (tile.source) {
            case "momentum": return <LiveUsers asset={asset} snapshot={snapshot} reconnecting={ga4RealtimeError} nowMs={nowMs} metric />;
            case "today": return <TodayMetric asset={asset} snapshot={snapshot} nowMs={nowMs} />;
            case "four-weeks": return <TrendMetric asset={asset} />;
            case "asset-work": return !workAssets || workAssets.has(asset.id) ? <AssetWork asset={asset} nowMs={nowMs} /> : null;
            case "product-counts": return <ProductCounts asset={asset} choices={pulseMetrics} nowMs={nowMs} />;
            case "product-count": {
              const card = asset.counters?.cards.find(card => card.metric === tile.metricKey);
              if (!card) return null;
              const cadence = card.source === "nightly" ? CADENCE_HOURS.pulse : asset.counters!.cadenceHours;
              return <NumberMetric title={card.label} icon={Layers} value={card.value === null ? null : <span data-site-total={card.metric}>{formatInt(card.value)}</span>} note={isAmber(nowMs, card.observedAt, cadence) || ageMs(nowMs, card.observedAt) === null ? <AgeBadge iso={card.observedAt} cadenceHours={cadence} nowMs={nowMs} /> : undefined} />;
            }
            default: return null;
          }
        };
        const weight = (tile: WallMetricTile) => tile.size === "narrow" ? .65 : tile.size === "wide" ? 1.8 : 1;
        return <section key={asset.id} className="wall-portfolio-row" aria-label={asset.displayName} data-site-row={asset.id} data-metrics-configured={configured || undefined} style={configured ? {
          "--wall-metric-tracks": ordered.map(tile => `minmax(0, ${weight(tile)}fr)`).join(" "),
        } as CSSProperties : undefined}>
          <header className="wall-row-heading wall-portfolio-identity" data-site-name>
            <PropertyFavicon domain={asset.id} icons={asset.icons} scheme="dark" displayName={asset.displayName} className="wall-portfolio-favicon shrink-0" />
            <h3 className="wall-row-title wall-portfolio-name" data-site-label>{asset.displayName}</h3>
          </header>
          <div className="wall-portfolio-metrics">
            {ordered.map(tile => <WallMetricBinding key={tile.id} tile={tile} assetId={asset.id} configured={configured}>{configured ? <div data-wall-metric-cell>{renderTile(tile)}</div> : renderTile(tile)}</WallMetricBinding>)}
          </div>
        </section>;
      })}
    </div>
  </section>;
}

function ProductCounts({ asset, choices, nowMs }: { asset: AssetCard; choices: WallPulseMetrics; nowMs: number }) {
  const cards = visiblePulseCounters(asset, choices);
  if (!cards.length || !asset.counters) return null;
  return <MultiMetric title="Product counts" icon={Layers} className="wall-product-counts" metrics={cards.map(card => {
    const cadence = card.source === "nightly" ? CADENCE_HOURS.pulse : asset.counters!.cadenceHours;
    const stale = isAmber(nowMs, card.observedAt, cadence);
    const unknown = ageMs(nowMs, card.observedAt) === null;
    return { label: card.label, value: <span className={cn("wall-product-value", stale && "text-muted-foreground")} data-site-total={card.metric} data-site-totals={asset.id}>{formatInt(card.value!)}{stale || unknown ? <AgeBadge iso={card.observedAt} cadenceHours={cadence} nowMs={nowMs} /> : null}</span> };
  })} />;
}

function AssetWork({ asset, nowMs }: { asset: AssetCard; nowMs: number }) {
  const work = asset.work;
  const closed = work?.weeks?.done.now ?? null;
  const stale = work ? isAmber(nowMs, work.capturedAt, WORK_POLL_CADENCE_HOURS) : false;
  const count = (value: number | null) => value === null ? <span aria-label="Unavailable">—</span> : formatInt(value);
  return <div data-site-work={asset.id}><MultiMetric title="Work" icon={ListTodo} context="this week" className={stale ? "wall-work-stale" : undefined}
    primary={{ label: "Closed", value: <span data-site-work-closed>{count(closed)}</span>, tone: "positive" }}
    metrics={[
      { label: "Open", value: <span data-site-work-open>{count(work ? work.open + work.inProgress : null)}</span> },
      { label: "Blocked", value: <span data-site-work-blocked aria-label="Blocked tasks, included in open">{count(work?.blocked ?? null)}</span>, tone: work && work.blocked > 0 ? "warn" : undefined },
    ]}
    note={work && (stale || ageMs(nowMs, work.capturedAt) === null) ? <AgeBadge iso={work.capturedAt} cadenceHours={WORK_POLL_CADENCE_HOURS} nowMs={nowMs} /> : !work ? "Tasks unavailable" : undefined}
  /></div>;
}

function TodayMetric({ asset, snapshot, nowMs }: { asset: AssetCard; snapshot: Ga4RealtimeAsset | undefined; nowMs: number }) {
  const { binding } = useWallMetricBinding();
  const reference = !binding?.configured || binding.tile.reference !== false;
  const daily = todayUserCounts(asset, snapshot, nowMs);
  const retained = daily.activityDateMatches ? currentRealtimeDay(snapshot, nowMs) : null;
  const current = daily.activityDateMatches ? currentHourlyReading(snapshot, nowMs) : null;
  const pace = intradayUsersPace(asset, current ?? undefined);
  const hourly = current?.status === "success" ? current.hourlyActiveUsers : null;
  const nowHour = current?.status === "success" ? clockHourNow(nowMs, current.timeZone) : null;
  return <SparklineCompareMetric title="Today" icon={TrendingUp}
    primary={{ value: <span data-site-today-total title="Distinct active users today so far" aria-label={daily.today === null ? "Daily active users today unavailable" : `${formatInt(daily.today)} daily active users today so far`}>{daily.today === null ? <span aria-label="Unavailable">—</span> : formatInt(daily.today)}</span> }}
    referenceFact={{ label: `vs ${lastWeekdayLabel(daily.timeZone, nowMs)}`, value: daily.reference === null ? null : <span data-site-today-reference title={`Daily active users on ${daily.referenceDate}`}>{formatInt(daily.reference)}</span> }}
    secondary={
    <span data-site-today>
      {retained ? <ActivityPace day={retained} nowMs={nowMs} /> : pace ? <PaceFigure pace={pace} /> : <span className="wall-metric-note">Comparison unavailable</span>}
    </span>} chart={<>
    <div className={cn("wall-site-chart", !retained && performanceToneClass(pace?.paceChange == null ? "neutral" : wallTrafficTone(pace.paceChange)))} data-site-today-chart data-tone={retained ? undefined : pace?.paceChange == null ? "neutral" : wallTrafficTone(pace.paceChange)}>
      {retained ? <RealtimeTodayChart day={retained} nowMs={nowMs} weight="row" reference={reference} /> : hourly ? <TodayVsLastWeek hourly={hourly} weight="row" nowHour={nowHour} reference={reference} /> : null}
    </div>
    <div className="wall-site-axis"><span>{retained ? "avg users/min" : "active users"}</span>{pace && !retained ? <PaceWindow pace={pace} /> : <span>0–24h</span>}</div>
  </>} />;
}

function TrendMetric({ asset }: { asset: AssetCard }) {
  const { binding } = useWallMetricBinding();
  const reference = !binding?.configured || binding.tile.reference !== false;
  const weeks = fourWeeks(asset.activeUsers);
  const drawn = weeks && weeks.days.some(day => day.value !== null) ? weeks : null;
  return <SparklineCompareMetric title="4 weeks" icon={ChartNoAxesCombined} value={
    <span data-site-trend>{weeks?.change ? <span data-site-week><DeltaChip value={weeks.change.percent} render={value => `${formatPercent(value)}%`} tone={wallTrafficTone(weeks.change.percent)} meaning="Last 4 weeks vs the 4 before" /></span> : <span className="wall-metric-note">Comparison unavailable</span>}</span>} comparison={weeks?.change ? "vs prior 4 wk" : undefined} chart={<>
    <div className="wall-site-chart" role="img" aria-label={`${asset.displayName} daily active users`} data-site-chart="row">{drawn ? <FourWeekLine weeks={drawn} weight="row" reference={reference} /> : <span className="wall-metric-note">History unavailable</span>}</div>
    {drawn ? <div className="wall-site-axis" data-site-weeks-axis><span>{formatSeriesDate(drawn.days[0]!.date)}</span><span>{formatSeriesDate(drawn.days.at(-1)!.date)}</span></div> : null}
  </>} />;
}

function lastWeekdayLabel(zone: string | null, nowMs: number): string {
  if (!zone) return "last week";
  try {
    return `last ${new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: zone }).format(new Date(nowMs))}`;
  } catch {
    return "last week";
  }
}



function PaceFigure({ pace }: { pace: IntradayUsersPace }) {
  if (pace.paceChange === null) return <span className="wall-metric-note">Gathering pace</span>;
  return (
    <DeltaChip
      value={pace.paceChange}
      render={(value) => `${formatPercent(value)}%`}
      tone={wallTrafficTone(pace.paceChange)}
      meaning={`${formatPercent(Math.abs(pace.paceChange))}% ${paceDirectionLabel(pace.paceChange)}; completed hours today vs ${pace.priorDayLabel}`}
      className="whitespace-nowrap"
    />
  );
}

/** The cutoff stays visible without taking width from the hourly chart. */
function PaceWindow({ pace, className }: { pace: IntradayUsersPace; className?: string }) {
  return (
    <span className={cn("whitespace-nowrap text-wall-micro text-muted-foreground tabular-nums", className)} data-pace-window={pace.paceChange === null ? "silent" : "shown"}>
      {paceWindowLabel(pace)}
    </span>
  );
}



function RealtimeTodayChart({ day, nowMs, weight, reference = true }: { day: Ga4RealtimeDay; nowMs: number; weight: ChartWeight; reference?: boolean }) {
  const style = WEIGHT[weight];
  const minute = Math.floor(nowMs / 60_000);
  const activity = useMemo(() => realtimeActivity(day, minute * 60_000), [day, minute]);
  const todayValues = activity.hours.map(hour => hour.today);
  const priorValues = activity.hours.map(hour => hour.prior);
  const max = Math.max(1, ...[...todayValues, ...priorValues].filter((value): value is number => value !== null));
  const at = (index: number, value: number): ChartPoint => ({ x: 20 + index / 23 * 960, y: 100 - value / max * 86 });
  const runs = (values: (number | null)[]) => readingRuns(values).map(run => run.map(point => at(point.index, point.value)));
  const lastHour = todayValues.findLastIndex(value => value !== null);
  const end = lastHour < 0 ? null : at(lastHour, todayValues[lastHour]!);
  return (
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" role="img"
      aria-label={`Hourly average active users per minute today, ${day.timeZone}; missing hours are gaps; live activity is provisional${reference ? activity.hasPrior ? "; dashed line is the same weekday last week" : "; last week comparison pending" : ""}`}>
      {reference && activity.hasPrior ? <ChartLine runs={runs(priorValues)} kind="ghost" width={style.ghost} data-realtime-prior /> : null}
      <g data-realtime-today><ChartLine runs={runs(todayValues)} width={style.line} /></g>
      {end ? <ChartDot at={end} size={style.dot} halo={false} /> : null}
    </svg>
  );
}

function ActivityPace({ day, nowMs }: { day: Ga4RealtimeDay; nowMs: number }) {
  const minute = Math.floor(nowMs / 60_000);
  const activity = useMemo(() => realtimeActivity(day, minute * 60_000), [day, minute]);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: day.timeZone, weekday: "short" }).format(new Date(nowMs));
  const through = activity.through ? new Intl.DateTimeFormat("en-US", { timeZone: day.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(activity.through)) : null;
  const meaning = `Provisional activity today so far vs last ${weekday}, across ${activity.comparedMinutes} matching minutes${through ? `, to ${through}` : ""}. Includes earlier hours; the chart shows each hour separately. Per-minute active users, not distinct hourly or daily users. Unreported minutes are excluded; GA4 processing can revise recent data.${day.comparisonError ? " The historical comparison refresh is unavailable." : ""}`;
  return activity.change !== null ? (
    <span className="inline-flex flex-col items-end" title={meaning}>
      <DeltaChip value={activity.change} render={value => `${Math.round(value)}%`} tone={wallTrafficTone(activity.change)} meaning={meaning} />
      <span className="text-wall-micro text-muted-foreground">day so far</span>
    </span>
  ) : <span className="text-wall-micro text-muted-foreground" title={meaning}>{activity.hasPrior ? "Gathering pace" : day.comparisonError && day.comparisonError !== "ga4_comparison_waiting" ? "Last week unavailable" : "Last week pending"}</span>;
}

/** Where an hour sits across the box, in percent: the whole day, inset so the
 * filling hour's halo is never cut at either edge. */
const hourX = (hour: number) => 2 + (hour / 23) * 96;

/** How heavy a chart is drawn, by where it sits. Stroke widths are for a TV
 * read from three metres, and the dot grows with them. */
type ChartWeight = "row" | "roomy" | "focus";

const WEIGHT: Record<ChartWeight, { line: number; ghost: number; dot: "md" | "lg"; floor: boolean }> = {
  row: { line: 2.5, ghost: 2, dot: "md", floor: false },
  roomy: { line: 3.5, ghost: 2.5, dot: "md", floor: true },
  focus: { line: 4, ghost: 2.5, dot: "lg", floor: true },
};

/** The chart's zero: one crisp hairline, drawn where a chart has room for it. */
function Floor() {
  return <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border" aria-hidden />;
}

/**
 * Today by hour in the pace's tone over the same weekday last week, dashed.
 * The now point breathes at the clock (`nowHour`): on today's line while its
 * newest hour is the one the clock is in; when the data lags, the line ends in
 * a still dot and the breathing one waits at the clock on the floor, so the
 * gap between them is the lag. A 1000×100 viewBox stretched to the caller's
 * box, with non-scaling strokes and round-stroke dots so nothing squashes.
 */
function TodayVsLastWeek({ hourly, weight, nowHour, reference = true }: { hourly: HourlyActiveUsers; weight: ChartWeight; nowHour: number | null; reference?: boolean }) {
  const style = WEIGHT[weight];
  const max = Math.max(1, ...hourly.map((point) => Math.max(point.sameDayLastWeek, point.today ?? 0)));
  // Zero on the floor; the busiest hour a little under the top, so a line at
  // its peak and the dot on it are never cut.
  const y = (value: number) => 100 - (value / max) * 86;
  const at = (hour: number, value: number): ChartPoint => ({ x: hourX(hour) * 10, y: y(value) });
  const lastWeek = hourly.map((point) => at(point.hour, point.sameDayLastWeek));
  const todayRuns = readingRuns(hourly.map((point) => point.today)).map((run) =>
    run.map((point) => at(hourly[point.index]!.hour, point.value)),
  );
  const end = todayRuns.at(-1)?.at(-1);
  const newestHour = [...hourly].reverse().find((point) => point.today !== null)?.hour ?? null;
  // The data is current while its newest hour is the hour the clock is in.
  const lagging = end !== undefined && nowHour !== null && newestHour !== null && Math.floor(nowHour) > newestHour;
  const now: ChartPoint | null = lagging ? { x: Math.max(end.x, hourX(nowHour) * 10), y: 100 } : null;
  return (
    <span className="relative block size-full">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" role="img" aria-hidden>
        {reference ? <ChartLine runs={[lastWeek]} kind="ghost" width={style.ghost} data-last-week /> : null}
        <ChartArea runs={todayRuns} baseline={100} strength={0.38} fadeEnd={0.22} />
        <ChartLine runs={todayRuns} width={style.line} data-today />
        {end && now ? <ChartDot at={end} size="sm" data-data-end /> : null}
        {now ? <ChartDot at={now} size={style.dot} live data-now /> : end ? <ChartDot at={end} size={style.dot} live data-filling-hour data-now /> : null}
      </svg>
      {style.floor ? <Floor /> : null}
    </span>
  );
}

function FourWeekLine({ weeks, weight, reference = true }: { weeks: FourWeeks; weight: ChartWeight; reference?: boolean }) {
  const style = WEIGHT[weight];
  const values = weeks.days.flatMap((day) => [day.value, weeks.hasPrior ? day.prior : null]).filter((v): v is number => v !== null);
  const low = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - low);
  // Inset so the newest day's dot is never cut at the box's edge.
  const at = (index: number, value: number): ChartPoint => ({
    x: 25 + (index / (weeks.days.length - 1)) * 950,
    y: 88 - ((value - low) / span) * 76,
  });
  const now = readingRuns(weeks.days.map((day) => day.value)).map((run) => run.map((point) => at(point.index, point.value)));
  const prior = weeks.hasPrior ? [weeks.days.map((day, index) => at(index, day.prior!))] : [];
  const last = now.at(-1)?.at(-1);
  return (
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
      {reference && weeks.hasPrior ? <ChartLine runs={prior} kind="ghost" width={style.ghost} data-prior-weeks /> : null}
      <ChartLine runs={now} width={style.line - 0.5} data-trend-line />
      {last ? <ChartDot at={last} size="md" halo={false} /> : null}
    </svg>
  );
}
