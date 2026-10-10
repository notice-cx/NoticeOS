import { Children, useEffect, useRef, type ReactNode } from "react";
import { deltaMeaning, seriesGrain, type PeriodDelta } from "@shared/surface";
import type { SeriesPoint } from "@shared/wall";
import { DeltaChip, performanceTone, type PerformanceTone } from "@/components/DeltaChip";
import { InfoTooltip } from "@/components/InfoTooltip";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Sparkline, type SeriesTone } from "@/components/surface/Sparkline";
import { pillControlClass } from "@/components/ui/pill";
import { formatInt, formatPercent, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A static map, not a computed class: Tailwind generates utilities from
 * source text, so a `grid-cols-${n}` built at runtime produces no CSS. */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
};

/**
 * On a phone a strip is one row. Up to three cells share the width, and at
 * enlarged text sizes their intrinsic minimum widths let the strip scroll
 * instead of clipping a label. From four, each cell takes at least 44% of the
 * row and the row swipes, with the next cell peeking in; the selected cell is
 * brought into view.
 */
const PHONE_THREE = "max-sm:grid-cols-[repeat(3,minmax(min-content,1fr))] max-sm:overflow-x-auto max-sm:overscroll-x-contain";
const PHONE_ROW =
  "max-sm:grid-cols-none max-sm:grid-flow-col max-sm:auto-cols-[minmax(44%,max-content)] " +
  "max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:snap-x max-sm:snap-mandatory " +
  "max-sm:[scrollbar-width:none] max-sm:[&>*]:snap-start";

export interface KpiStripProps {
  children: ReactNode;
  /** Defaults to six across on a desk. */
  columns?: number;
  className?: string;
}

/**
 * One strip of KPIs with hairline dividers: the grid's own `gap-px` over a
 * border-coloured ground, which draws a hairline between cells in any
 * arrangement, including the wrapped rows a phone produces. It draws no outer
 * border; the page puts it inside the `Card` it shares with its chart.
 */
export function KpiStrip({ children, columns = 6, className }: KpiStripProps) {
  // The row follows the cells actually drawn, not the `columns` asked for.
  const cells = Children.toArray(children).length;
  const phone = cells >= 4 ? "swipe" : cells === 3 ? "three" : null;
  const strip = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  // Bring the selected KPI into a swiping row's view once per selection, so a
  // reader's own swipe is never pulled back. Horizontal only.
  useEffect(() => {
    const row = strip.current;
    const cell = row?.querySelector<HTMLElement>("[data-kpi-selected]");
    const key = cell?.getAttribute("data-kpi") ?? null;
    if (!row || !cell || key === shown.current) return;
    shown.current = key;
    if (row.scrollWidth <= row.clientWidth) return;
    const startOf = (element: Element) => element.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    const start = startOf(cell);
    const end = start + cell.getBoundingClientRect().width;
    if (start >= row.scrollLeft && end <= row.scrollLeft + row.clientWidth) return;
    // To a cell's start, where the row snaps anyway: the one before the
    // selected when both fit, so the next cell still peeks in on the right.
    const previous = cell.previousElementSibling;
    const before = previous ? startOf(previous) : null;
    row.scrollLeft = before !== null && before + row.clientWidth >= end ? before : start;
  });
  return (
    <div
      ref={strip}
      // The surface audit finds the strip and its KPIs by these marks, never by
      // a class name.
      data-kpi-strip=""
      data-phone-row={phone ?? undefined}
      className={cn(
        "grid gap-px bg-border/60",
        COLUMNS[columns] ?? COLUMNS[6],
        phone === "three" && PHONE_THREE,
        phone === "swipe" && PHONE_ROW,
        className,
      )}
    >
      {children}
    </div>
  );
}

export type KpiValueTone = "default" | "healthy" | "warn" | "error";

/** Which direction is good for this metric; `none` for a figure whose
 * movement carries no verdict. A prop rather than a lookup, because only the
 * page knows what its metric means. */
export type KpiImprovement = "up" | "down" | "none";

/** Under this, a movement is weather, not a verdict. */
const VERDICT_FLOOR_PERCENT = 2;

const VALUE_TONE: Record<KpiValueTone, string> = {
  default: "text-foreground",
  healthy: "text-healthy",
  warn: "text-warn",
  error: "text-error",
};

export interface KpiProps {
  label: ReactNode;
  /** Pre-formatted. Callers format through `lib/format` so units stay explicit. */
  value: ReactNode;
  /** A qualifier that rides the value at caption size — "forecast", "of 28". */
  note?: ReactNode;
  valueTone?: KpiValueTone;
  /**
   * The movement against the prior period of the same length, from
   * `periodDelta`. `null` names the missing prior period rather than inventing
   * a zero change.
   */
  delta?: PeriodDelta | null;
  /** Which way is good for this metric. Defaults to up. */
  improvement?: KpiImprovement;
  /** Shown instead of the delta — the KPI whose interesting fact is not a
   * movement ("ads $441 · costs $5", "last one 4d ago"). */
  caption?: ReactNode;
  /** Supporting context joins the KPI's one explanation tooltip. Keep units,
   * essential scope and material warnings in label/note/caption instead. */
  explanation?: ReactNode;
  /** The same window the delta covers. Fewer than three points draws no line:
   * two dots joined by a segment reads as a trend the data cannot support. */
  spark?: readonly SeriesPoint[];
  /** The plotted quantity when it differs from the headline's time scope. */
  sparkLabel?: string;
  /** Defaults to the delta's own tone; a neutral metric's spark is muted. */
  sparkTone?: SeriesTone;
  /** Smooth the spark over this many periods of its own grain. A monthly
   * series wants `false`: seven periods is seven months. */
  sparkAverage?: boolean;
  sparkAverageWindow?: number;
  /** Input was already averaged (for example before windowing with pre-roll). */
  sparkPreAveragedWindow?: number;
  /** The first period the provider has not finished, so the spark's endpoint
   * cap goes hollow. */
  sparkProvisionalFrom?: string | null;
  /** Why this number has no series yet, in the operator's words. Read only
   * when there is no series to draw, so a caller may pass both. The gap is
   * declared by `data-series="unavailable"` and said in the explanation, never
   * printed under the number. */
  seriesUnavailable?: string;
  /** A visible chart shared by this summary and its neighboring KPIs. The
   * accessible details relationship points to that chart's container. */
  seriesChartId?: string;
  /** Formats the spark's hover readout and the delta when there is no percent
   * to state. Defaults to a whole number. */
  format?: (value: number) => string;
  /** Anything below the delta line — Home's share bar under a count. */
  footer?: ReactNode;
  /** Selectable KPIs drive the chart under the strip. A KPI with no `onSelect`
   * renders as a figure rather than a control. */
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}

/** One KPI: a label, a value, its movement, and its own series. */
export function Kpi({
  label,
  value,
  note,
  valueTone = "default",
  delta,
  improvement = "up",
  caption,
  explanation,
  spark,
  sparkLabel,
  sparkTone,
  sparkAverage = true,
  sparkAverageWindow = 7,
  sparkPreAveragedWindow,
  sparkProvisionalFrom = null,
  seriesUnavailable,
  seriesChartId,
  format = formatInt,
  footer,
  selected = false,
  onSelect,
  className,
}: KpiProps) {
  const interactive = typeof onSelect === "function";
  const verdict = deltaVerdict(delta, improvement);
  const sparkGrain = spark && seriesGrain(spark) === "monthly" ? "month" : "day";
  const sparkMethod = sparkAverage || sparkPreAveragedWindow !== undefined
    ? `${sparkPreAveragedWindow ?? sparkAverageWindow}-${sparkGrain} average`
    : `${sparkGrain === "month" ? "monthly" : "daily"} values`;
  // The series wins: a gap is declared only where there is nothing to draw.
  const declaresGap = Boolean(seriesUnavailable) && !(spark && spark.length > 0) && !seriesChartId;
  const hasSpark = Boolean(spark && spark.length >= 3);
  const hasContext = hasSpark || declaresGap || Boolean(delta && !delta.comparable) || Boolean(explanation);
  const body = (
    <>
      <span className={cn(eyebrowClass, hasContext && "pe-6")}>
        {label}
      </span>
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span
          className={cn(
            "text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums",
            VALUE_TONE[valueTone],
          )}
        >
          {value}
          {/* Its own line height: a wrapped note must not take the 28px
              value's line box per line. */}
          {note ? (
            <span className="ms-1 inline-block text-xs font-medium leading-snug tracking-normal text-muted-foreground">
              {note}
            </span>
          ) : null}
        </span>
        {!declaresGap && spark && spark.length >= 3 ? (
          <Sparkline
            data={spark}
            data-spark=""
            size="kpi"
            tone={sparkTone ?? verdict.sparkTone}
            average={sparkAverage}
            averageWindow={sparkAverageWindow}
            preAveragedWindow={sparkPreAveragedWindow}
            provisionalFrom={sparkProvisionalFrom}
            readout
            keyboardReadout={!interactive}
            ariaHidden={interactive}
            format={format}
            ariaLabel={`${sparkLabel ?? (typeof label === "string" ? label : "metric")} trend`}
            className="shrink-0 max-sm:basis-full"
          />
        ) : null}
      </span>
      <KpiDelta delta={delta} verdict={verdict} caption={caption} format={format} />
      {footer}
      {selected ? (
        <span aria-hidden className="absolute inset-x-4 bottom-0 h-0.5 bg-foreground max-sm:inset-x-3" />
      ) : null}
    </>
  );

  const shell = cn(
    "relative grid content-start gap-1 bg-card p-4 text-start max-sm:p-3",
    selected && "bg-muted/40",
    className,
  );

  // The mark carries the metric's name so the surface audit can say which KPI
  // is missing its series. A label that is a node names nothing.
  const mark = typeof label === "string" ? label : "";

  // The state is what `scripts/surface-audit.mjs` keys on; the reason rides beside it.
  const gapMarks = declaresGap
    ? {
        "data-series": "unavailable",
        "data-series-reason": seriesUnavailable,
      }
    : {};

  return (
    <div data-kpi={mark} data-kpi-selected={selected ? "" : undefined} aria-details={seriesChartId} {...gapMarks} className={cn(shell, interactive && "p-0 max-sm:p-0")}>
      {interactive ? <button type="button" aria-pressed={selected} onClick={onSelect}
        className={cn("grid content-start gap-1 p-4 text-start max-sm:p-3", pillControlClass,
          "cursor-pointer hover:bg-muted/40 motion-safe:transition-colors")}>{body}</button> : body}
      {hasContext ? <InfoTooltip label={`About ${typeof label === "string" ? label : "this metric"}`}
        className="absolute end-1 top-1">
        {hasSpark && spark ? <span>
          {sparkLabel ? `${sparkLabel} · ` : "Trend: "}{sparkMethod}
          <span className="block tabular-nums">{formatSeriesDate(spark[0]!.t)} – {formatSeriesDate(spark.at(-1)!.t)}</span>
          {sparkPreAveragedWindow !== undefined ? <span className="block">This line uses a precomputed average; it is not averaged again.</span> : null}
        </span> : null}
        {delta ? <span>{deltaMeaning(delta, delta.window.start.length === 7 ? "monthly" : "daily")}</span> : null}
        {declaresGap ? <span>{seriesUnavailable}</span> : null}
        {explanation}
      </InfoTooltip> : null}
    </div>
  );
}

/**
 * What a movement is worth, decided once for the chip and the sparkline. No
 * colour when the two sides are not comparable, the metric carries no
 * verdict, the change is under the floor, or there is no percentage; what is
 * left is coloured for the direction that is good for this metric.
 */
function deltaVerdict(
  delta: PeriodDelta | null | undefined,
  improvement: KpiImprovement,
): { tone: PerformanceTone; sparkTone: SeriesTone } {
  const percent = delta?.percent;
  if (
    !delta ||
    !delta.comparable ||
    improvement === "none" ||
    percent === null ||
    percent === undefined ||
    Math.abs(percent) < VERDICT_FLOOR_PERCENT
  ) {
    return { tone: "neutral", sparkTone: "muted" };
  }
  const good = improvement === "up" ? percent > 0 : percent < 0;
  return {
    tone: performanceTone(good ? Math.abs(percent) : -Math.abs(percent)),
    sparkTone: good ? "positive" : "negative",
  };
}

/**
 * The movement line. Three states and each says something different: a
 * comparison that stands, a comparison whose measurements cannot be compared
 * (no numeric change, with an accessible explanation), and no previous period.
 */
function KpiDelta({
  delta,
  verdict,
  caption,
  format,
}: {
  delta: PeriodDelta | null | undefined;
  verdict: { tone: PerformanceTone };
  caption: ReactNode;
  format: (value: number) => string;
}) {
  if (delta) {
    const grain = delta.window.start.length === 7 ? "monthly" : "daily";
    const meaning = deltaMeaning(delta, grain);
    if (!delta.comparable) {
      return (
        <span className="flex flex-col gap-0.5 text-xs text-muted-foreground"
          data-tone="neutral" aria-label={`Not comparable: ${meaning}`}>
          <span className="font-medium">Not comparable</span>
          {caption ? <span>{caption}</span> : null}
        </span>
      );
    }
    const percent = delta.percent;
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <DeltaChip
          value={percent ?? delta.change}
          render={(magnitude) =>
            percent === null ? format(magnitude) : `${formatPercent(magnitude)}%`
          }
          tone={verdict.tone}
          meaning={meaning}
          className="text-xs"
        />
        {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
      </span>
    );
  }
  if (caption) {
    return <span className="text-xs text-muted-foreground">{caption}</span>;
  }
  return (
    <span className="text-xs text-muted-foreground" data-delta="none">
      — No previous period
    </span>
  );
}
