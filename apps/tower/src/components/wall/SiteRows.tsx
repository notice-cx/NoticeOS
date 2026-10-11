import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract";
import type { CSSProperties, ReactNode } from "react";
import { Globe } from "lucide-react";
import type { AssetCard } from "@shared/wall";
import { clockHourNow, intradayUsersPace, paceWindowLabel, type IntradayUsersPace } from "@/lib/intraday-pace";
import { DeltaChip, paceDirectionLabel, paceTone, performanceToneClass } from "@/components/DeltaChip";
import { AgeBadge } from "@/components/AgeBadge";
import { ageMs, isAmber } from "@shared/freshness";
import { CADENCE_HOURS } from "@shared/wall";
import { visiblePulseCounters, type WallPulseMetrics } from "@/lib/wall-counters";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { ChartArea, ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import { LIVE_HEADING, LiveUsers } from "@/components/wall/LiveUsers";
import { readingRuns, type ChartPoint } from "@/lib/chart-path";
import { formatInt, formatPercent, formatPeriodMonthLong, formatSeriesDate, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { siteHealth } from "@/lib/site-health";
import { siteMark, type SiteMark, type WallIssue } from "@/lib/wall-issues";
import {
  focusTiles,
  currentHourlyReading,
  latestFinishedUsers,
  fourWeeks,
  type FocusTiles,
  type FourWeeks,
  type HourlyActiveUsers,
  type SearchTile,
  type TodayTile,
  type VisitorsTile,
  type WeeklyChange,
} from "@/lib/wall-sites";

// The TV shows traffic charts and each site's selected pulse totals. Rows share
// the available height; charts and type grow with that room. One site uses the
// focus tiles. The Wall editor and renderer share the same metric selection.

export interface SiteRowsProps {
  assets: readonly AssetCard[];
  pulseMetrics?: WallPulseMetrics;
  /** Every open problem (`wallIssues`), for the site's health indicator. */
  issues: readonly WallIssue[];
  ga4Realtime?: Ga4RealtimePayload;
  ga4RealtimeError?: boolean;
  nowMs: number;
}

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

/** Shared column tracks keep sites aligned. Charts take spare width, and each
 * asset takes a share of the available height. Narrow regions stack as cards. */
const TABLE = "flex flex-col sites:grid sites:content-start sites:gap-x-3 sites-wide:gap-x-4";
const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 sites:col-span-full sites:grid-cols-subgrid";

/**
 * How the site region is drawn, by the number of sites alone: one site in
 * depth (`focus`), two or three in taller rows with larger charts
 * (`comfortable`), four and more in compact rows.
 */
export type SiteRowDensity = "focus" | "comfortable" | "compact";

/** The site counts the tiers stop at. */
export const FOCUS_SITES = 1;
export const COMFORTABLE_MAX_SITES = 3;

/** The one place a Wall's number of sites picks how its sites are drawn. */
export function siteRowDensity(siteCount: number): SiteRowDensity {
  if (siteCount === FOCUS_SITES) return "focus";
  if (siteCount > FOCUS_SITES && siteCount <= COMFORTABLE_MAX_SITES) return "comfortable";
  return "compact";
}

/** The two row sizes; the focus tier draws its one site's row roomy when it
 * has nothing to show in depth. */
type RowSize = Exclude<SiteRowDensity, "focus">;

interface RowStyle {
  /** The table's column and row tracks. */
  table: string;
  row: string;
  favicon: string;
  name: string;
  /** The live count's type step. */
  live: string;
  /** How heavy the row's charts are drawn (`ChartWeight`). */
  weight: ChartWeight;
  /** A saved daily reading when hourly data is unavailable. */
  figure: string;
  /** The words after the change ("vs prior 4 wk"), a step under its figure. */
  weekUnit: string;
  /** Muted words in a figure's place: "no revenue source", "Waiting…". */
  quiet: string;
  /**
   * Row charts keep their content floor; filling charts use the extra height
   * available without selected totals. Today overlays its pace; the four-week
   * comparison sits outside its plot.
   */
  charts: "row" | "filling";
  today: string;
  trend: string;
  /** What holds the four-week chart with its first and last day under it. */
  trendFrame: string;
}

const ROW_SIZE: Record<RowSize, RowStyle> = {
  // Compact rows share their height with pulse totals beneath the site name.
  compact: {
    table:
      "sites:grid-cols-[minmax(12.5rem,1.2fr)_auto_minmax(9rem,0.7fr)_minmax(min-content,1fr)] sites-wide:grid-cols-[minmax(14.5rem,1.2fr)_auto_minmax(9rem,0.7fr)_minmax(min-content,1fr)] sites:grid-rows-[auto] sites:auto-rows-[minmax(min-content,1fr)]",
    row: "py-2 sites:py-1 sites:min-h-(--spacing-wall-site-row-min)",
    favicon: "size-7 text-sm",
    name: "text-[length:var(--text-wall-site-name)]",
    live: "text-[length:var(--text-wall-site-live)]",
    weight: "row",
    figure: "text-[length:var(--text-wall-site-stat)] leading-tight",
    weekUnit: "text-[length:var(--text-wall-site-label)]",
    quiet: "text-wall-body",
    charts: "row",
    today: "h-20 w-full min-w-0 sites:h-auto sites:min-h-12 sites:flex-1",
    trend: "h-20 w-full min-w-0 sites:h-auto sites:min-h-10 sites:flex-1",
    trendFrame: "min-h-0 flex-1",
  },
  // With fewer sites, charts use the larger share of the region's height.
  comfortable: {
    table:
      "sites:grid-cols-[minmax(15rem,1.2fr)_auto_minmax(9rem,0.7fr)_minmax(9rem,1fr)] sites-wide:grid-cols-[minmax(18rem,1.2fr)_auto_minmax(9rem,0.7fr)_minmax(12rem,1fr)] sites:grid-rows-[auto] sites:auto-rows-[minmax(min-content,1fr)]",
    row: "py-3 sites:py-0",
    favicon: "size-9 text-base",
    name: "text-[length:var(--text-wall-site-name)]",
    live: "text-[length:var(--text-wall-site-live)]",
    weight: "roomy",
    figure: "text-[length:var(--text-wall-site-stat)] leading-tight",
    weekUnit: "text-[length:var(--text-wall-site-label)]",
    quiet: "text-lg",
    charts: "filling",
    today: "",
    trend: "",
    trendFrame: "",
  },
};

/** Selected totals share a comfortable row's height with its charts. */
function rowStyle(size: RowSize, totals: boolean): RowStyle {
  const style = ROW_SIZE[size];
  return size === "comfortable" && totals ? { ...style, charts: "row", today: ROW_SIZE.compact.today, trend: ROW_SIZE.compact.trend, trendFrame: ROW_SIZE.compact.trendFrame } : style;
}

/** The weekday a week ago is today's weekday, on the zone the hours were
 * bucketed in (`Ga4RealtimeSuccess.timeZone`). */
function lastWeekdayLabel(realtime: Ga4RealtimePayload | undefined, nowMs: number): string {
  const zone = realtime?.assets.find((asset) => asset.status === "success")?.timeZone;
  if (!zone) return "last week";
  try {
    return `last ${new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: zone }).format(new Date(nowMs))}`;
  } catch {
    return "last week";
  }
}

export function SiteRows({ assets, pulseMetrics, issues, ga4Realtime, ga4RealtimeError = false, nowMs }: SiteRowsProps) {
  const lastWeekday = lastWeekdayLabel(ga4Realtime, nowMs);
  const density = siteRowDensity(assets.length);
  const snapshotOf = (asset: AssetCard) => ga4Realtime?.assets.find((snapshot) => snapshot.asset === asset.id);
  const hasDatedHistory = assets.some((asset) => !currentHourlyReading(snapshotOf(asset), nowMs) && latestFinishedUsers(asset.activeUsers) !== null);

  // A new installation: no headings over nothing. A TV has no controls, so
  // the way forward is the desk's Add a site, not a prompt here.
  if (assets.length === 0) {
    return (
      <section
        aria-label="Sites"
        className="flex min-w-0 items-center gap-3 self-start text-wall-body text-muted-foreground"
        data-wall-sites="none"
      >
        <Globe className="size-6 shrink-0" aria-hidden />
        No sites yet
      </section>
    );
  }

  if (density === "focus") {
    const only = assets[0]!;
    const tiles = focusTiles(only, snapshotOf(only), nowMs);
    if (tiles.today || tiles.visitors || tiles.search) {
      return (
        <SiteFocus
          asset={only}
          pulseMetrics={pulseMetrics}
          mark={siteMark(issues, only.id)}
          tiles={tiles}
          reconnecting={ga4RealtimeError}
          nowMs={nowMs}
          lastWeekday={lastWeekday}
        />
      );
    }
    // Nothing to show in depth yet: the site's own row says what it has.
  }

  const size: RowSize = density === "compact" ? "compact" : "comfortable";
  const compactTotals = size === "compact" && assets.some((asset) => visiblePulseCounters(asset, pulseMetrics).length > 0);
  return (
    <section aria-label="Sites" className="flex h-full min-h-0 min-w-0 flex-col" style={{ "--site-rows": assets.length } as CSSProperties} data-wall-sites data-site-density={density}>
      <div
        role="table"
        aria-label="Sites"
        // Rows past the region's height scroll inside it under the headings
        // rather than the Wall falling back to one column.
        className={cn("min-h-0 flex-1 tv:overflow-y-auto", TABLE, ROW_SIZE[size].table, compactTotals && "sites:grid-cols-[minmax(12.5rem,1.6fr)_auto_minmax(9rem,0.6fr)_minmax(min-content,1fr)] sites-wide:grid-cols-[minmax(14.5rem,1.6fr)_auto_minmax(9rem,0.6fr)_minmax(min-content,1fr)]")}
        // Row count controls the region's responsive type scale.
        style={{ "--site-rows": assets.length } as CSSProperties}
      >
        <div role="row" className={cn(ROW, "hidden px-4 pb-2 sites:grid tv:sticky tv:top-0 tv:z-10 tv:bg-background")} data-site-header>
          <span role="columnheader" className={eyebrow}>Site</span>
          <span role="columnheader" className={`${eyebrow} whitespace-nowrap`}>{LIVE_HEADING}</span>
          {/* Scaled, today's column may narrow under its heading, which then
              takes two lines. */}
          <span role="columnheader" className={`${eyebrow} whitespace-nowrap scaled:whitespace-normal scaled:text-balance`}>{hasDatedHistory ? "Today / latest day" : `Today vs ${lastWeekday}`}</span>
          <span role="columnheader" className={eyebrow}>4 weeks</span>
        </div>
        {assets.map((asset) => (
          <SiteRow
            key={asset.id}
            asset={asset}
            pulseMetrics={pulseMetrics}
            mark={siteMark(issues, asset.id)}
            snapshot={snapshotOf(asset)}
            reconnecting={ga4RealtimeError}
            nowMs={nowMs}
            size={size}
          />
        ))}
      </div>
    </section>
  );
}

/** Names wrap within their existing track; the health mark keeps its space. */
function SiteName({ asset, favicon, name, mark }: { asset: AssetCard; favicon: string; name: string; mark: SiteMark | null }) {
  return (
    <>
      <PropertyFavicon
        domain={asset.id}
        displayName={asset.displayName}
        className={`${favicon} shrink-0 rounded-md bg-muted font-bold text-foreground`}
      />
      <span className={`min-w-0 flex-1 whitespace-normal wrap-anywhere leading-tight ${name} font-semibold`} title={asset.displayName} data-site-label>
        {asset.displayName}
      </span>
      <SiteHealth asset={asset} mark={mark} site={asset.id} />
    </>
  );
}

function SiteRow({
  asset,
  pulseMetrics,
  mark,
  snapshot,
  reconnecting,
  nowMs,
  size,
}: {
  asset: AssetCard;
  pulseMetrics: WallPulseMetrics;
  mark: SiteMark | null;
  snapshot: Ga4RealtimeAsset | undefined;
  reconnecting: boolean;
  nowMs: number;
  size: RowSize;
}) {
  const style = ROW_SIZE[size];
  const hasData =
    asset.pulseReceivedAt !== null || asset.activeUsers.series.length > 0 || snapshot?.status === "success" || asset.counters?.cards.some((card) => card.value !== null) === true;
  const hasTotals = visiblePulseCounters(asset, pulseMetrics).length > 0;
  const inlineTotals = size === "compact" && hasTotals;
  const nameFacts = <SiteName asset={asset} favicon={style.favicon} name={style.name} mark={mark} />;
  const name = (
    <span role="cell" className={cn("flex min-w-0 gap-3", inlineTotals ? "flex-col items-stretch gap-y-0" : "items-center")} data-site-name>
      {inlineTotals ? <><span className="flex min-w-0 items-center gap-3">{nameFacts}</span><PulseTotals asset={asset} choices={pulseMetrics} nowMs={nowMs} inline /></> : nameFacts}
    </span>
  );
  const row = cn(ROW, "items-center border-t border-border/60 px-4", style.row, inlineTotals && "sites:py-0", !inlineTotals && hasTotals && "sites:grid-rows-[minmax(0,1fr)_auto]");

  if (!hasData) {
    return (
      <div role="row" className={row} data-site-row={asset.id} data-site-density={size} data-site-state="waiting">
        {name}
        <span role="cell" className={`whitespace-nowrap ${style.quiet} text-muted-foreground sites:col-span-3`} data-site-waiting>
          {/* No report has arrived, so none is expected. */}
          No data yet
        </span>
      </div>
    );
  }

  const current = currentHourlyReading(snapshot, nowMs);
  const pace = intradayUsersPace(asset, current ?? undefined);
  return (
    <div role="row" className={row} data-site-row={asset.id} data-site-density={size}>
      {name}
      <LiveUsers asset={asset} snapshot={snapshot} reconnecting={reconnecting} nowMs={nowMs} face={style.live} size={size === "compact" ? "row" : "roomy"} />
      <TodayCell asset={asset} snapshot={current ?? undefined} pace={pace} size={size} totals={hasTotals} nowMs={nowMs} />
      <TrendCell asset={asset} size={size} totals={hasTotals} />
      {!inlineTotals && <PulseTotals asset={asset} choices={pulseMetrics} nowMs={nowMs} cell />}
    </div>
  );
}

/** A site's own counts, selected in the Wall editor; missing is never zero. */
function PulseTotals({ asset, choices, nowMs, cell = false, inline = false }: { asset: AssetCard; choices: WallPulseMetrics; nowMs: number; cell?: boolean; inline?: boolean }) {
  const cards = visiblePulseCounters(asset, choices);
  if (!cards.length || !asset.counters) return null;
  return (
    <div role={cell ? "cell" : undefined} className={cn("flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 pb-1", inline && "gap-y-0 pb-0", !inline && "col-span-full sites:pl-10")} data-site-totals={asset.id}>
      <dl className={cn("flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-1", inline && "gap-x-3 gap-y-0")}>
        {cards.map((card) => {
          const cadence = card.source === "nightly" ? CADENCE_HOURS.pulse : asset.counters!.cadenceHours;
          const stale = isAmber(nowMs, card.observedAt, cadence);
          const unknownAge = ageMs(nowMs, card.observedAt) === null;
          return (
            <div key={card.metric} className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", inline && "gap-y-0")} data-site-total={card.metric}>
              <dt className="order-2 text-[length:var(--text-wall-site-label)] text-muted-foreground">{card.label}</dt>
              <dd className={cn("order-1 text-[length:var(--text-wall-site-stat)] font-semibold leading-tight tabular-nums", stale ? "text-muted-foreground" : "text-foreground")}>{formatInt(card.value!)}</dd>
              {stale || unknownAge ? <AgeBadge iso={card.observedAt} cadenceHours={cadence} nowMs={nowMs} className="order-3" /> : null}
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** The pace's tone: none while its hours carry no verdict. */
const paceStep = (pace: IntradayUsersPace | null) => (pace?.paceChange == null ? "neutral" : paceTone(pace.paceChange));

/** The visible arrow carries direction; accessible text spells it out. */
function PaceFigure({ pace, className }: { pace: IntradayUsersPace; className: string }) {
  if (pace.paceChange === null) return null;
  return (
    <DeltaChip
      value={pace.paceChange}
      render={(value) => `${formatPercent(value)}%`}
      tone={paceTone(pace.paceChange)}
      meaning={`${formatPercent(Math.abs(pace.paceChange))}% ${paceDirectionLabel(pace.paceChange)}; completed hours today vs ${pace.priorDayLabel}`}
      className={`whitespace-nowrap ${className} font-semibold`}
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

function TodayCell({
  asset,
  snapshot,
  pace,
  size,
  totals,
  nowMs,
}: {
  asset: AssetCard;
  snapshot: Ga4RealtimeAsset | undefined;
  pace: IntradayUsersPace | null;
  size: RowSize;
  totals: boolean;
  nowMs: number;
}) {
  const hourly = snapshot?.status === "success" ? snapshot.hourlyActiveUsers : null;
  const nowHour = snapshot?.status === "success" ? clockHourNow(nowMs, snapshot.timeZone) : null;
  const tone = paceStep(pace);
  const style = rowStyle(size, totals);
  const saved = hourly === null ? latestFinishedUsers(asset.activeUsers) : null;
  if (saved) {
    return (
      <span role="cell" className={FILLING_CELL} data-site-history data-history-source="ga4" data-date={saved.t}>
        <span className={`flex flex-wrap items-center gap-x-2 ${style.weekUnit} text-muted-foreground`}>
          <span>Latest day · <time dateTime={saved.t}>{formatSeriesDate(saved.t)}</time></span>
          {ageMs(nowMs, asset.activeUsers.collectedAt) === null || isAmber(nowMs, asset.activeUsers.collectedAt, CADENCE_HOURS.signals)
            ? <AgeBadge iso={asset.activeUsers.collectedAt} cadenceHours={CADENCE_HOURS.signals} nowMs={nowMs} className={style.weekUnit} />
            : null}
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2" aria-label={`People on ${saved.t}: ${formatInt(saved.v)}`}>
          <span className={`${style.figure} font-semibold tabular-nums`}>{formatInt(saved.v)}</span>
          <span className={`${style.weekUnit} text-muted-foreground`}>people</span>
        </span>
      </span>
    );
  }
  const figure = pace ? (
    <PaceFigure pace={pace} className={COMPARISON_TYPE} />
  ) : (
    <span className={`${COMPARISON_TYPE} text-muted-foreground`}>—</span>
  );
  const chart = (box: string) =>
    hourly ? (
      <span className={`${performanceToneClass(tone)} block ${box}`} data-tone={tone} data-site-chart={style.charts}>
        <TodayVsLastWeek hourly={hourly} weight={style.weight} nowHour={nowHour} />
      </span>
    ) : null;
  return (
    <span role="cell" className={cn(CHART_CELL, "pb-5")} data-site-today>
      <span className={COMPARISON_OVERLAY} data-site-comparison>{figure}</span>
      {chart(style.charts === "filling" ? FILLING_CHART : style.today)}
      {pace ? <PaceWindow pace={pace} className="absolute bottom-0 right-0" /> : null}
    </span>
  );
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
function TodayVsLastWeek({ hourly, weight, nowHour }: { hourly: HourlyActiveUsers; weight: ChartWeight; nowHour: number | null }) {
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
        <ChartLine runs={[lastWeek]} kind="ghost" width={style.ghost} data-last-week />
        <ChartArea runs={todayRuns} baseline={100} strength={0.38} fadeEnd={0.22} />
        <ChartLine runs={todayRuns} width={style.line} data-today />
        {end && now ? <ChartDot at={end} size="sm" data-data-end /> : null}
        {now ? <ChartDot at={now} size={style.dot} live data-now /> : end ? <ChartDot at={end} size={style.dot} live data-filling-hour data-now /> : null}
      </svg>
      {style.floor ? <Floor /> : null}
    </span>
  );
}

/** "↑18% vs prior 4 wk": the last four weeks against the four before (the
 * rows and the search tile), or "↓8.2% wk", the latest 7 days against the 7
 * before (the visitors tile, whose bars light that week). */
function PeriodChange({
  change,
  span,
  className,
  unit = "",
  stacked = false,
}: {
  change: WeeklyChange;
  span: "week" | "four-weeks";
  className: string;
  /** The words' own step, when they sit a step under the figure. */
  unit?: string;
  /** The words under the figure rather than after it: a site row's
   * cell, where the columns beside it need their width. */
  stacked?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap font-semibold",
        stacked ? "flex-col items-start" : "flex-wrap items-baseline gap-x-1",
        className,
      )}
      data-site-week
    >
      <DeltaChip
        value={change.percent}
        render={(value) => `${formatPercent(value)}%`}
        tone={change.tone}
        meaning={span === "week" ? "Latest 7 days vs the 7 before" : "Last 4 weeks vs the 4 before"}
        className={`${className} font-semibold`}
      />
      <span className={cn("text-muted-foreground", unit, stacked && "font-normal leading-tight")}>
        {span === "week" ? "wk" : "vs prior 4 wk"}
      </span>
    </span>
  );
}

/** The first and last day a four-week chart draws, at its two ends. On a
 * chart narrowed past the two dates they are left out rather than run
 * together: the holder is a container in the axis's own type, so "7.5em" is
 * the dates' width at any size. The dates keep a line taller than the font's
 * ascent and descent, so they never paint below their box. */
function WeeksAxis({ weeks }: { weeks: FourWeeks }) {
  return (
    <span className="block text-wall-axis scaled:@container">
      <span
        className="flex justify-between text-wall-axis text-muted-foreground tabular-nums scaled:@max-[7.5em]:hidden"
        aria-hidden
        data-site-weeks-axis
      >
        <span>{formatSeriesDate(weeks.days[0]!.date)}</span>
        <span>{formatSeriesDate(weeks.days.at(-1)!.date)}</span>
      </span>
    </span>
  );
}

/** Daily active users over the last four weeks as one line in the traffic
 * colour over the four weeks before, dashed — weekday under weekday — with
 * the two spans' smaller change to its right, top-aligned and outside the plot,
 * with the dates under the line. */
function TrendCell({ asset, size, totals }: { asset: AssetCard; size: RowSize; totals: boolean }) {
  const weeks = fourWeeks(asset.activeUsers);
  const style = rowStyle(size, totals);
  const drawn = weeks !== null && weeks.days.filter((day) => day.value !== null).length > 1 ? weeks : null;
  const change = weeks?.change ? (
    <PeriodChange
      change={weeks.change}
      span="four-weeks"
      className={COMPARISON_TYPE}
      unit="text-[length:calc(var(--wall-micro-size)*var(--wall-boost-micro,1))]"
      stacked
    />
  ) : null;
  const chart = (box: string, frame: string) =>
    drawn ? (
      <span className={`flex min-w-0 flex-col gap-0.5 self-stretch ${frame}`}>
        <span
          className={`relative block text-traffic ${box}`}
          role="img"
          aria-label={`${asset.displayName} daily active users, ${formatSeriesDate(drawn.days[0]!.date)} to ${formatSeriesDate(drawn.days.at(-1)!.date)}`}
          data-site-chart={style.charts}
        >
          <FourWeekLine weeks={drawn} weight={style.weight} />
        </span>
        <WeeksAxis weeks={drawn} />
      </span>
    ) : null;
  return (
    <span role="cell" className={cn(CHART_CELL, "flex-row items-start gap-2")} data-site-trend>
      {chart(style.charts === "filling" ? FILLING_CHART : style.trend, style.charts === "filling" ? "min-h-0 flex-1" : style.trendFrame)}
      {change ? <span className="flex shrink-0 justify-end [&>[data-site-week]]:items-end" data-site-comparison>{change}</span> : null}
    </span>
  );
}

/**
 * The last four weeks' SHAPE, scaled from the lowest day to the highest of
 * both spans like the desk's `Sparkline`, in the caller's ink, over the four
 * weeks before as the charts' comparison line (`ghost`: dashed, neutral) on
 * the same scale, each day above the same weekday. It ends on its newest day
 * in a plain dot — yesterday is settled, so no halo; a halo marks now. No
 * wash: a line scaled low to high has no zero to fill down to.
 */
function FourWeekLine({ weeks, weight }: { weeks: FourWeeks; weight: ChartWeight }) {
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
      {weeks.hasPrior ? <ChartLine runs={prior} kind="ghost" width={style.ghost} data-prior-weeks /> : null}
      <ChartLine runs={now} width={style.line - 0.5} data-trend-line />
      {last ? <ChartDot at={last} size="md" halo={false} /> : null}
    </svg>
  );
}

/** A roomier row's chart cell: its figure on top, the chart taking the rest of
 * the cell's height and width (a fixed height on a phone, where the row has
 * none to share). */
const FILLING_CELL = "col-span-2 flex min-h-0 min-w-0 flex-col justify-center gap-1 self-stretch py-4 sites:col-span-1 sites:py-1";
const FILLING_CHART = "relative h-20 w-full min-w-0 sites:h-auto sites:min-h-10 sites:flex-1";

/** Today's small pace floats over its plot without taking width or height. */
const CHART_CELL = "relative col-span-2 flex min-h-0 min-w-0 flex-col self-stretch sites:col-span-1";
const COMPARISON_TYPE = "text-[length:calc(var(--wall-detail-size)*var(--wall-boost-detail,1))] leading-tight";
const COMPARISON_OVERLAY = "absolute right-0 top-0 z-10 bg-background/85 pl-1 text-right";

/** Signal level and colour both carry health. The level is the site's one
 * health word (`siteHealth`), the same word Home, the Sites list and the
 * site's header say. The accessible name is the open problem when there is
 * one, else the word. */
function SiteHealth({ asset, mark, site }: { asset: AssetCard; mark: SiteMark | null; site: string }) {
  const health = siteHealth(asset, mark ? [{ assets: [asset.id], severity: mark.severity }] : []);
  const state = health.key === "off-track" ? "error" : health.key === "at-risk" ? "warn" : health.key === "setting-up" ? "unknown" : "healthy";
  const level = state === "error" ? 1 : state === "warn" ? 2 : state === "healthy" ? 4 : 0;
  const label = mark ? `${mark.label}${mark.more ? `; ${mark.more} more ${mark.more === 1 ? "issue" : "issues"}` : ""}` : health.word;
  return (
    <svg
      role="img"
      aria-label={`Site health: ${label}`}
      viewBox="0 0 20 20"
      className={cn("size-5 shrink-0", state === "error" ? "text-error" : state === "warn" ? "text-warn" : "text-muted-foreground")}
      data-site-health={state}
      data-status-for={`asset:${site}`}
    >
      {[5, 9, 13, 17].map((height, index) => (
        <rect key={height} x={index * 5} y={19 - height} width="3" height={height} rx="1" fill="currentColor" className={index < level ? "opacity-100" : "opacity-20"} />
      ))}
    </svg>
  );
}

// ——— One site, in depth ———————————————————————————————————————————————

/**
 * The region for a Wall with one site: its name and mark, then up to three
 * tiles side by side. Each tile carries its own weight, so a tile left out for
 * want of data hands its width to the others.
 */
function SiteFocus({
  asset,
  pulseMetrics,
  mark,
  tiles,
  reconnecting,
  nowMs,
  lastWeekday,
}: {
  asset: AssetCard;
  pulseMetrics: WallPulseMetrics;
  mark: SiteMark | null;
  tiles: FocusTiles;
  reconnecting: boolean;
  nowMs: number;
  lastWeekday: string;
}) {
  return (
    <section aria-label="Sites" className="flex h-full min-h-0 min-w-0 flex-col gap-3" style={{ "--site-rows": 1 } as CSSProperties} data-wall-sites data-site-density="focus">
      <div className="flex min-w-0 items-center gap-4 border-t border-border/60 px-1 pt-3" data-site-row={asset.id} data-site-density="focus">
        <span className="flex min-w-0 items-center gap-3" data-site-name>
          <SiteName asset={asset} favicon="size-9 text-base" name="text-2xl" mark={mark} />
        </span>
      </div>
      <PulseTotals asset={asset} choices={pulseMetrics} nowMs={nowMs} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 sites:flex-row sites:gap-5" data-focus-tiles>
        {tiles.today ? (
          <TodayFocusTile asset={asset} today={tiles.today} reconnecting={reconnecting} nowMs={nowMs} lastWeekday={lastWeekday} />
        ) : null}
        {tiles.visitors ? <VisitorsFocusTile visitors={tiles.visitors} /> : null}
        {tiles.search ? <SearchFocusTile search={tiles.search} /> : null}
      </div>
    </section>
  );
}

/** One tile's frame: heading, the figures, a chart that takes the height that
 * is left, and the chart's two or three axis words. `weight` is its share of
 * the row among the tiles present. */
function FocusTile({
  kind,
  label,
  weight,
  figures,
  headingMeta,
  axis,
  children,
}: {
  kind: "today" | "visitors" | "search";
  label: string;
  weight: string;
  figures: ReactNode;
  headingMeta?: ReactNode;
  axis: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-h-0 min-w-0 flex-col gap-3 rounded-xl bg-muted/40 p-5", weight)}
      data-focus-tile={kind}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className={`${eyebrow} whitespace-nowrap`}>{label}</h3>
        {headingMeta}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">{figures}</div>
      {/* The chart takes the height the tile has left on the TV; below the
          TV the Wall is one column of content height, where it keeps 10 rem. */}
      <div className="relative h-40 min-h-0 sites:h-auto sites:min-h-40 sites:flex-1" data-focus-chart>
        {children}
      </div>
      <div className="relative flex h-5 justify-between text-wall-micro text-muted-foreground tabular-nums" aria-hidden>
        {axis}
      </div>
    </section>
  );
}

/** A figure and the words that say what it is. In a tile too narrow for both
 * on one line the words move under the figure, whole. */
function Figure({ value, unit, data, second = false }: { value: string; unit: string; data: string; second?: boolean }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 whitespace-nowrap" data-focus-figure={data}>
      {/* `leading-tight`: the hero step's own line is tighter than the
          glyphs, which would paint 3px past the box (`audit:wall-fit --strict`). */}
      <span className={`${second ? "text-2xl font-semibold" : "text-wall-hero-sm leading-tight font-bold"} tracking-tight tabular-nums`}>
        {value}
      </span>
      <span className="text-wall-body text-muted-foreground">{unit}</span>
    </span>
  );
}

const noon = `${hourX(12)}%`;

function TodayFocusTile({
  asset,
  today,
  reconnecting,
  nowMs,
  lastWeekday,
}: {
  asset: AssetCard;
  today: TodayTile;
  reconnecting: boolean;
  nowMs: number;
  lastWeekday: string;
}) {
  const tone = paceStep(today.pace);
  return (
    <FocusTile
      kind="today"
      label={`Today vs ${lastWeekday}`}
      weight="sites:flex-[5_1_0%]"
      headingMeta={today.pace ? <PaceWindow pace={today.pace} /> : null}
      figures={
        <>
          {/* The live count and its minute pulse lead the tile, as they lead
              a row; today's users and the pace follow a step smaller. */}
          <span className="inline-flex" data-focus-figure="live">
            <LiveUsers
              asset={asset}
              snapshot={today.snapshot}
              reconnecting={reconnecting}
              nowMs={nowMs}
              cell={false}
              face="text-wall-hero-sm"
              size="focus"
            />
          </span>
          {today.todayUsers !== null ? <Figure value={formatInt(today.todayUsers)} unit="today" data="today" second /> : null}
          {today.pace ? <PaceFigure pace={today.pace} className="text-2xl" /> : null}
        </>
      }
      axis={
        <>
          <span>12 AM</span>
          <span className="absolute -translate-x-1/2" style={{ left: noon }}>
            12 PM
          </span>
          <span>11 PM</span>
        </>
      }
    >
      <span className={`${performanceToneClass(tone)} absolute inset-0`} data-tone={tone}>
        <TodayVsLastWeek hourly={today.hourly} weight="focus" nowHour={clockHourNow(nowMs, today.snapshot.timeZone)} />
      </span>
    </FocusTile>
  );
}

function VisitorsFocusTile({ visitors }: { visitors: VisitorsTile }) {
  const month = formatPeriodMonthLong(visitors.period);
  return (
    <FocusTile
      kind="visitors"
      label={visitors.hasMoney ? `Visitors and money · ${month}` : `Visitors · ${month}`}
      weight="sites:flex-[4_1_0%]"
      figures={
        <>
          {visitors.perThousand ? (
            <Figure
              value={formatUsd(visitors.perThousand.value, { cents: true })}
              unit={`per 1,000 visitors ${formatSeriesDate(visitors.perThousand.date)}`}
              data="per-thousand"
            />
          ) : visitors.latest ? (
            <Figure value={formatInt(visitors.latest.v)} unit={`visitors ${formatSeriesDate(visitors.latest.t)}`} data="visitors" />
          ) : null}
          {visitors.change ? <PeriodChange change={visitors.change} span="week" className="text-2xl" /> : null}
        </>
      }
      axis={
        <>
          <span>{formatSeriesDate(visitors.days[0]!.date)}</span>
          <span>{formatSeriesDate(visitors.days.at(-1)!.date)}</span>
        </>
      }
    >
      <VisitorsChart visitors={visitors} />
    </FocusTile>
  );
}

/**
 * The month's visitors as bars in the traffic colour, with each reported day's
 * money as one line over them in the revenue colour, each on its own
 * zero-based scale. The bars have rounded tops and one gap between them; the
 * latest complete week — the week the weekly % compares — is drawn brighter,
 * and a day still being counted is hatched, so it never reads as a low day.
 * The money line is cased in the surface so it stays legible across the bars,
 * and ends in a dot on the newest day with money.
 *
 * The bars are HTML — one grid column per day — so their corners stay round
 * and their gaps exact in any box; the line is an SVG over the same columns,
 * each day's point at its column's centre.
 */
function VisitorsChart({ visitors }: { visitors: VisitorsTile }) {
  const { days } = visitors;
  const visitorsMax = Math.max(1, ...days.map((day) => day.visitors ?? 0));
  const moneyMax = Math.max(0.01, ...days.map((day) => day.revenue ?? 0)) * 1.1;
  const moneyY = (value: number) => 100 - (value / moneyMax) * 92;
  const centre = (index: number) => ((index + 0.5) / days.length) * 1000;
  const money = readingRuns(days.map((day) => day.revenue)).map((run) =>
    run.map((point) => ({ x: centre(point.index), y: moneyY(point.value) })),
  );
  const lastMoney = money.at(-1)?.at(-1);
  const recent = new Set(
    days
      .filter((day) => !day.provisional && day.visitors !== null)
      .slice(-7)
      .map((day) => day.date),
  );
  return (
    <>
      <span
        className="absolute inset-0 grid items-end"
        // One column per day of the month so far: layout data, like the
        // Wall's own grid tracks, not a size or a colour.
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {days.map((day) => (
          <span key={day.date} className="flex h-full items-end px-[2px]">
            {day.visitors === null ? null : (
              <span
                className={cn(
                  "block w-full rounded-t-[4px]",
                  day.provisional
                    ? "chart-bar-provisional bg-traffic/15 text-traffic/60"
                    : recent.has(day.date)
                      ? "bg-traffic/85"
                      : "bg-traffic/45",
                )}
                style={{ height: `${Math.max(1, (day.visitors / visitorsMax) * 86)}%` }}
                data-visitors-bar={day.provisional ? "provisional" : "complete"}
              />
            )}
          </span>
        ))}
      </span>
      <svg
        viewBox="0 0 1000 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible text-financial-revenue"
        role="img"
        aria-hidden
      >
        <ChartLine runs={money} width={3.5} casing data-money-line />
        {lastMoney ? <ChartDot at={lastMoney} size="md" halo={false} /> : null}
      </svg>
      <Floor />
    </>
  );
}

function SearchFocusTile({ search }: { search: SearchTile }) {
  const { weeks } = search;
  return (
    <FocusTile
      kind="search"
      label="Search clicks"
      weight="sites:flex-[3.4_1_0%]"
      figures={
        <>
          <Figure value={formatInt(search.latest.v)} unit={`clicks ${formatSeriesDate(search.latest.t)}`} data="clicks" />
          {weeks.change ? <PeriodChange change={weeks.change} span="four-weeks" className="text-2xl" unit="text-lg" /> : null}
        </>
      }
      axis={
        <>
          <span>{formatSeriesDate(weeks.days[0]!.date)}</span>
          <span>{formatSeriesDate(weeks.days.at(-1)!.date)}</span>
        </>
      }
    >
      <span className="absolute inset-0 text-traffic">
        <ClicksChart weeks={weeks} />
      </span>
    </FocusTile>
  );
}

/**
 * Search clicks by day over the last four weeks: a line over a wash that
 * fades to a zero-based floor (a wash is only honest down to zero), ending in
 * a dot on the newest finished day, over the four weeks before, dashed.
 */
function ClicksChart({ weeks }: { weeks: FourWeeks }) {
  const top =
    Math.max(1, ...weeks.days.flatMap((day) => [day.value ?? 0, weeks.hasPrior ? (day.prior ?? 0) : 0])) * 1.1;
  // Inset so the newest day's dot is never cut at the box's edge.
  const at = (index: number, value: number): ChartPoint => ({
    x: 15 + (index / (weeks.days.length - 1)) * 970,
    y: 100 - (value / top) * 100,
  });
  const now = readingRuns(weeks.days.map((day) => day.value)).map((run) => run.map((point) => at(point.index, point.value)));
  const prior = weeks.hasPrior ? [weeks.days.map((day, index) => at(index, day.prior!))] : [];
  const last = now.at(-1)?.at(-1);
  return (
    <>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        {weeks.hasPrior ? <ChartLine runs={prior} kind="ghost" width={2.5} data-prior-weeks /> : null}
        <ChartArea runs={now} baseline={100} strength={0.36} />
        <ChartLine runs={now} width={3.5} data-clicks-line />
        {last ? <ChartDot at={last} size="md" halo={false} /> : null}
      </svg>
      <Floor />
    </>
  );
}
