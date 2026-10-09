import type { AssetDetailPayload } from "@shared/asset-detail";
import {
  deltaMeaning,
  periodDelta,
  windowSeries,
  type PeriodDelta,
  type RangeDays,
  type SurfaceAnnotation,
} from "@shared/surface";
import {
  windowSpansTimeZoneChange,
  distortedDayNote,
  type SignalTrend,
  type TimeZoneChangePoint,
  type WebSearchTrends,
} from "@shared/wall";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { InfoTooltip } from "@/components/InfoTooltip";
import { HeroChart, type HeroSeries } from "@/components/surface/HeroChart";
import { SectionLabel, type SectionLabelAction } from "@/components/surface/SectionLabel";
import type { SeriesTone } from "@/components/surface/Sparkline";
import { formatCalendarRange, formatCompact, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { metricWindow, type Aggregate } from "@/routes/asset-detail/overview-metrics";

/**
 * THE GROWTH TAB'S CHART PANELS, shared (bead `ro-ujb9.136`).
 *
 * Growth draws its audience and search pairs from these; the Search tab draws
 * the same search pair when the site has search numbers but tracks no terms
 * yet, so a site's clicks are one rendering on both tabs. Moved verbatim from
 * GrowthTab.tsx.
 */

/**
 * THE SEARCH PAIR: clicks and impressions, Google and Bing added, one line
 * each — Growth's Search section, and the Search tab's lead until the site
 * tracks terms.
 */
export function SearchPair({
  performance,
  days,
  asset,
  timeline,
  action,
}: {
  performance: AssetDetailPayload["performance"];
  days: RangeDays;
  /** The site's name, for each chart's accessible name. */
  asset: string;
  timeline: readonly SurfaceAnnotation[];
  action?: SectionLabelAction;
}) {
  const search = [
    ...searchTrends(performance.webSearchClicks),
    ...searchTrends(performance.webSearchImpressions),
  ].map((one) => one.trend);
  return (
    <section id="search-performance" className="scroll-mt-4 flex flex-col gap-2">
      <SectionLabel
        title="Search"
        caption={
          <SectionCaption
            label="About search charts"
            text="Google and Bing added, one line each"
            // ONE statement for the pair: a reporting timezone moves for a
            // whole property, so a Search Console change lands on clicks and
            // impressions at once (doc 14, bead `ro-jkp2`).
            caveat={sectionCaveat(search, days)}
          />
        }
        action={action}
      />
      <div className="grid min-w-0 gap-3.5 lg:grid-cols-2">
        <TrendPanel
          title="Clicks"
          trends={searchTrends(performance.webSearchClicks)}
          days={days}
          aggregate="sum"
          unit="from search"
          format={formatInt}
          asset={asset}
          timeline={timeline}
        />
        <TrendPanel
          title="Impressions"
          trends={searchTrends(performance.webSearchImpressions)}
          days={days}
          aggregate="sum"
          unit="appearances"
          // `formatCompact`, matching the Overview's strip: 1.4M is the same
          // number as 1,401,254 and a reader comparing the two tabs must not
          // have to work that out.
          format={formatCompact}
          asset={asset}
          timeline={timeline}
        />
      </div>
    </section>
  );
}

/** One chart's providers, in the order the legend reads them. Google leads
 * because every decision on the Search tab is about Google organic; Bing joins
 * only where it has reported something. */
export function searchTrends(trends: WebSearchTrends): TrendInput[] {
  return [
    { name: "Google", tone: "primary", trend: trends.google },
    ...(trends.bing.series.length > 0
      ? [{ name: "Bing", tone: "bing" as const, trend: trends.bing }]
      : []),
  ];
}

export interface TrendInput {
  name: string;
  tone: SeriesTone;
  trend: SignalTrend;
}

// --- what happened on a day, as marks on the axis --------------------------

/**
 * THE TWO THINGS A CHART OWES ITS OWN X AXIS (doc 21 principle 8).
 *
 * A reporting-timezone change and a recorded deploy are both "something happened
 * on this day", and both change how a reader should judge the shape around them.
 * `HeroChart` draws either as a dashed mark, so neither needs a paragraph.
 *
 * PER CHART, because a reporting timezone belongs to ONE provider's property: a
 * Search Console move is not evidence about a Google Analytics day
 * (`ro-kukv.8`), so a chart is marked from its own series' changes and from the
 * asset's timeline, which is everybody's.
 *
 * A MOVE MARKS TWO DAYS, because moving a day boundary by N hours moves N hours
 * from one day to its neighbour: the change day and the one before it are both
 * wrong by the move alone.
 *
 * The timeline half is `timelineAnnotations` — the Overview's derivation, shared
 * rather than re-typed, so the same deploy is labelled the same sentence
 * wherever it is marked, and never with the row's KIND (bead `ro-78qo.4`).
 */
/** The mark a reporting-timezone day wears, so a caption can tell the two kinds
 * apart: one changes how the numbers may be read, the other says what happened.
 */
const TIMEZONE_GLYPH = "\u26a0";

export function chartAnnotations(
  /** Structural rather than `SignalTrend`, so a merged pair of providers can
   * ask the same question of its own union of changes. */
  trend: { timeZoneChanges: readonly TimeZoneChangePoint[] },
  timeline: readonly SurfaceAnnotation[],
  provider: string,
): SurfaceAnnotation[] {
  const marks: SurfaceAnnotation[] = [];
  for (const change of trend.timeZoneChanges) {
    const dayBefore = new Date(`${change.effectiveOn}T00:00:00.000Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    for (const date of [dayBefore.toISOString().slice(0, 10), change.effectiveOn]) {
      marks.push({
        date,
        glyph: TIMEZONE_GLYPH,
        label: `${provider}: reporting timezone changed`,
        detail: distortedDayNote(change, date),
      });
    }
  }
  return [...marks, ...timeline];
}

// --- the chart pairs -------------------------------------------------------

/**
 * One 180px chart with its headline: what the window totals, which way it moved,
 * and the shape that produced both.
 *
 * ONE OR MORE PROVIDERS, one measurement. The figure comes from `metricWindow`
 * — the asset page's single derivation, the same one the Overview's KPI strip
 * reads — so "search clicks" is one number on this asset whichever tab states
 * it. Before that function existed this panel read Google alone while the strip
 * read Google and Bing added together, and the page printed 16,905 in one place
 * and 25,452 in the other (bead `ro-78qo.4`).
 *
 * The CHART still draws each provider as its own line with its own colour and
 * its own toggle: two providers are one measurement to add up and two lines to
 * look at, and a single merged line would hide which of them moved.
 */
export function TrendPanel({
  title,
  trends,
  days,
  aggregate,
  unit,
  format,
  asset,
  timeline,
}: {
  title: string;
  trends: TrendInput[];
  days: RangeDays;
  aggregate: Aggregate;
  unit: string;
  format: (value: number) => string;
  asset: string;
  timeline: readonly SurfaceAnnotation[];
}) {
  const { merged, settled, value, delta, completedWindow, reportedWindow } = metricWindow(
    trends.map((one) => one.trend),
    days,
    aggregate,
  );
  const visible = new Set(windowSeries(merged.series, days).map((point) => point.t));
  const series: HeroSeries[] = trends.flatMap((one): HeroSeries[] => {
    if (!one.trend.series.some((point) => visible.has(point.t))) return [];
    // HeroChart windows after calculating averages. Earlier reports must reach
    // it as calculation context, without joining the visible range or totals.
    const points = [...(one.trend.contextSeries ?? []), ...one.trend.series];
    return [{ name: one.name, points, tone: one.tone, provisionalFrom: one.trend.provisionalFrom }];
  });
  const differentPeriods = reportedWindow !== null && reportedWindow.end !== completedWindow?.end;

  return (
    <article
      className="min-w-0 rounded-[10px] border border-border bg-card p-4"
      data-growth-chart={title}
    >
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          {value === null ? (
            <span aria-label="Not enough completed reports">—</span>
          ) : (
            <span className="text-foreground">
              {format(value)} {unit}
            </span>
          )}
          <Movement delta={delta} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-1 text-xs tabular-nums text-muted-foreground"
        data-growth-headline-period
        data-window-start={completedWindow?.start}
        data-window-end={completedWindow?.end}>
        {completedWindow ? <>
          <span>{formatCalendarRange(completedWindow.start, completedWindow.end)}</span>
          {settled.length < days ? <span>· {settled.length} of {days} days reported</span> : null}
        </> : <span>No completed reports</span>}
      </div>
      <HeroChart
        title={differentPeriods ? `Chart · ${formatCalendarRange(reportedWindow.start, reportedWindow.end)}` : undefined}
        series={series}
        range={days}
        height={180}
        annotations={trends.flatMap((one) => chartAnnotations(one.trend, timeline, one.name))}
        provisionalFrom={merged.provisionalFrom}
        format={format}
        className="mt-2.5"
        emptyLabel="No reports in this window yet"
        ariaLabel={`${asset} ${title.toLocaleLowerCase("en-US")} over the last ${days} days`}
        // WHAT EACH PROVIDER ADDED TO THE HEADLINE, as counts (bead
        // `ro-ujb9.96.6.5`). The headline's period and its day count are
        // printed above the chart, and a missing provider day is a gap on the
        // line; the one fact not already on screen is how many of the headline
        // days each provider reported.
        footnote={completedWindow && trends.length > 1 ? (
          <span data-provider-coverage>
            {trends.map((one) => (
              <span key={one.name} className="block tabular-nums">
                {one.name} · {one.trend.series.filter((point) => point.t >= completedWindow.start && point.t <= completedWindow.end).length} of {days} days
              </span>
            ))}
          </span>
        ) : undefined}
      />
    </article>
  );
}

/**
 * The period-over-period move, withheld wherever the two windows cannot be
 * compared honestly (doc 14, bead `ro-ujb9.40`).
 *
 * NO ⚠ HERE. A reporting timezone moves for a whole property, so one Search
 * Console change lands on the clicks chart AND the impressions chart beside it;
 * a glyph per headline would be one fact wearing two. The withdrawal is per
 * chip, the STATEMENT of it is per section (`sectionCaveat` below), which is
 * doc 14's own rule.
 */
export function Movement({ delta }: { delta: PeriodDelta | null }) {
  if (delta === null || (delta.comparable && delta.percent === null)) return null;
  return (
    <span className="inline-flex items-center gap-1" data-growth-delta>
      <MovementChip delta={delta} percent={delta.percent} className="text-xs" />
    </span>
  );
}

export function MovementChip({ delta, percent, className }: {
  delta: PeriodDelta;
  percent: number | null;
  className: string;
}) {
  if (!delta.comparable) return <span data-tone="neutral" className={cn("text-muted-foreground", className)}
    aria-label={`Not comparable: ${deltaMeaning(delta)}`}>Not comparable</span>;
  if (percent === null) return null;
  return <DeltaChip value={percent} render={(value) => `${Math.round(value)}%`}
    tone={performanceTone(percent)} meaning={deltaMeaning(delta)} className={className} />;
}

/**
 * The one ⚠ a section owes, or nothing.
 *
 * Only a TIMEZONE change earns the glyph. `comparable` is also false when the
 * two windows cover different numbers of reported days, and that is a different
 * caveat with a different sentence — `deltaMeaning` already carries that one
 * into the chip's own hover, and a ⚠ that meant two things would tell the
 * reader neither.
 */
export function sectionCaveat(
  trends: readonly SignalTrend[],
  days: RangeDays,
): { trend: SignalTrend; window: { start: string; end: string }; change: TimeZoneChangePoint } | null {
  for (const trend of trends) {
    const delta = periodDelta(
      trend.series,
      days,
      trend.timeZoneChanges,
      trend.provisionalFrom,
    );
    if (delta === null) continue;
    // THE WHOLE SPAN THE COMPARISON COVERS, both sides — a change on the prior
    // window's days distorts the comparison exactly as much as one on this
    // window's. `TimeZoneCaveat` asks the same predicate of the same span, so
    // the glyph and this decision can never disagree.
    const window = { start: delta.priorWindow.start, end: delta.window.end };
    const change = windowSpansTimeZoneChange(trend.timeZoneChanges, window);
    if (change) {
      return { trend, window, change };
    }
  }
  return null;
}

/** The caption a section carries beside its eyebrow: what the section is, and
 * the one caveat that changes how every number under it may be read. */
export function SectionCaption({
  label,
  text,
  caveat,
}: {
  label: string;
  text: string;
  caveat: ReturnType<typeof sectionCaveat>;
}) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <InfoTooltip label={label}>{text}</InfoTooltip>
      {caveat ? (
        <span className="text-chart-distorted" data-time-zone-caveat={caveat.change.effectiveOn}>Timezone changed · Not comparable</span>
      ) : null}
    </span>
  );
}
