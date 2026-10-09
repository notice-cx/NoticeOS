import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CircleDollarSign } from "lucide-react";
import type { AssetCard, PortfolioBand } from "@shared/wall";
import { MEDIAVINE_REPORTING_CLOCK } from "@shared/daily-revenue";
import { DeltaChip } from "@/components/DeltaChip";
import { ChartArea, ChartDot, ChartLine } from "@/components/surface/ChartMarks";
import {
  formatPercent,
  formatPeriodMonth,
  formatPeriodMonthLong,
  formatPeriodMonthYear,
  formatUsd,
  formatSeriesDate,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { monthRevenue, yesterdayTotal, type MonthPace, type YesterdayTotal } from "@/lib/wall-revenue";

// THE WALL'S REVENUE WIDGET (docs/14-design.md § Revenue, D28, bead
// `ro-trai.4`): the month's revenue so far as the largest type on the screen
// (D13), where the month lands, yesterday's money (bead `ro-trai.32`), and the
// month as a line against last month's total — "are we on track this month?"
// answered before any site is read.
//
// Registry justification: `PortfolioBand` states the month's NET in a narrow
// card with a monthly backdrop, and `HeroChart` is the desk's interactive chart
// with legends and toggles the TV cannot use. Nothing drew a cumulative month
// against a flat prior-month total with the day the two cross named on it.
// The arithmetic is `lib/wall-revenue` (and under it the Worker's
// `revenue-projection`); this file only draws it.

export interface RevenueHeroProps {
  portfolio: PortfolioBand;
  assets: readonly Pick<AssetCard, "revenueProjection" | "dailyRevenue">[];
  /** The Wall's clock, which "yesterday" is asked on; this render's own when
   * absent. */
  nowMs?: number;
}

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

export function RevenueHero({ portfolio, assets, nowMs }: RevenueHeroProps) {
  const model = monthRevenue(portfolio, assets);
  const yesterday = yesterdayTotal(assets, nowMs ?? Date.now());

  if (model === null) {
    return (
      <section
        aria-label="Revenue this month"
        className="flex min-w-0 items-center gap-3 text-wall-body text-muted-foreground"
        data-wall-revenue="none"
      >
        <CircleDollarSign className="size-6 shrink-0" aria-hidden />
        No revenue source
      </section>
    );
  }

  const month = model.periodIsCurrent
    ? formatPeriodMonthLong(model.period)
    : formatPeriodMonthYear(model.period);
  const { pace } = model;

  return (
    <section
      aria-label="Revenue this month"
      className={cn("flex min-w-0 flex-col gap-2", pace && "xl:h-72 2xl:h-wall-band")}
      data-wall-revenue={model.revenue === null ? "waiting" : pace ? "pace" : "figure"}
    >
      <h2 className={eyebrow}>
        {month} revenue
        {/* The one word that keeps an estimate from reading as booked money
            (PortfolioBand's rule, `ro-t0z`). */}
        {model.revenue !== null && model.state === "forecast" ? " · estimated" : null}
      </h2>
      {model.revenue === null ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-wall-body text-muted-foreground tabular-nums">
          <span data-revenue-waiting>{model.waiting}</span>
          {model.previousMonth ? (
            <span data-revenue-previous-month>
              {formatPeriodMonthYear(model.previousMonth.period)} {formatUsd(model.previousMonth.revenue)} est.{model.previousMonth.reported < model.previousMonth.sites ? (
                <> · {model.previousMonth.reported} of {model.previousMonth.sites} sites</>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-end gap-x-6 gap-y-1">
        {/* No figure while no source has a complete day this month (bead
            ro-trai.33): the reason and yesterday say where the money is. */}
        {model.revenue !== null ? (
          <span
            className="text-wall-display font-bold tracking-tighter tabular-nums"
            data-revenue-figure
          >
            {formatUsd(model.revenue)}
          </span>
        ) : null}
        {pace ? (
          <PaceLine pace={pace} yesterday={yesterday} />
        ) : model.waiting || yesterday ? (
          // No pace yet (a projection still learning — a new installation's
          // first three weeks — or an older ledger month): the reason, and
          // yesterday under it all the same.
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1 pb-2 text-wall-body text-muted-foreground tabular-nums">
            {model.revenue !== null && model.waiting ? <span data-revenue-waiting>{model.waiting}</span> : null}
            {yesterday ? <Yesterday total={yesterday} /> : null}
          </div>
        ) : null}
      </div>
      {pace ? <MonthChart pace={pace} period={model.period} /> : null}
    </section>
  );
}

function PaceLine({ pace, yesterday }: { pace: MonthPace; yesterday: YesterdayTotal | null }) {
  const previous = formatPeriodMonth(pace.previousPeriod);
  const comparisonDirection = pace.changePercent === null ? null : pace.changePercent > 0 ? "above" : pace.changePercent < 0 ? "below" : "level with";
  return (
    // Beside the figure while 16 rem are left there, its lines wrapping inside
    // that room rather than dropping the whole block under the figure (which
    // takes the month chart's height); under it on a phone. In the TV's layout
    // it never drops: a laptop's floored type (bead ro-trai.31) wraps its words
    // beside the figure instead.
    <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2 pb-2 tv:basis-0" data-revenue-pace>
      <span className="text-2xl font-medium tabular-nums">
        on pace for <span className="font-bold">{formatUsd(pace.projected)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-wall-body tabular-nums">
        {pace.changePercent !== null ? (
          // NEUTRAL INK (doc 14, doc 14): a projection against a finished month
          // is not a completed like-for-like comparison, so the arrow carries
          // the direction and no colour judges it.
          <span
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-semibold"
            data-revenue-change
          >
            <DeltaChip
              value={pace.changePercent}
              render={(value) => `${formatPercent(value)}%`}
              tone="neutral"
              directionLabel={comparisonDirection ?? undefined}
              meaning={`Projected revenue ${formatPercent(Math.abs(pace.changePercent))}% ${comparisonDirection} ${previous} total`}
              className="text-wall-body font-semibold"
            />
            {" "}{previous}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {yesterday ? (
            <>
              <Yesterday total={yesterday} />
              {" · "}
            </>
          ) : null}
          <span className="whitespace-nowrap">
            {pace.daysLeft} {pace.daysLeft === 1 ? "day" : "days"} left
          </span>
        </span>
      </span>
    </div>
  );
}

/**
 * Yesterday's revenue (bead `ro-trai.32`): the figure in the foreground's
 * weight, the words around it quiet. It is the providers' estimate, so "est."
 * follows the figure — the old Wall's mark for this very figure, the
 * Financials tab's "estimates" — in neutral ink (doc 14: provisional values
 * stay neutral). A site whose report is not in is left out and counted
 * ("1 of 2 sites"); with none in there is no number at all.
 */
function Yesterday({ total }: { total: YesterdayTotal }) {
  if (total.mixedBasis) {
    return (
      <span data-revenue-yesterday="mixed">
        Mixed report days · {total.reported} of {total.sites} sites · no total
      </span>
    );
  }
  const label = total.basis
    ? `${formatSeriesDate(total.basis.date)} · ${total.basis.timeZone === MEDIAVINE_REPORTING_CLOCK.timeZone ? MEDIAVINE_REPORTING_CLOCK.label : total.basis.timeZone}`
    : "provider days";
  if (total.amount === null) {
    return (
      <span className="whitespace-nowrap" data-revenue-yesterday="none">
        {label} not reported yet
      </span>
    );
  }
  const partial = total.reported < total.sites;
  return (
    <span data-revenue-yesterday={partial ? "some" : "all"}>
      <span className="whitespace-nowrap">
        {label}{" "}
        <span className="font-semibold text-foreground" data-revenue-yesterday-figure>
          {formatUsd(total.amount, { cents: true })}
        </span>{" "}
        est.
      </span>
      {partial ? (
        <>
          {" · "}
          <span className="whitespace-nowrap">
            {total.reported} of {total.sites} sites
          </span>
        </>
      ) : null}
    </span>
  );
}

/** The chart's x in viewBox units (0–1000) for a day of the month, inset so
 * the first and last days' dots and halos are never cut at the box's edge. */
function xOf(day: number, days: number): number {
  return days <= 1 ? 500 : 12 + ((day - 1) / (days - 1)) * 976;
}

// ─── where the crossing's words go (bead ro-trai.35) ────────────────────────

/** A point in the chart's own pixels, from its top left. */
interface Px {
  x: number;
  y: number;
}

/** A box's size in the chart's own pixels. */
interface Size {
  width: number;
  height: number;
}

/** Where the crossing's words sit against their dot. */
export interface CrossingPlacement {
  /** The words END at the dot (left of it) or START there (right of it). */
  side: "end" | "start";
  /** Above last month's line or below it. */
  vertical: "above" | "below";
  /** On two lines ("on pace to pass August" / "on Sep 26"), for a chart too
   * narrow for one. */
  wrapped: boolean;
  /** The words' box, top left, in the chart's own pixels. */
  left: number;
  top: number;
}

export interface CrossingScene {
  plot: Size;
  /** The words on one line, and on two. */
  label: { oneLine: Size; twoLines: Size };
  /** Last month's label, top left above its line; null when not drawn. */
  previousLabel: { width: number; height: number } | null;
  /** The crossing's dot, on last month's line. */
  crossing: Px;
  /** Today's dot, whose halo the words keep clear of; null with no reported day. */
  today: Px | null;
  /** The month's own lines as drawn, solid and dashed. */
  lines: readonly (readonly Px[])[];
}

/** The words' distance from their dot (pl-4/pr-4), above and below the line. */
const CROSSING_GAP_X = 16;
const CROSSING_GAP_ABOVE = 4;
const CROSSING_GAP_BELOW = 8;
/** Today's halo is 28 px across (`ChartDot` lg), plus a breath of room. */
const TODAY_CLEAR = 16;
/** The crossing's own dot (`ChartDot` md, no halo). */
const CROSSING_CLEAR = 6;
/** How far past a line's stroke the words keep. */
const LINE_CLEAR = 3;

type Candidate = Pick<CrossingPlacement, "side" | "vertical" | "wrapped">;

/** Right of centre the words end at their dot above the line — the TV's
 * place: left of the crossing and above last month's line the month's own
 * line never is. Left of centre they start at the dot below the line, where it
 * never is either. Then the same on two lines, then the other side. */
const RIGHT_OF_CENTRE: readonly Candidate[] = [
  { side: "end", vertical: "above", wrapped: false },
  { side: "end", vertical: "above", wrapped: true },
  { side: "start", vertical: "below", wrapped: false },
  { side: "start", vertical: "above", wrapped: false },
  { side: "start", vertical: "below", wrapped: true },
  { side: "end", vertical: "below", wrapped: false },
  { side: "end", vertical: "below", wrapped: true },
];
const LEFT_OF_CENTRE: readonly Candidate[] = [
  { side: "start", vertical: "below", wrapped: false },
  { side: "start", vertical: "below", wrapped: true },
  { side: "start", vertical: "above", wrapped: false },
  { side: "end", vertical: "above", wrapped: false },
  { side: "end", vertical: "above", wrapped: true },
  { side: "end", vertical: "below", wrapped: false },
];

/**
 * Where the crossing's words sit (bead ro-trai.35): the first place, in the
 * order above, that stays inside the chart and clear of today's dot and its
 * halo, the crossing's own dot, last month's label and the month's own lines.
 * A phone's chart is too narrow for the TV's place — last month's label is in
 * the way above, today's dot below — so there the words wrap onto two lines
 * above the line. With nowhere clear they take the first place.
 */
export function crossingLabelPlace(scene: CrossingScene): CrossingPlacement {
  const { plot, crossing } = scene;
  const blocked = [
    ...(scene.today ? [around(scene.today, TODAY_CLEAR)] : []),
    around(crossing, CROSSING_CLEAR),
    ...(scene.previousLabel
      ? [{ left: 0, top: crossing.y - scene.previousLabel.height, right: scene.previousLabel.width, bottom: crossing.y }]
      : []),
  ];
  const placed = (candidate: Candidate): CrossingPlacement => {
    const size = candidate.wrapped ? scene.label.twoLines : scene.label.oneLine;
    return {
      ...candidate,
      left: candidate.side === "end" ? crossing.x - CROSSING_GAP_X - size.width : crossing.x + CROSSING_GAP_X,
      top: candidate.vertical === "above" ? crossing.y - CROSSING_GAP_ABOVE - size.height : crossing.y + CROSSING_GAP_BELOW,
    };
  };
  const fits = (placement: CrossingPlacement) => {
    const size = placement.wrapped ? scene.label.twoLines : scene.label.oneLine;
    const box = { left: placement.left, top: placement.top, right: placement.left + size.width, bottom: placement.top + size.height };
    if (box.left < 0 || box.right > plot.width || box.bottom > plot.height) return false;
    if (blocked.some((other) => overlaps(box, other))) return false;
    const reach = { left: box.left - LINE_CLEAR, top: box.top - LINE_CLEAR, right: box.right + LINE_CLEAR, bottom: box.bottom + LINE_CLEAR };
    return !scene.lines.some((line) => crosses(line, reach));
  };
  const candidates = (crossing.x > plot.width * 0.58 ? RIGHT_OF_CENTRE : LEFT_OF_CENTRE).map(placed);
  return candidates.find(fits) ?? candidates[0]!;
}

/** The placement as CSS, anchored at the dot in the chart's own percentages
 * (the words' own size never moves the edge that faces the dot), so a zoomed
 * Wall and the TV draw it alike. */
function crossingAnchor(placement: CrossingPlacement, xPercent: number, yPercent: number): CSSProperties {
  return {
    ...(placement.side === "end"
      ? { right: `calc(${100 - xPercent}% + ${CROSSING_GAP_X}px)` }
      : { left: `calc(${xPercent}% + ${CROSSING_GAP_X}px)` }),
    ...(placement.vertical === "above"
      ? { bottom: `calc(${100 - yPercent}% + ${CROSSING_GAP_ABOVE}px)` }
      : { top: `calc(${yPercent}% + ${CROSSING_GAP_BELOW}px)` }),
  };
}

/** The placement's name, for the page's data attribute and the tests. */
export function crossingPlaceName(placement: Pick<CrossingPlacement, "side" | "vertical" | "wrapped">): string {
  return `${placement.side}-${placement.vertical}${placement.wrapped ? "-wrapped" : ""}`;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function around(point: Px, radius: number): Box {
  return { left: point.x - radius, top: point.y - radius, right: point.x + radius, bottom: point.y + radius };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** A drawn line enters the box: each segment sampled finely enough that a
 * line cannot pass between two samples of it. */
function crosses(line: readonly Px[], box: Box): boolean {
  for (let i = 1; i < line.length; i += 1) {
    const from = line[i - 1]!;
    const to = line[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    for (let step = 0; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      if (x > box.left && x < box.right && y > box.top && y < box.bottom) return true;
    }
  }
  return false;
}

/**
 * The month as a running total: reported days a solid line in the revenue
 * colour over a wash of it that fades to the floor, the pace dashed in the
 * same colour to the month's end, last month's total as a dashed hairline
 * labelled once, today's point with a halo, and the day the month passed (or
 * is on pace to pass) last month marked and named. One chart language with the
 * site rows (`ChartMarks`, bead `ro-trai.19`): monotone curves, round strokes,
 * a gradient wash.
 *
 * Everything lives in a 1000×100 viewBox stretched to the box with
 * non-scaling strokes, so the chart fills whatever the band leaves it without
 * measuring the page; the dots are round strokes, so the stretch never makes
 * an ellipse, and the words are HTML placed by the same percentages.
 */
export function MonthChart({ pace, period }: { pace: MonthPace; period: string }) {
  const { points, previousTotal, crossing } = pace;
  const days = points.length;
  const top = Math.max(previousTotal ?? 0, ...points.map((point) => point.cumulative), 1) * 1.14;
  // Zero sits on the box's floor, where the hairline baseline is drawn.
  const yOf = (value: number) => 100 - (value / top) * 100;
  const at = (point: { day: number; cumulative: number }) => ({ x: xOf(point.day, days), y: yOf(point.cumulative) });
  const actual = points.filter((point) => !point.projected);
  const last = actual.at(-1);
  const ahead = points.filter((point) => point.projected);
  const dashed = last ? [last, ...ahead] : ahead;
  const month = formatPeriodMonth(period);
  const previousName = formatPeriodMonthLong(pace.previousPeriod);
  // Two parts, so a narrow chart can put them on two lines.
  const crossingWords = crossing
    ? [`${crossing.projected ? "on pace to pass" : "passed"} ${previousName}`, `on ${month} ${crossing.day}`]
    : null;
  const crossingX = crossing ? xOf(crossing.day, days) / 10 : 0;
  const label = `${month}: ${formatUsd(last?.cumulative ?? 0)} so far, on pace for ${formatUsd(pace.projected)}${previousTotal !== null ? `, ${previousName} ${formatUsd(previousTotal)}` : ""}`;
  const previousY = previousTotal === null ? 0 : yOf(previousTotal);

  // The crossing's words are placed against what the chart actually draws at
  // this size (bead ro-trai.35): a phone's narrow chart put "on Sep 26" over
  // today's dot. Layout pixels (`offsetWidth`), the Wall's own, so a zoomed
  // Wall places them as the TV does.
  const plotRef = useRef<HTMLDivElement>(null);
  const crossingRef = useRef<HTMLSpanElement>(null);
  const previousRef = useRef<HTMLSpanElement>(null);
  const [placed, setPlaced] = useState<CrossingPlacement | null>(null);
  const crossingKey = crossing && previousTotal !== null ? `${crossing.day}:${previousY}:${points.map(at).map((p) => `${p.x},${p.y}`).join(" ")}` : null;
  useLayoutEffect(() => {
    const plot = plotRef.current;
    const words = crossingRef.current;
    const [lead, tail] = words ? ([...words.children] as HTMLElement[]) : [];
    if (!plot || !words || !lead || !tail || !crossing || previousTotal === null) return;
    const measure = () => {
      const width = plot.offsetWidth;
      const height = plot.offsetHeight;
      if (width === 0 || height === 0 || lead.offsetWidth === 0) return setPlaced(null);
      const px = (point: { x: number; y: number }): Px => ({ x: (point.x / 1000) * width, y: (point.y / 100) * height });
      // The two parts are flex items, so their sizes are the same on one
      // line or two; the gap between them is the word space.
      const gap = Number.parseFloat(getComputedStyle(words).columnGap) || 0;
      const line = Math.max(lead.offsetHeight, tail.offsetHeight);
      const previous = previousRef.current;
      const next = crossingLabelPlace({
        plot: { width, height },
        label: {
          oneLine: { width: lead.offsetWidth + gap + tail.offsetWidth, height: line },
          twoLines: { width: Math.max(lead.offsetWidth, tail.offsetWidth), height: line * 2 },
        },
        previousLabel: previous ? { width: previous.offsetWidth, height: previous.offsetHeight } : null,
        crossing: px({ x: xOf(crossing.day, days), y: previousY }),
        today: last ? px(at(last)) : null,
        lines: [actual, dashed].filter((run) => run.length > 1).map((run) => run.map((point) => px(at(point)))),
      });
      setPlaced((held) =>
        held && crossingPlaceName(held) === crossingPlaceName(next) && held.left === next.left && held.top === next.top ? held : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    observer.observe(lead);
    observer.observe(tail);
    if (previousRef.current) observer.observe(previousRef.current);
    return () => observer.disconnect();
    // `crossingKey` stands for everything the placement reads from the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossingKey]);

  if (points.length === 0) return null;
  return (
    <div className="flex h-40 min-h-0 flex-col gap-1.5 xl:h-auto xl:flex-1" data-month-chart>
      <div ref={plotRef} className="relative min-h-0 flex-1 text-financial-revenue" role="img" aria-label={label}>
        <svg
          className="absolute inset-0 size-full overflow-visible"
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          {previousTotal !== null ? (
            <line
              x1={0}
              x2={1000}
              y1={previousY}
              y2={previousY}
              className="stroke-muted-foreground opacity-60"
              strokeWidth={1.5}
              strokeDasharray="5 7"
              vectorEffect="non-scaling-stroke"
              data-previous-total
            />
          ) : null}
          {actual.length > 1 ? <ChartArea runs={[actual.map(at)]} baseline={100} strength={0.4} fadeEnd={0.1} /> : null}
          {dashed.length > 1 ? (
            <ChartLine runs={[dashed.map(at)]} kind="projection" width={3} data-month-pace />
          ) : null}
          {actual.length > 1 ? <ChartLine runs={[actual.map(at)]} width={4} data-month-actual /> : null}
          {crossing && previousTotal !== null ? (
            <ChartDot
              at={{ x: xOf(crossing.day, days), y: previousY }}
              size="md"
              halo={false}
              hollow={crossing.projected}
              className="text-foreground"
              data-month-crossing={crossing.projected ? "projected" : "passed"}
            />
          ) : null}
          {last ? <ChartDot at={at(last)} size="lg" data-month-today /> : null}
        </svg>
        {previousTotal !== null ? (
          // Top left, above its line: a running total starts at nothing, so the
          // month's own line is always below here and never under the words.
          <span
            ref={previousRef}
            className="absolute left-0 -translate-y-full pb-1.5 text-wall-micro whitespace-nowrap text-muted-foreground tabular-nums"
            style={{ top: `${previousY}%` }}
            data-previous-total-label
          >
            {previousName} total {formatUsd(previousTotal)}
          </span>
        ) : null}
        {crossingWords && previousTotal !== null ? (
          // Placed by `crossingLabelPlace` once the chart has a size. Until
          // then (and with no layout at all) the TV's rule: right of centre
          // the words end at the dot above the line, left of it they start
          // below it. Margins, not padding, so the measured box is the words;
          // the space between the parts is the flex gap, the font's own word
          // space (0.268 em in Inter), since a whitespace-only text node
          // between flex items is not drawn.
          <span
            ref={crossingRef}
            className={cn(
              "absolute flex gap-x-[0.268em] whitespace-nowrap text-wall-micro font-semibold text-foreground tabular-nums",
              placed?.wrapped && (placed.side === "end" ? "flex-col items-end" : "flex-col items-start"),
              !placed && (crossingX > 58 ? "-ml-4 -mt-1 -translate-x-full -translate-y-full" : "ml-4 mt-2"),
            )}
            style={placed ? crossingAnchor(placed, crossingX, previousY) : { left: `${crossingX}%`, top: `${previousY}%` }}
            data-month-crossing-label
            data-month-crossing-place={placed ? crossingPlaceName(placed) : undefined}
          >
            <span>{crossingWords[0]}</span> <span>{crossingWords[1]}</span>
          </span>
        ) : null}
        {/* The floor: one crisp hairline, the chart's zero. */}
        <span className="absolute inset-x-0 bottom-0 h-px bg-border" aria-hidden />
      </div>
      <div className="flex justify-between text-wall-micro text-muted-foreground tabular-nums" aria-hidden>
        <span>
          {month} {points[0]!.day}
        </span>
        <span>
          {month} {points.at(-1)!.day}
        </span>
      </div>
    </div>
  );
}
