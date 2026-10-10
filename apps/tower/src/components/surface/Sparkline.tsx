import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { averageSeries, fillSeriesGaps, provisionalIndex, shiftLabel, type SeriesPointOrGap } from "@shared/surface";
import { ChartArea, ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import { InfoTooltip } from "@/components/InfoTooltip";
import { readingRuns } from "@/lib/chart-path";
import { formatInt, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * WHAT A LINE'S COLOUR IS ALLOWED TO MEAN (doc 14).
 *
 * `neutral` is the default and the honest one: a line's SHAPE is the
 * information, and `--spark` exists precisely so a trend can be drawn without
 * spending a meaning on it. The rest are the three sanctioned systems and
 * nothing else — `primary`/`bing` are PROVIDER IDENTITY (always drawn beside
 * the provider's name in a legend or a toggle, never alone),
 * `revenue`/`cost` are financial series identity, paired with a named key and
 * line pattern by the chart, and `traffic` the Wall's audience series identity
 * (bead `ro-trai.19`); `positive`/`negative` are the scoped comparison scale a
 * `PeriodDelta` earns only while it is `comparable`, and `warn`/`error` are
 * severity. A caller reaching for a colour that is none of these wants
 * `neutral`.
 */
export type SeriesTone =
  | "muted"
  | "neutral"
  | "primary"
  | "bing"
  | "revenue"
  | "cost"
  | "traffic"
  | "positive"
  | "negative"
  | "warn"
  | "error";

export const SERIES_TONE_CLASS: Record<SeriesTone, string> = {
  // doc 14: "a sparkline on a neutral metric is `text-muted-foreground`". The
  // `--spark` token stays available for a line drawn on its own, away from a
  // delta that could have given it a tone.
  muted: "text-muted-foreground",
  neutral: "text-spark",
  primary: "text-foreground",
  bing: "text-search-bing",
  revenue: "text-financial-revenue",
  cost: "text-financial-cost",
  // Traffic series identity (doc 14): the Wall's audience series. Never beside
  // a `bing` line — the two are one blue family.
  traffic: "text-traffic",
  positive: "text-trend-positive",
  negative: "text-trend-negative",
  warn: "text-warn",
  error: "text-error",
};

/**
 * The three places doc 14 puts a sparkline, at the three sizes it names. A size
 * rather than a width/height pair, so five call sites cannot land on five
 * nearly-equal rectangles — which is exactly how the desk grew four card
 * variants before the registry existed.
 */
export type SparklineSize = "kpi" | "cell" | "wide";

const SIZE: Record<SparklineSize, { width: number | null; height: number }> = {
  kpi: { width: 64, height: 22 },
  cell: { width: 96, height: 24 },
  wide: { width: null, height: 30 },
};

export interface SparklineProps {
  /** Chronological ascending, in the series' own grain. A point may be a HOLE —
   * `{ t, v: null }` — for a period nobody reported (bead `ro-78qo.37`): the
   * line breaks over it rather than joining the readings either side, which is
   * what a monthly ledger with an empty month needs. */
  data: readonly SeriesPointOrGap[];
  size?: SparklineSize;
  tone?: SeriesTone;
  /** Draw the trailing average rather than the raw daily line. doc 14's
   * sparkline is "28 points, 7-day average" — the raw line at 64×22 is noise
   * with a shape hidden in it. Off for a series that is already smooth. */
  average?: boolean;
  averageWindow?: number;
  /** The input already contains a trailing average over this many calendar
   * periods. Never smooth it again or present it as a raw daily/monthly count. */
  preAveragedWindow?: number;
  /** Fill under the line. The `SmallMultiple` form; off inside a `Kpi`, where
   * six filled shapes in a row become a skyline rather than six trends. */
  area?: boolean;
  /** The provider has not finished these points; the endpoint cap goes hollow
   * so the loudest ink on the line does not read as settled (bead `ro-y91`). */
  provisionalFrom?: string | null;
  /** Pointer, touch and keyboard readout: the period and the plotted value.
   * Averaged lines identify their window and show the raw value separately.
   * doc 14 asks for it on `Kpi` sparklines — a 64px line answers "which way"
   * on its own, and the reader who wants "how much on which day" gets it
   * without leaving the strip. */
  readout?: boolean;
  /** Off when a parent button selects an equivalent, accessible hero chart. */
  keyboardReadout?: boolean;
  /** A selectable parent already names its trend and opens an accessible
   * chart. Hide this redundant visualization, but retain its visual readout. */
  ariaHidden?: boolean;
  format?: (value: number) => string;
  /** THE SITE'S NORMAL, drawn behind the line (D44, the Brief's alert card):
   * a quiet band from `low` to `high` in the series' own units, so "22 a day,
   * usually 33–45" is a shape before it is a sentence. The band widens the
   * plotted range; it never colours the line. */
  band?: { low: number; high: number };
  /** Why there is no line, for the hover on the empty state's dash. doc 14:
   * "a missing figure is a dash with a reason on hover". */
  emptyReason?: string;
  ariaLabel?: string;
  className?: string;
  /** The audit script's handle on a KPI's own series. Forwarded rather than
   * assumed, because a sparkline in a table cell is not one. */
  "data-spark"?: string;
}

const PAD = 2;

/**
 * The desk's one small trend line (doc 14). It draws a shape and nothing else:
 * no axis, no grid, no label. Anything that needs those is a `HeroChart`.
 *
 * This is the desk's compact line; the Wall's rows draw their own charts in
 * the same marks (`ChartMarks`).
 */
export function Sparkline({
  data: inputData,
  size = "kpi",
  tone = "neutral",
  average = true,
  averageWindow = 7,
  preAveragedWindow,
  area = false,
  provisionalFrom = null,
  readout = false,
  keyboardReadout = true,
  ariaHidden = false,
  format = formatInt,
  emptyReason = "No series yet",
  band,
  ariaLabel,
  className,
  "data-spark": dataSpark,
}: SparklineProps) {
  const clipId = useId();
  const [hoverIndex, setHoverIndex] = useState(-1);
  const { width: fixedWidth, height } = SIZE[size];
  const width = fixedWidth ?? 100;
  const data = fillSeriesGaps(inputData);
  if (preAveragedWindow !== undefined && (!Number.isInteger(preAveragedWindow) || preAveragedWindow < 1)) {
    throw new Error("Sparkline preAveragedWindow must be a positive integer.");
  }
  const smoothInput = average && preAveragedWindow === undefined;
  const isAverage = average || preAveragedWindow !== undefined;
  const shownWindow = preAveragedWindow ?? averageWindow;

  const drawn = smoothInput ? averageSeries(data, averageWindow) : [...data];
  const values = drawn
    .map((point) => point.v)
    .filter((value): value is number => value !== null);

  // A series of nothing but holes has no shape to draw, so it is the same
  // answer as no series at all — a dash, not an empty box.
  if (values.length === 0) {
    /**
     * ONE GLYPH, NOT A PLACARD (bead `ro-78qo.24`).
     *
     * This used to be the words "no series" on a tinted pill, and the pill is
     * 64px wide at the `kpi` size through an INLINE width no call site can
     * relax — so the label wrapped to two lines inside a 22px box, and /tasks
     * worked around it by asking for the wider `cell` size, putting a chip a
     * third wider than the sparkline it stands in for into the strip. doc 14
     * already says what this state draws: "a missing figure is a dash with a
     * reason on hover". A dash fits at every size there is.
     *
     * AND THE REASON OPENS FROM A KEY OR A TAP, not only a pointer (bead
     * `ro-ujb9.14`): the dash is the trigger of the desk's one on-demand
     * explanation (`InfoTooltip`), so a keyboard reaches it with Tab and a
     * phone with a tap, where a `title` reached neither. Inside a control that
     * already states the gap (a selectable `Kpi`, `ariaHidden`), it stays a
     * plain dash: a button may not sit inside a button.
     */
    const label = `${ariaLabel ?? "Trend"}: ${emptyReason}`;
    return (
      <span
        data-spark={dataSpark}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap text-xs leading-none text-muted-foreground",
          fixedWidth === null && "w-full",
          className,
        )}
        style={{ height, width: fixedWidth ?? undefined }}
        aria-hidden={ariaHidden || undefined}
      >
        {ariaHidden ? "—" : <InfoTooltip label={label} trigger="—">{emptyReason}</InfoTooltip>}
      </span>
    );
  }

  const min = Math.min(...values, ...(band ? [band.low] : []));
  const max = Math.max(...values, ...(band ? [band.high] : []));
  const span = max - min || 1;
  const plotHeight = height - PAD * 2;
  const xOf = (index: number) =>
    drawn.length === 1 ? width / 2 : PAD + (index / (drawn.length - 1)) * (width - PAD * 2);
  const yOf = (value: number) => PAD + (1 - (value - min) / span) * plotHeight;

  /** Runs of consecutive readings. A hole ENDS the run it interrupts, so the
   * stroke breaks over it instead of spanning it — a series with no holes is
   * exactly one run. Each run is one monotone curve through its readings
   * (`ChartLine`, bead `ro-trai.19`): smooth, and never above or below the
   * readings either side. */
  const runs = readingRuns(drawn.map((point) => point.v));
  const lineRuns = runs.map((one) => one.map((point) => ({ x: xOf(point.index), y: yOf(point.value) })));

  const lastIndex = drawn.length - 1;
  /** The cap goes on the last READING, which is not the last period when the
   * series ends in a hole. */
  const capAt = runs.at(-1)!.at(-1)!;
  const provisionalAt = provisionalIndex(drawn, provisionalFrom);
  const endpointIsProvisional = provisionalAt >= 0 && provisionalAt <= capAt.index;
  const active = hoverIndex >= 0 ? Math.min(hoverIndex, lastIndex) : -1;
  const raw = active >= 0 ? data[Math.min(active, data.length - 1)] : null;
  const plotted = active >= 0 ? drawn[active] : null;
  const grain = data.some((point) => point.t.length === 7) ? "month" : "day";
  const rawLabel = grain === "month" ? "Monthly value" : "Daily value";
  const averageLabel = `${shownWindow}-${grain} average`;
  // What the line IS, in a label (bead `ro-ujb9.96.6.12`). How each point was
  // made is the readout's job — it prints the average, the raw value and, when
  // a window is short, how many periods it used — so this names the quantity
  // and stops. A precomputed line has no raw values to offer, which the
  // readout shows by offering none.
  const semantics = preAveragedWindow !== undefined
    ? `Line: precomputed trailing ${averageLabel}.`
    : average
    ? `Line: trailing ${averageLabel} of reported ${grain}s.`
    : `Line: reported ${grain === "month" ? "monthly" : "daily"} values, not averaged.`;
  const description = `${semantics} ${data[0]!.t} to ${data.at(-1)!.t}.`;
  const isProvisional = raw?.v !== null && provisionalAt >= 0 && active >= provisionalAt;
  // Match averageSeries' calendar window, including its shorter windows at
  // the start and around gaps. Seven stored rows need not be seven days.
  const byDate = new Map(data.map((point) => [point.t, point.v]));
  const reportedInWindow = raw && smoothInput
    ? Array.from({ length: averageWindow }, (_, back) => byDate.get(shiftLabel(raw.t, -back)))
      .filter((value) => value !== null && value !== undefined).length
    : 0;

  function onMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!readout) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return setHoverIndex(0);
    const ratio = (event.clientX - box.left) / box.width;
    setHoverIndex(Math.max(0, Math.min(lastIndex, Math.round(ratio * lastIndex))));
  }

  function onKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (!readout || !keyboardReadout || !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return setHoverIndex(-1);
    if (event.key === "Home") return setHoverIndex(0);
    if (event.key === "End") return setHoverIndex(lastIndex);
    const current = active < 0 ? lastIndex : active;
    setHoverIndex(Math.max(0, Math.min(lastIndex, current + (event.key === "ArrowLeft" ? -1 : 1))));
  }

  return (
    <span
      data-spark={dataSpark}
      aria-hidden={ariaHidden || undefined}
      className={cn(
        "relative inline-block align-middle",
        SERIES_TONE_CLASS[tone],
        fixedWidth === null && "w-full",
        className,
      )}
      style={{ width: fixedWidth ?? undefined }}
    >
      <svg
        className="block w-full overflow-visible rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height }}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? "Trend"}
        tabIndex={readout && keyboardReadout && !ariaHidden ? 0 : undefined}
        aria-describedby={`${clipId}-semantics${readout && keyboardReadout ? ` ${clipId}-instructions` : ""}`}
        onFocus={() => { if (readout && keyboardReadout) setHoverIndex((current) => current >= 0 ? current : lastIndex); }}
        onBlur={() => setHoverIndex(-1)}
        onKeyDown={onKeyDown}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={(event) => { if (event.pointerType !== "touch") setHoverIndex(-1); }}
      >
        <title>{description}</title>
        {/* The wash fades to nothing at the box's floor instead of a flat
            block with a hard right edge (bead `ro-trai.19`). */}
        {band ? (
          <rect
            x={0}
            width={width}
            y={yOf(band.high)}
            height={Math.max(1, yOf(band.low) - yOf(band.high))}
            className="fill-muted-foreground opacity-20"
            data-spark-band
          />
        ) : null}
        {area ? <ChartArea runs={lineRuns} baseline={height} strength={0.34} /> : null}
        <ChartLine runs={lineRuns} width={2} surface="stroke-card" />
        {active >= 0 ? (
          <line
            x1={xOf(active)}
            x2={xOf(active)}
            y1={0}
            y2={height}
            className="stroke-current opacity-45"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {/* A provisional cap is HOLLOW: the loudest ink on the line must not
            read as settled while the provider is still counting the day. The
            cap is a round stroke, so the wide size's stretched box no longer
            draws it as an ellipse. */}
        <ChartDot
          at={{ x: xOf(capAt.index), y: yOf(capAt.value) }}
          size="sm"
          hollow={endpointIsProvisional}
          surface="stroke-card"
        />
      </svg>
      <span id={`${clipId}-semantics`} className="sr-only">{description}</span>
      {readout && keyboardReadout ? <span id={`${clipId}-instructions`} className="sr-only">
        Arrow keys step through dates; Home and End jump; Escape clears.
      </span> : null}
      {readout && raw ? (
        <span
          className="pointer-events-none absolute bottom-full right-0 z-10 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs tabular-nums text-muted-foreground shadow-sm"
          role="status"
          data-status-for={`readout:${clipId}`}
          aria-atomic="true"
        >
          <span className="block">{formatSeriesDate(raw.t)}{isProvisional ? " \u00b7 provisional" : ""}</span>
          <span className="block">
            {isAverage ? averageLabel : rawLabel}{": "}
            <span className="font-semibold text-foreground">
              {/* A period nobody reported reads as a dash, never as a zero. */}
              {plotted?.v === null || plotted?.v === undefined ? "\u2014" : format(plotted.v)}
            </span>
          </span>
          {smoothInput && raw.v !== null ? (
            <>
              <span className="block">{rawLabel}: {format(raw.v)}</span>
              {reportedInWindow < averageWindow ? (
                <span className="block">{reportedInWindow} of {averageWindow} {grain}s reported</span>
              ) : null}
            </>
          ) : null}
          {raw.v === null ? <span className="block">No report</span> : null}
        </span>
      ) : null}
    </span>
  );
}
