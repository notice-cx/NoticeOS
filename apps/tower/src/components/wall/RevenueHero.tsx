import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CircleDollarSign } from "lucide-react";
import type { WordLevel } from "@shared/views";
import type { AssetCard, PortfolioBand } from "@shared/wall";
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

// The Wall's revenue widget: the month so far, where it lands, yesterday's
// money, and the month as a line against last month's total. The arithmetic
// is `lib/wall-revenue`; this file only draws it.
//
// In the TV's layout the month's chart is a layer behind the figures, filling
// the tile, so the tile is as tall as its lines of text and no taller. On a
// phone the tile is only as tall as its text, too short to read a chart
// behind it, so the chart is drawn under the figures.

export interface RevenueHeroProps {
  portfolio: PortfolioBand;
  assets: readonly Pick<AssetCard, "revenueProjection" | "dailyRevenue">[];
  /** The Wall's clock, which "yesterday" is asked on; this render's own when
   * absent. */
  nowMs?: number;
  /** The words of the view the TV is drawn for: "business" calls an estimate
   * "so far", as Home's money does; the other levels say "est.". */
  wordLevel?: WordLevel;
}

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

/** The month's marks behind the figures on the TV: low enough that the
 * figures over them read first, and still a graphic a reader can see
 * (`test/chart-series-contrast.test.ts` measures both). */
export const MONTH_CHART_BEHIND_OPACITY = 0.6;

export function RevenueHero({ portfolio, assets, nowMs, wordLevel = "operational" }: RevenueHeroProps) {
  const business = wordLevel === "business";
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
      // `isolate`: the chart's layer is drawn under the figures and over the
      // Wall's black, never under the page. Where the layout leaves no room
      // clear of the line, the knockout keeps every word over it legible.
      className={cn("flex min-w-0 flex-col gap-2", pace && "relative isolate tv:text-shadow-knockout")}
      data-wall-revenue={model.revenue === null ? "waiting" : pace ? "pace" : "figure"}
    >
      <h2 className={eyebrow}>
        {month} revenue
        {/* The one word that keeps an estimate from reading as booked money;
            the business words carry it as "so far" beside yesterday's figure. */}
        {model.revenue !== null && model.state === "forecast" && !business ? " · estimated" : null}
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
      {/* On the TV this row takes whatever height the tile has beyond its
          text, the figure at its top and the pace at its foot. A running
          total rises from the bottom left to the top right, so the room a
          taller tile opens above the pace is where today's point, the
          projection and the crossing are drawn. */}
      <div className={cn("flex min-w-0 flex-wrap items-end gap-x-6 gap-y-1", pace && "tv:flex-1")}>
        {/* No figure while no source has a complete day this month. */}
        {model.revenue !== null ? (
          <span
            className="text-wall-display font-bold tracking-tighter tabular-nums tv:self-start"
            data-revenue-figure
          >
            {formatUsd(model.revenue)}
          </span>
        ) : null}
        {pace ? (
          <PaceLine pace={pace} yesterday={yesterday} business={business} />
        ) : model.waiting || yesterday ? (
          // No pace yet (a projection still learning — a new installation's
          // first three weeks — or an older ledger month): the reason, and
          // yesterday under it all the same.
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1 pb-2 text-wall-body text-muted-foreground tabular-nums">
            {model.revenue !== null && model.waiting ? <span data-revenue-waiting>{model.waiting}</span> : null}
            {yesterday ? <Yesterday total={yesterday} business={business} /> : null}
          </div>
        ) : null}
      </div>
      {pace ? <MonthChart pace={pace} period={model.period} /> : null}
    </section>
  );
}

function PaceLine({ pace, yesterday, business }: { pace: MonthPace; yesterday: YesterdayTotal | null; business: boolean }) {
  const previous = formatPeriodMonth(pace.previousPeriod);
  const comparisonDirection = pace.changePercent === null ? null : pace.changePercent > 0 ? "above" : pace.changePercent < 0 ? "below" : "level with";
  return (
    // Beside the figure while 16 rem are left there; under it on a phone. In
    // the TV's layout it never drops.
    <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2 pb-2 tv:basis-0" data-revenue-pace>
      <span className="text-2xl font-medium tabular-nums">
        on pace for <span className="font-bold">{formatUsd(pace.projected)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-wall-body tabular-nums">
        {pace.changePercent !== null ? (
          // Neutral ink: a projection against a finished month is not a
          // like-for-like comparison, so no colour judges it.
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
              <Yesterday total={yesterday} business={business} />
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
 * Yesterday's revenue. It is the providers' estimate, so "est." ("so far" in
 * the business words) follows the figure in neutral ink. A site whose report
 * is not in is left out and counted ("1 of 2 sites"); with none in there is
 * no number at all.
 */
function Yesterday({ total, business }: { total: YesterdayTotal; business: boolean }) {
  if (total.mixedBasis) {
    return (
      <span data-revenue-yesterday="mixed">
        Mixed report days · {total.reported} of {total.sites} sites · no total
      </span>
    );
  }
  const label = total.basis
    ? `${formatSeriesDate(total.basis.date)} · ${total.basis.label ?? total.basis.timeZone}`
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
        {business ? "so far" : "est."}
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

// ─── where the crossing's words go ──────────────────────────────────────────

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
  /** Last month's label, top left above its line; null when not drawn there. */
  previousLabel: { width: number; height: number } | null;
  /** The crossing's dot, on last month's line. */
  crossing: Px;
  /** Today's dot, whose halo the words keep clear of; null with no reported day. */
  today: Px | null;
  /** The month's own lines as drawn, solid and dashed. */
  lines: readonly (readonly Px[])[];
  /** Whatever else the words keep clear of: the figures drawn over the chart. */
  blocked?: readonly Box[];
  /** The words stay below the chart's top as well: behind the figures, the
   * chart's top is the tile's. */
  contained?: boolean;
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
/** How far a label keeps beside the figures drawn over the chart, so the two
 * never read as one line of words. */
const TEXT_CLEAR = 8;

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
 * Where the crossing's words sit: the first place, in the order above, that
 * stays inside the chart and clear of today's dot and its halo, the
 * crossing's own dot, last month's label, the month's own lines and anything
 * else `blocked`. With nowhere clear they take the first place.
 */
export function crossingLabelPlace(scene: CrossingScene): CrossingPlacement {
  const candidates = crossingCandidates(scene);
  return candidates.find(crossingClear(scene)) ?? candidates[0]!;
}

/** The first clear place for the crossing's words, or null where none is. */
function crossingClearPlace(scene: CrossingScene): CrossingPlacement | null {
  return crossingCandidates(scene).find(crossingClear(scene)) ?? null;
}

function crossingCandidates(scene: CrossingScene): CrossingPlacement[] {
  const { plot, crossing } = scene;
  return (crossing.x > plot.width * 0.58 ? RIGHT_OF_CENTRE : LEFT_OF_CENTRE).map((candidate) => {
    const size = candidate.wrapped ? scene.label.twoLines : scene.label.oneLine;
    return {
      ...candidate,
      left: candidate.side === "end" ? crossing.x - CROSSING_GAP_X - size.width : crossing.x + CROSSING_GAP_X,
      top: candidate.vertical === "above" ? crossing.y - CROSSING_GAP_ABOVE - size.height : crossing.y + CROSSING_GAP_BELOW,
    };
  });
}

function crossingClear(scene: CrossingScene): (placement: CrossingPlacement) => boolean {
  const { crossing } = scene;
  const blocked = [
    ...(scene.today ? [around(scene.today, TODAY_CLEAR)] : []),
    around(crossing, CROSSING_CLEAR),
    ...(scene.previousLabel
      ? [{ left: 0, top: crossing.y - scene.previousLabel.height, right: scene.previousLabel.width, bottom: crossing.y }]
      : []),
    ...(scene.blocked ?? []),
  ];
  const room: Room = { plot: scene.plot, blocked, lines: scene.lines, contained: scene.contained ?? false };
  return (placement) => clearIn(crossingBox(placement, scene.label), room);
}

function crossingBox(placement: CrossingPlacement, label: CrossingScene["label"]): Box {
  const size = placement.wrapped ? label.twoLines : label.oneLine;
  return { left: placement.left, top: placement.top, right: placement.left + size.width, bottom: placement.top + size.height };
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

// ─── where last month's words go ────────────────────────────────────────────

/** Last month's words on its line: their box's left edge in the chart's own
 * pixels, above the line or below it. */
export interface PreviousPlacement {
  vertical: "above" | "below";
  left: number;
}

export interface PreviousScene {
  plot: Size;
  /** The words' box, its gap to the line included. */
  label: Size;
  /** Last month's line, in the chart's own pixels from its top. */
  rule: number;
  /** The figures over the chart, the dots and the crossing's words. */
  blocked: readonly Box[];
  /** The month's own lines as drawn. */
  lines: readonly (readonly Px[])[];
}

/** How far apart the places along last month's line are tried. */
const PREVIOUS_STEP = 8;

/**
 * Where last month's words sit behind the figures: the first place along its
 * line, from the left end to the right, above the line and then below it,
 * that stays inside the chart and clear of everything `blocked` and the
 * month's own lines. Null where there is none: the words are left out rather
 * than drawn over the figures, and the chart's label still names the total.
 */
export function previousLabelPlace(scene: PreviousScene): PreviousPlacement | null {
  const room: Room = { plot: scene.plot, blocked: scene.blocked, lines: scene.lines, contained: true };
  const lefts: number[] = [];
  for (let left = 0; left + scene.label.width <= scene.plot.width; left += PREVIOUS_STEP) lefts.push(left);
  lefts.push(scene.plot.width - scene.label.width);
  for (const left of lefts) {
    for (const vertical of ["above", "below"] as const) {
      if (clearIn(previousBox(scene, { vertical, left }), room)) return { vertical, left };
    }
  }
  return null;
}

function previousBox(scene: Pick<PreviousScene, "label" | "rule">, placement: PreviousPlacement): Box {
  const top = placement.vertical === "above" ? scene.rule - scene.label.height : scene.rule;
  return { left: placement.left, top, right: placement.left + scene.label.width, bottom: top + scene.label.height };
}

// ─── both labels together ───────────────────────────────────────────────────

export interface ChartLabelScene {
  plot: Size;
  /** The crossing's dot and its words' sizes; null with no crossing drawn. */
  crossing: { at: Px; label: CrossingScene["label"] } | null;
  /** Last month's line and its words' box; null with no last month. */
  previous: { rule: number; label: Size } | null;
  today: Px | null;
  lines: readonly (readonly Px[])[];
  /** The tile's text drawn over the chart, in the chart's own pixels; null
   * where the chart is under the figures. */
  over: readonly Box[] | null;
}

export interface ChartLabels {
  /** Null: no clear place behind the figures, so the words are left out. */
  crossing: CrossingPlacement | null;
  previous: PreviousPlacement | null;
}

/**
 * Where the chart's two labels go. Under the figures (a phone), last month's
 * words sit top left above its line, where a running total never is, and the
 * crossing's words keep clear of them. Behind the figures (the TV), both keep
 * clear of the text over the chart too: last month's words stay top left
 * where that is clear, and otherwise the crossing's words are placed first
 * and last month's find the first clear place along its line. A label with no
 * clear place is left out rather than drawn over the figures.
 */
export function chartLabelsPlace(scene: ChartLabelScene): ChartLabels {
  const { plot, today, lines } = scene;
  const crossingScene = (previousLabel: Size | null, blocked: readonly Box[], contained: boolean): CrossingScene | null =>
    scene.crossing ? { plot, label: scene.crossing.label, previousLabel, crossing: scene.crossing.at, today, lines, blocked, contained } : null;
  const atStart: PreviousPlacement = { vertical: "above", left: 0 };
  if (scene.over === null) {
    const placing = crossingScene(scene.previous?.label ?? null, [], false);
    return { previous: scene.previous ? atStart : null, crossing: placing ? crossingLabelPlace(placing) : null };
  }
  const over = scene.over.map((box) => ({ left: box.left - TEXT_CLEAR, top: box.top, right: box.right + TEXT_CLEAR, bottom: box.bottom }));
  const dots = [...(today ? [around(today, TODAY_CLEAR)] : []), ...(scene.crossing ? [around(scene.crossing.at, CROSSING_CLEAR)] : [])];
  const room: Room = { plot, blocked: [...over, ...dots], lines, contained: true };
  if (scene.previous && clearIn(previousBox(scene.previous, atStart), room)) {
    const placing = crossingScene(scene.previous.label, over, true);
    return { previous: atStart, crossing: placing ? crossingClearPlace(placing) : null };
  }
  const placing = crossingScene(null, over, true);
  const crossing = placing ? crossingClearPlace(placing) : null;
  const words = crossing && scene.crossing ? [crossingBox(crossing, scene.crossing.label)] : [];
  const previous = scene.previous
    ? previousLabelPlace({ plot, label: scene.previous.label, rule: scene.previous.rule, blocked: [...over, ...dots, ...words], lines })
    : null;
  return { crossing, previous };
}

// ─── the geometry both placements share ─────────────────────────────────────

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a label must stay inside and clear of. */
interface Room {
  plot: Size;
  blocked: readonly Box[];
  lines: readonly (readonly Px[])[];
  /** The label's top stays inside the chart too. */
  contained: boolean;
}

function clearIn(box: Box, room: Room): boolean {
  if (box.left < 0 || box.right > room.plot.width || box.bottom > room.plot.height) return false;
  if (room.contained && box.top < 0) return false;
  if (room.blocked.some((other) => overlaps(box, other))) return false;
  const reach = { left: box.left - LINE_CLEAR, top: box.top - LINE_CLEAR, right: box.right + LINE_CLEAR, bottom: box.bottom + LINE_CLEAR };
  return !room.lines.some((line) => crosses(line, reach));
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
 * The tile's text drawn over the chart, as boxes in the chart's own pixels:
 * every line of words, wherever it wraps, and the change chip's pill. Read
 * from the client rectangles, so a zoomed Wall is measured as the TV is.
 */
function textOver(tile: HTMLElement, plot: HTMLElement): Box[] {
  const frame = plot.getBoundingClientRect();
  // The Wall's zoom: client pixels per layout pixel.
  const scale = frame.width / plot.offsetWidth || 1;
  const inPlot = (rect: DOMRect): Box => ({
    left: (rect.left - frame.left) / scale,
    top: (rect.top - frame.top) / scale,
    right: (rect.right - frame.left) / scale,
    bottom: (rect.bottom - frame.top) / scale,
  });
  const chart = plot.closest("[data-month-chart]");
  const boxes: Box[] = [];
  const walker = tile.ownerDocument.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
  const range = tile.ownerDocument.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.trim() || chart?.contains(node)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.width > 0) boxes.push(inPlot(rect));
  }
  for (const pill of tile.querySelectorAll("[data-revenue-change]")) boxes.push(inPlot(pill.getBoundingClientRect()));
  return boxes;
}

/** The labels as drawn: last month's left edge as a share of the chart. */
interface DrawnLabels {
  crossing: CrossingPlacement | null;
  previous: { vertical: PreviousPlacement["vertical"]; leftPercent: number } | null;
}

function sameDrawn(a: DrawnLabels, b: DrawnLabels): boolean {
  const crossing = a.crossing === null || b.crossing === null
    ? a.crossing === b.crossing
    : crossingPlaceName(a.crossing) === crossingPlaceName(b.crossing) && a.crossing.left === b.crossing.left && a.crossing.top === b.crossing.top;
  const previous = a.previous === null || b.previous === null
    ? a.previous === b.previous
    : a.previous.vertical === b.previous.vertical && a.previous.leftPercent === b.previous.leftPercent;
  return crossing && previous;
}

/**
 * The month as a running total: reported days a solid line in the revenue
 * colour over a wash of it that fades to the floor, the pace dashed in the
 * same colour to the month's end, last month's total as a dashed hairline
 * labelled once, today's point with a halo, and the day the month passed (or
 * is on pace to pass) last month marked and named. A 1000×100 viewBox
 * stretched to the box with non-scaling strokes; the dots are round strokes,
 * so the stretch never makes an ellipse, and the words are HTML placed by the
 * same percentages.
 *
 * In the TV's layout the plot is a layer of the tile it is drawn in, filling
 * it behind its text, its marks at `MONTH_CHART_BEHIND_OPACITY`, and the two
 * labels keep clear of that text. Elsewhere it is a box of its own under the
 * figures.
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

  // Placed against what the chart actually draws at this size, in layout
  // pixels (`offsetWidth`), so a zoomed Wall places them as the TV does.
  const plotRef = useRef<HTMLDivElement>(null);
  const crossingRef = useRef<HTMLSpanElement>(null);
  const previousRef = useRef<HTMLSpanElement>(null);
  // Null until measured: the labels then sit in the phone's places.
  const [placed, setPlaced] = useState<DrawnLabels | null>(null);
  const placeKey = previousTotal !== null ? `${crossing?.day ?? ""}:${previousY}:${points.map(at).map((p) => `${p.x},${p.y}`).join(" ")}` : null;
  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot || previousTotal === null) return;
    const measure = () => {
      const width = plot.offsetWidth;
      const height = plot.offsetHeight;
      if (width === 0 || height === 0) return setPlaced(null);
      const px = (point: { x: number; y: number }): Px => ({ x: (point.x / 1000) * width, y: (point.y / 100) * height });
      const words = crossingRef.current;
      const [lead, tail] = words ? ([...words.children] as HTMLElement[]) : [];
      let crossingScene: ChartLabelScene["crossing"] = null;
      if (crossing && words && lead && tail) {
        if (lead.offsetWidth === 0) return setPlaced(null);
        // The two parts are flex items, so their sizes are the same on one
        // line or two; the gap between them is the word space.
        const gap = Number.parseFloat(getComputedStyle(words).columnGap) || 0;
        const line = Math.max(lead.offsetHeight, tail.offsetHeight);
        crossingScene = {
          at: px({ x: xOf(crossing.day, days), y: previousY }),
          label: {
            oneLine: { width: lead.offsetWidth + gap + tail.offsetWidth, height: line },
            twoLines: { width: Math.max(lead.offsetWidth, tail.offsetWidth), height: line * 2 },
          },
        };
      }
      const previous = previousRef.current;
      // Behind the figures the plot is a layer positioned in the tile, its
      // offset parent; under them it is a box in the tile's flow.
      const tile = plot.offsetParent;
      const behind = getComputedStyle(plot).position === "absolute" && tile instanceof HTMLElement;
      const next = chartLabelsPlace({
        plot: { width, height },
        crossing: crossingScene,
        previous: previous ? { rule: (previousY / 100) * height, label: { width: previous.offsetWidth, height: previous.offsetHeight } } : null,
        today: last ? px(at(last)) : null,
        lines: [actual, dashed].filter((run) => run.length > 1).map((run) => run.map((point) => px(at(point)))),
        over: behind ? textOver(tile, plot) : null,
      });
      const drawn: DrawnLabels = {
        crossing: next.crossing,
        previous: next.previous ? { vertical: next.previous.vertical, leftPercent: (next.previous.left / width) * 100 } : null,
      };
      setPlaced((held) => (held && sameDrawn(held, drawn) ? held : drawn));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    for (const part of crossingRef.current?.children ?? []) observer.observe(part);
    if (previousRef.current) observer.observe(previousRef.current);
    // The figures over the chart move when the tile's text does.
    if (plot.offsetParent) observer.observe(plot.offsetParent);
    return () => observer.disconnect();
    // `placeKey` stands for everything the placement reads from the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);

  if (points.length === 0) return null;
  // Undefined until measured; null where behind the figures nothing is clear.
  const crossingPlace = placed === null ? undefined : placed.crossing;
  const previousPlace = placed === null ? undefined : placed.previous;
  return (
    // On the TV the wrapper dissolves: the plot is a layer of the tile behind
    // its text, ending where the dates begin, and the dates are the tile's
    // last line.
    <div className="flex h-40 min-h-0 flex-col gap-1.5 tv:contents" data-month-chart>
      <div
        ref={plotRef}
        className="relative min-h-0 flex-1 text-financial-revenue tv:absolute tv:inset-x-0 tv:top-0 tv:bottom-wall-month-axis tv:-z-10"
        role="img"
        aria-label={label}
      >
        <svg
          className="absolute inset-0 size-full overflow-visible tv:opacity-(--month-chart-behind)"
          style={{ "--month-chart-behind": MONTH_CHART_BEHIND_OPACITY } as CSSProperties}
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          aria-hidden
          data-month-marks
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
          // month's own line is always below there. Behind the figures, the
          // first clear place along the line (`chartLabelsPlace`).
          <span
            ref={previousRef}
            className={cn(
              "absolute whitespace-nowrap text-wall-micro text-muted-foreground tabular-nums",
              previousPlace?.vertical === "below" ? "pt-1.5" : "-translate-y-full pb-1.5",
              previousPlace === null && "invisible",
            )}
            style={{ top: `${previousY}%`, left: previousPlace ? `${previousPlace.leftPercent}%` : 0 }}
            data-previous-total-label
            data-previous-total-place={previousPlace === undefined ? undefined : previousPlace === null ? "none" : previousPlace.vertical}
          >
            {previousName} total {formatUsd(previousTotal)}
          </span>
        ) : null}
        {crossingWords && previousTotal !== null ? (
          // Placed by `chartLabelsPlace` once the chart has a size. Until
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
              crossingPlace?.wrapped && (crossingPlace.side === "end" ? "flex-col items-end" : "flex-col items-start"),
              !crossingPlace && (crossingX > 58 ? "-ml-4 -mt-1 -translate-x-full -translate-y-full" : "ml-4 mt-2"),
              crossingPlace === null && "invisible",
            )}
            style={crossingPlace ? crossingAnchor(crossingPlace, crossingX, previousY) : { left: `${crossingX}%`, top: `${previousY}%` }}
            data-month-crossing-label
            data-month-crossing-place={crossingPlace === undefined ? undefined : crossingPlace === null ? "none" : crossingPlaceName(crossingPlace)}
          >
            <span>{crossingWords[0]}</span> <span>{crossingWords[1]}</span>
          </span>
        ) : null}
        {/* The floor: one crisp hairline, the chart's zero. */}
        <span className="absolute inset-x-0 bottom-0 h-px bg-border" aria-hidden />
      </div>
      <div className="flex justify-between text-wall-micro text-muted-foreground tabular-nums" aria-hidden data-month-dates>
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
