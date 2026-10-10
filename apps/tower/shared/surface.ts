// The arithmetic behind a desk surface, with no DOM in it: window a series
// to the range, average it, compare it with the period before it, decide
// which of its points the provider has not finished, and decide where an
// annotation lands. Shared by the Overview's strip and the Growth tab's
// chart pairs, so a KPI's delta cannot disagree with the chart under it.

import { type SeriesPoint, type TimeZoneChangePoint } from "./wall";

const DAY_MS = 86_400_000;

/** The ranges the operator can pick. `28` is the default: a week is too
 * short to see a trend through weekly seasonality, and ninety days puts the
 * last fortnight into a few dozen pixels. */
export const SURFACE_RANGES = [7, 28, 90] as const;

export type RangeDays = (typeof SURFACE_RANGES)[number];

export const DEFAULT_RANGE_DAYS: RangeDays = 28;

/** A series' grain, read off its own labels: `SeriesPoint.t` is either a day
 * (`YYYY-MM-DD`) or an accounting month (`YYYY-MM`), and every function here
 * has to know which before it can do date arithmetic. */
export type SeriesGrain = "daily" | "monthly";

export function seriesGrain(series: readonly SeriesPoint[]): SeriesGrain {
  return series.some((point) => point.t.length === 7) ? "monthly" : "daily";
}

/** `YYYY-MM-DD` shifted by whole days, in UTC. */
function shiftDay(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM` shifted by whole months. */
function shiftMonth(period: string, months: number): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)) - 1 + months;
  const at = new Date(Date.UTC(year, month, 1));
  return at.toISOString().slice(0, 7);
}

/** One step back along the series' own grain — days or months. */
export function shiftLabel(label: string, steps: number): string {
  return label.length === 7 ? shiftMonth(label, steps) : shiftDay(label, steps);
}

/**
 * The labels a series skips — the axis it claims, minus the points it has. A
 * `Sparkline` spaces its points by position, so three points always look like
 * three consecutive periods; this is what a caller filling an axis uses to
 * know where the holes go. It walks the series' own grain from its first
 * label to its last, so it never invents a period outside the series' range.
 */
export function missingLabels(series: readonly SeriesPoint[]): string[] {
  const first = series[0]?.t;
  const last = series.at(-1)?.t;
  if (first === undefined || last === undefined) return [];
  const present = new Set(series.map((point) => point.t));
  const gaps: string[] = [];
  // Bounded by the series' own span, and defensively by its length, so an
  // unsorted series gets an empty answer rather than a hung loop.
  for (
    let label = first, guard = 0;
    label !== last && guard < 10_000;
    label = shiftLabel(label, 1), guard++
  ) {
    if (!present.has(label)) gaps.push(label);
  }
  return gaps;
}

/**
 * The last `length` periods of a series, by date and not by point count.
 * Counting points would silently widen the window whenever the provider
 * missed a day; missing days stay missing and the chart draws the gap.
 */
export function windowSeries(
  series: readonly SeriesPoint[],
  length: number,
): SeriesPoint[] {
  const last = series.at(-1);
  if (!last || length < 1) return [];
  const start = shiftLabel(last.t, -(length - 1));
  return series.filter((point) => point.t >= start);
}

/**
 * A period a series has no reading for. A gap is not a zero and it is not an
 * absent element: `{ t, v: null }` says "this period exists and nobody
 * reported it", which is what lets a line break over it.
 */
export interface SeriesGap {
  t: string;
  v: null;
}

/** A series that may have holes in it. */
export type SeriesPointOrGap = SeriesPoint | SeriesGap;

/** Complete a chronological calendar axis without inventing measurements.
 * Unsupported, mixed or unordered labels stay untouched: a period must be
 * established before missing dates can be inferred. */
export function fillSeriesGaps(series: readonly SeriesPointOrGap[]): SeriesPointOrGap[] {
  if (series.length < 2) return [...series];
  const monthly = /^\d{4}-(0[1-9]|1[0-2])$/.test(series[0]!.t);
  const validLabel = (label: string) => {
    if (monthly) return /^\d{4}-(0[1-9]|1[0-2])$/.test(label) && shiftLabel(label, 0) === label;
    if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(label)) return false;
    const date = new Date(`${label}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === label;
  };
  if (series.some((point, index) => !validLabel(point.t) || (index > 0 && point.t <= series[index - 1]!.t))) {
    return [...series];
  }
  // A supplied null is already a position on the axis, not another omission.
  const gaps = missingLabels(series.map((point) => ({ t: point.t, v: 0 })));
  return [...series, ...gaps.map((t) => ({ t, v: null }))].sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * The trailing average drawn in bold with the raw line faint. One point out
 * for every point in. The window is a calendar window: a day the provider
 * never reported contributes nothing and is not counted. The first days of a
 * series therefore carry a partial average, which is why a caller with history
 * behind the visible range averages the whole series and windows afterwards.
 */
export function averageSeries(
  series: readonly SeriesPoint[],
  windowLength?: number,
): SeriesPoint[];
export function averageSeries(
  series: readonly SeriesPointOrGap[],
  windowLength?: number,
): SeriesPointOrGap[];
export function averageSeries(
  series: readonly SeriesPointOrGap[],
  windowLength = 7,
): SeriesPointOrGap[] {
  if (windowLength < 1) return [];
  const byLabel = new Map(series.map((point) => [point.t, point.v]));
  return series.map((point) => {
    // A hole stays a hole: the line has to break there.
    if (point.v === null) return { t: point.t, v: null };
    let sum = 0;
    let seen = 0;
    for (let back = 0; back < windowLength; back += 1) {
      const value = byLabel.get(shiftLabel(point.t, -back));
      if (value === undefined || value === null) continue;
      sum += value;
      seen += 1;
    }
    return { t: point.t, v: seen === 0 ? point.v : sum / seen };
  });
}

export type DeltaTone = "up" | "down" | "flat";

/** A window of the operator's calendar, inclusive at both ends. */
export interface SurfaceWindow {
  start: string;
  end: string;
}

/**
 * What a KPI's delta claims: this range's total against the same length of
 * time immediately before it. `comparable` is separate from `tone`: tone is
 * the direction the figures moved, always true; comparable is whether the two
 * sides are the same measurement, false when a reporting-timezone change
 * moved hours across the window's days or the two sides do not cover the same
 * number of observed periods. A page colours the delta only while comparable.
 */
export interface PeriodDelta {
  /** The range this compares, in the series' own grain. */
  length: number;
  currentTotal: number;
  priorTotal: number;
  /** Signed movement, `currentTotal - priorTotal`. */
  change: number;
  /** Signed percent, or `null` when the prior period totalled zero — a share
   * of nothing is not a number and a surface says so rather than printing ∞. */
  percent: number | null;
  tone: DeltaTone;
  comparable: boolean;
  /** Observed periods on each side; equal is what makes them like-for-like. */
  currentPeriods: number;
  priorPeriods: number;
  window: SurfaceWindow;
  priorWindow: SurfaceWindow;
}

/** `null` when there is nothing to compare against — no points at all, or a
 * prior period the series does not reach back into. */
export function periodDelta(
  series: readonly SeriesPoint[],
  length: number,
  timeZoneChanges: readonly TimeZoneChangePoint[] = [],
  provisionalFrom: string | null = null,
): PeriodDelta | null {
  // The delta excludes the day the provider has not closed: a day still being
  // counted is always short, so a comparison anchored on it reports a fall
  // every single morning.
  const settled =
    provisionalFrom === null
      ? series
      : series.filter((point) => point.t < provisionalFrom);
  const last = settled.at(-1);
  if (!last || length < 1) return null;

  const window: SurfaceWindow = { start: shiftLabel(last.t, -(length - 1)), end: last.t };
  const priorWindow: SurfaceWindow = {
    start: shiftLabel(last.t, -(2 * length - 1)),
    end: shiftLabel(last.t, -length),
  };

  const inWindow = (point: SeriesPoint) => point.t >= window.start && point.t <= window.end;
  const inPrior = (point: SeriesPoint) =>
    point.t >= priorWindow.start && point.t <= priorWindow.end;

  const current = settled.filter(inWindow);
  const prior = settled.filter(inPrior);
  if (current.length === 0 || prior.length === 0) return null;

  const total = (points: SeriesPoint[]) => points.reduce((sum, point) => sum + point.v, 0);
  const currentTotal = total(current);
  const priorTotal = total(prior);
  const change = currentTotal - priorTotal;

  const straddles = timeZoneChanges.some(
    (point) => point.effectiveOn >= priorWindow.start && point.effectiveOn <= window.end,
  );

  return {
    length,
    currentTotal,
    priorTotal,
    change,
    percent: priorTotal === 0 ? null : (change / priorTotal) * 100,
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    comparable: !straddles && current.length === prior.length,
    currentPeriods: current.length,
    priorPeriods: prior.length,
    window,
    priorWindow,
  };
}

/** The one sentence a delta owes its reader: which two windows, over what.
 * It becomes both the hover and the accessible name. */
export function deltaMeaning(delta: PeriodDelta, grain: SeriesGrain = "daily"): string {
  const unit = grain === "monthly" ? "month" : "day";
  const span = `${delta.length} ${unit}${delta.length === 1 ? "" : "s"}`;
  const windows = `the last ${span} vs the ${span} before`;
  if (delta.comparable) return windows;
  // Why it is not like-for-like, as the fact itself: the reader already sees
  // "Not comparable" and needs which of the two things broke it.
  return delta.currentPeriods !== delta.priorPeriods
    ? `${windows} · ${delta.currentPeriods} vs ${delta.priorPeriods} ${unit}s reported`
    : `${windows} · reporting timezone changed`;
}

/** The first point the provider has not finished, or `-1`. `provisionalFrom`
 * is a boundary in the series' own grain and marks a tail; it is deliberately
 * not "the last point", because a provider that has published today has no
 * provisional point at all. */
export function provisionalIndex(
  // Labels only, so a series with holes in it can be asked the same question.
  series: readonly { t: string }[],
  provisionalFrom: string | null,
): number {
  if (provisionalFrom === null) return -1;
  return series.findIndex((point) => point.t >= provisionalFrom);
}

/** Whether the point a chart caps its line with is a provisional one. */
export function lastPointIsProvisional(
  series: readonly SeriesPoint[],
  provisionalFrom: string | null,
): boolean {
  const at = provisionalIndex(series, provisionalFrom);
  return at >= 0 && at <= series.length - 1;
}

/** A mark on a chart's own x axis: what happened, and on which day. */
export interface SurfaceAnnotation {
  date: string;
  /** Defaults to the caret the footnote legend names. */
  glyph?: string;
  label: string;
  /** Full event explanation, disclosed at its marker rather than below the chart. */
  detail?: string;
}

export interface PlacedAnnotation {
  /** Index into the series handed in — the x position the mark is drawn at. */
  index: number;
  /** The point's OWN label, not the annotation's date: the mark sits on a day
   * the chart actually draws or it is not drawn at all. */
  at: string;
  glyph: string;
  /** Every annotation that landed here, in the order they were given. */
  labels: string[];
  /** Original event dates/details survive grouping, including a monthly plot. */
  events: SurfaceAnnotation[];
}

/** A span drawn behind a series: the days a change is being watched, so
 * cause (the ▲ mark) and the window its effect is judged in sit on one axis. */
export interface SurfaceSpan {
  /** First and last day, inclusive, in the series' own labels. */
  start: string;
  end: string;
  /** Under twelve words: what is being watched and when the verdict lands. */
  label: string;
}

export interface PlacedSpan {
  startIndex: number;
  endIndex: number;
  label: string;
  /** The span runs past the window's edge on that side. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** Where each span lands on a drawn axis. A span wholly outside the window
 * is dropped; one that crosses an edge is clipped and says so. */
export function placeSpans(domain: readonly string[], spans: readonly SurfaceSpan[]): PlacedSpan[] {
  if (domain.length === 0) return [];
  const first = domain[0]!;
  const last = domain[domain.length - 1]!;
  const indexOf = new Map(domain.map((label, index) => [label, index]));
  return spans.flatMap((span) => {
    if (span.end < first || span.start > last || span.end < span.start) return [];
    const clippedStart = span.start < first;
    const clippedEnd = span.end > last;
    const startIndex = clippedStart ? 0 : (indexOf.get(span.start) ?? domain.findIndex((label) => label >= span.start));
    const endIndex = clippedEnd ? domain.length - 1 : (indexOf.get(span.end) ?? domain.findLastIndex((label) => label <= span.end));
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return [];
    return [{ startIndex, endIndex, label: span.label, clippedStart, clippedEnd }];
  }).sort((a, b) => a.startIndex - b.startIndex);
}

export const ANNOTATION_GLYPH = "▲";

/**
 * Where each annotation lands on a drawn series. An annotation whose day is
 * not in this window is dropped, never clamped to an edge; a monthly series
 * matches on the month; several annotations on one point merge into one mark
 * carrying every sentence.
 */
export function placeAnnotations(
  series: readonly SeriesPoint[],
  annotations: readonly SurfaceAnnotation[],
): PlacedAnnotation[] {
  const grain = seriesGrain(series);
  const indexOf = new Map<string, number>();
  series.forEach((point, index) => indexOf.set(point.t, index));

  const placed = new Map<number, PlacedAnnotation>();
  for (const annotation of annotations) {
    const key = grain === "monthly" ? annotation.date.slice(0, 7) : annotation.date;
    const index = indexOf.get(key);
    if (index === undefined) continue;
    const existing = placed.get(index);
    if (existing) {
      existing.labels.push(annotation.label);
      existing.events.push(annotation);
      continue;
    }
    placed.set(index, {
      index,
      at: series[index]!.t,
      glyph: annotation.glyph ?? ANNOTATION_GLYPH,
      labels: [annotation.label],
      events: [annotation],
    });
  }

  return [...placed.values()].sort((a, b) => a.index - b.index);
}

/** Saturday and Sunday, as index spans over a daily series. A monthly or
 * stepped series gets none: a weekend inside an accounting month is not a fact
 * about the month. */
export interface WeekendSpan {
  startIndex: number;
  endIndex: number;
}

export function weekendSpans(series: readonly SeriesPoint[]): WeekendSpan[] {
  if (seriesGrain(series) === "monthly") return [];
  const spans: WeekendSpan[] = [];
  series.forEach((point, index) => {
    const day = new Date(`${point.t}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) return;
    const open = spans.at(-1);
    if (open && open.endIndex === index - 1 && day === 0) open.endIndex = index;
    else spans.push({ startIndex: index, endIndex: index });
  });
  return spans;
}
