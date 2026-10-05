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

/**
 * How many across, and what a phone does with them.
 *
 * The desk width is chosen per count, so five KPIs cannot land on a six-track
 * grid with a hole in it. On a phone the strip is one row: up to three KPIs
 * side by side, four or more a row you swipe (below, doc 21's phone first
 * screen).
 * A static map rather than a computed class because Tailwind generates
 * utilities from source TEXT — a `grid-cols-${n}` built at runtime produces no
 * CSS at all, which is the kind of bug that only shows up in the built app.
 */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
};

/**
 * ON A PHONE A STRIP IS ONE ROW (bead `ro-ujb9.13`,
 * docs/briefs/2026-09-24-mobile-first-screen.md).
 *
 * Two columns stacked a six-KPI strip three rows deep: 380px of Alerts' and
 * 330px of Tasks' 844px first screen went on the summary before the first
 * alert or task, and Home's three status KPIs left a grey hole in a fourth
 * cell. Now the phone strip is always one row tall. Up to three cells share
 * the width while their words fit. At enlarged text sizes their intrinsic
 * minimum widths let the strip scroll instead of clipping a label. From four,
 * each cell uses at least 44% of the row width and grows for its words; the
 * row swipes, with the next cell peeking in to say there is more (Vercel's metric tabs
 * over one chart); the selected cell is brought into view, so the chart under
 * a strip never names a KPI the eye cannot find. Each cell keeps its label,
 * value, movement and line; nothing is dropped. From `sm` up the grid above
 * is unchanged.
 */
const PHONE_THREE = "max-sm:grid-cols-[repeat(3,minmax(min-content,1fr))] max-sm:overflow-x-auto max-sm:overscroll-x-contain";
const PHONE_ROW =
  "max-sm:grid-cols-none max-sm:grid-flow-col max-sm:auto-cols-[minmax(44%,max-content)] " +
  "max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:snap-x max-sm:snap-mandatory " +
  "max-sm:[scrollbar-width:none] max-sm:[&>*]:snap-start";

export interface KpiStripProps {
  children: ReactNode;
  /** Defaults to six across on a desk — doc 21's Overview strip. */
  columns?: number;
  className?: string;
}

/**
 * ONE STRIP, SO THE EYE READS LEFT TO RIGHT ONCE (doc 21).
 *
 * *Registry justification:* it replaces `Stat`, the four Home widgets and the
 * asset page's state cards — four ways of drawing "a label, a number and
 * something small under it", each in its own bordered box. The strip is one
 * card with hairline dividers, and the dividers are the grid's own `gap-px`
 * over a border-coloured ground: that draws a hairline between cells in any
 * arrangement, including the wrapped rows a phone produces, which a per-cell
 * border cannot do without a trailing edge in the wrong place.
 *
 * It draws no outer border of its own — doc 14's "a container must earn its
 * boundary". The page puts it inside the one `Card` it shares with the chart it
 * selects, which is what makes the KPI and its series read as one unit.
 */
export function KpiStrip({ children, columns = 6, className }: KpiStripProps) {
  // The row follows the cells actually drawn, not the `columns` asked for: a
  // strip whose third KPI waits on a task source is two cells, and two fit.
  const cells = Children.toArray(children).length;
  const phone = cells >= 4 ? "swipe" : cells === 3 ? "three" : null;
  const strip = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  // Bring the selected KPI into a swiping row's view — once per selection, so
  // a reader's own swipe is never pulled back. Horizontal only: the page does
  // not move. A row that does not scroll (every desk) has nothing to adjust.
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
      // The audit script measuring doc 21's acceptance list finds the strip, its
      // KPIs and their sparks by these marks rather than by a class name, which
      // is styling and may change without the structure changing.
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

/**
 * Which direction is GOOD for this metric (doc 21).
 *
 * Up for users, sessions, clicks, impressions and product counts; DOWN for open
 * alerts and errors; `none` for a figure whose movement carries no verdict at
 * all — Net, which shows its composition instead. It is a prop rather than a
 * lookup because only the page knows what its metric means, and a component
 * that guessed would eventually paint a falling error count red.
 */
export type KpiImprovement = "up" | "down" | "none";

/**
 * Under this, a movement is not a verdict (doc 21). Two percent on a
 * fortnight's traffic is weather, and a strip where six KPIs are all faintly
 * green or faintly red says nothing louder than one that is honestly grey.
 */
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
  /** The same window the delta covers, drawn as its 7-day average. Fewer than
   * three points draws NO line: two dots joined by a segment is a shape the eye
   * reads as a trend and the data cannot support (doc 21). */
  spark?: readonly SeriesPoint[];
  /** The plotted quantity when it differs from the headline's time scope. */
  sparkLabel?: string;
  /** Defaults to the delta's own tone — doc 21: "a KPI's sparkline takes the
   * same tone; a sparkline on a neutral metric is muted". */
  sparkTone?: SeriesTone;
  /**
   * Smooth the spark, and over how many PERIODS of its own grain.
   *
   * The default is doc 21's daily line: seven days, drawn in place of the raw
   * one, because at 64×22 the raw series is noise with a shape hidden in it. A
   * MONTHLY series wants neither (bead `ro-78qo.18`): seven periods is seven
   * MONTHS, and a portfolio with six months of net flattens into a line that
   * hides the one dip worth seeing. `false` draws the periods themselves.
   */
  sparkAverage?: boolean;
  sparkAverageWindow?: number;
  /** Input was already averaged (for example before windowing with pre-roll). */
  sparkPreAveragedWindow?: number;
  /**
   * The first period the provider has not finished, so the spark's endpoint cap
   * goes hollow (doc 21: "the latest day of any daily series is provisional
   * until the provider closes it").
   *
   * Forwarded alongside the two above because they arrive together: the caller
   * that has a reason to turn the averaging off is a caller drawing raw
   * periods, and the last of those is the one still being lived in. Without it,
   * moving a series into this slot would silently drop the mark that says so.
   */
  sparkProvisionalFrom?: string | null;
  /**
   * WHY THIS NUMBER HAS NO SERIES YET, in the operator's words — "the queue
   * keeps 7 days of snapshots" (bead `ro-78qo.6`).
   *
   * Doc 21 asks every number that CAN have a series to show one, and a payload
   * that keeps no history is a third answer beside a series and a composition:
   * the series does not exist YET. Six KPIs each printing a grey "no series"
   * placard is six identical pills saying nothing, so the honest treatment is
   * to draw no invented line and DECLARE the gap — a visible reason for the
   * reader with its reason in the explanation, `data-series="unavailable"` for the surface audit,
   * which lists it instead of failing the route so the gap stays visible until
   * the payload grows one.
   *
   * THE SERIES WINS. The reason is only read when there is no series to
   * draw, so a caller may pass both — `seriesUnavailable={drawable ? undefined
   * : reason}` beside the spark is the common shape — and the cell never
   * states a gap it does not have. The gap is NOT printed under the number
   * (bead `ro-ujb9.96.6.15`): the missing line is the visible state, the reason
   * is in the cell's explanation, and the two marks keep it machine-readable.
   */
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
   * renders as a figure rather than a control: nothing to press is better than
   * a button that does nothing. */
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}

/**
 * ONE KPI: a label, a value, its movement, and its own series (doc 21
 * principle 2 — "a number without its series is noise").
 */
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
      {/* Wrap when the cell is narrow, including beside the tablet sidebar.
          Keep the value's size and the spark's newest point visible. The phone
          spark still takes a full row; wider cells wrap only when needed. */}
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span
          className={cn(
            "text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums",
            VALUE_TONE[valueTone],
          )}
        >
          {value}
          {/* Its own line height (bead ro-ujb9.13): in a phone's narrow cell a
              wrapped note took the 28px value's line box per line. */}
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
      {/* ONE REPRESENTATION PER FACT (bead `ro-ujb9.96.6.15`). The cell is its
          label, value, movement and line. The line's method ("7-day average",
          "monthly values") and a missing history's reason are each stated once,
          in the explanation beside the label and in the line's own readout —
          not again as a caption under the number on every page that uses the
          strip. */}
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

  // The mark CARRIES THE METRIC'S NAME (scripts/README.md's audit table), so an
  // audit failure can say which KPI is missing its series instead of quoting
  // the offending element's text back at the operator (bead `ro-78qo.1`). A
  // label that is a node rather than a string names nothing, and stays empty.
  const mark = typeof label === "string" ? label : "";

  // A DECLARED GAP, in two attributes because one cannot hold two facts: the
  // STATE is what `scripts/surface-audit.mjs` keys on; the REASON is also
  // available through the KPI's hover/focus/tap explanation.
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
 * WHAT A MOVEMENT IS WORTH, decided once for the chip and the sparkline.
 *
 * Four things can take the colour away and each is a different sentence: the
 * two sides are not the same measurement (doc 14, `ro-jkp2`); the metric's
 * movement carries no verdict at all (Net); the change is under the floor; or
 * there is no percentage because the prior period totalled zero. What is left
 * is coloured for the direction that is GOOD for this metric, which is why a
 * falling error count is green.
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
