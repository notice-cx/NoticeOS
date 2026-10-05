import {
  windowSpansTimeZoneChange,
  type SeriesPoint,
  type TimeZoneChangePoint,
} from "@shared/wall";

const DAY_MS = 86_400_000;

/** Below this many daily reports there is no defensible trend (bead
 * `ro-pbzu.3`): Home's assets table draws no trend chip from fewer. */
export const MIN_TREND_POINTS = 3;

/**
 * A rolling average that refuses to bridge missing calendar days. Charts use it
 * as a visual guide, never as a replacement for the observed daily values.
 * Provisional dates can be excluded so a partial today does not fake a decline.
 */
export function rollingDailyAverage(
  series: SeriesPoint[],
  windowDays = 7,
  provisionalFrom: string | null = null,
): SeriesPoint[] {
  if (windowDays < 1) return [];
  const complete =
    provisionalFrom === null
      ? series
      : series.filter((point) => point.t < provisionalFrom);
  const result: SeriesPoint[] = [];

  for (let end = windowDays - 1; end < complete.length; end += 1) {
    const window = complete.slice(end - windowDays + 1, end + 1);
    if (!isConsecutiveDailyWindow(window)) continue;
    result.push({
      t: window.at(-1)!.t,
      v: window.reduce((sum, point) => sum + point.v, 0) / window.length,
    });
  }

  return result;
}

/**
 * The calendar window a `rollingWeeklyChange` over these points really covers:
 * the latest complete rolling day back through the thirteen days before it —
 * seven days averaged against the seven before them.
 *
 * It exists so a surface can ASK whether that window is clean (a
 * reporting-timezone change inside it means the two sides are not the same
 * measurement, bead `ro-kukv.13`) without re-deriving the arithmetic beside
 * every chip and drifting from it. `null` exactly when `rollingWeeklyChange`
 * returns `null`: there is no comparison, so there is nothing to qualify.
 */
export function rollingWeeklyWindow(
  points: SeriesPoint[],
): { start: string; end: string } | null {
  const latest = points.at(-1);
  if (!latest) return null;
  const priorDate = shiftDate(latest.t, -7);
  if (!points.some((point) => point.t === priorDate)) return null;
  return { start: shiftDate(latest.t, -13), end: latest.t };
}

/** Change between the latest complete rolling average and the one a week ago. */
export function rollingWeeklyChange(points: SeriesPoint[]): number | null {
  const latest = points.at(-1);
  if (!latest) return null;
  const priorDate = shiftDate(latest.t, -7);
  const prior = points.find((point) => point.t === priorDate);
  if (!prior) return null;
  if (prior.v === 0) return latest.v === 0 ? 0 : 100;
  return ((latest.v - prior.v) / prior.v) * 100;
}

/** Everything a week-on-week chip needs to ask about its own comparison: the
 * points it averages, the tail it must not average, and the changes its OWN
 * provider filed. Structural rather than `SignalTrend` so a caller holding a
 * narrower shape (a Wall card's series, a fixture) can still ask. */
export interface WeeklyComparisonTrend {
  series: SeriesPoint[];
  contextSeries?: SeriesPoint[];
  provisionalFrom: string | null;
  timeZoneChanges: TimeZoneChangePoint[];
}

/**
 * THE predicate for "this week-on-week comparison straddles a reporting-timezone
 * change" (bead `ro-jkp2`).
 *
 * Every aggregate 7-vs-7 chip in the product asks it — the Wall/Home asset
 * card's signal panel, the asset page's three headline charts, its five
 * supporting tiles — and doc 14 gives them all one answer: the color verdict is
 * withdrawn, the percentage stays, the ⚠ appears. It lives here, next to the
 * arithmetic it qualifies, so no surface can retype the window and drift from
 * the comparison it is speaking about. The Wall card did exactly that until this
 * bead: it built the fourteen days from `series.at(-1)`, the RAW latest point,
 * so on a card whose newest day is still filling it marked a window one day
 * wider than the one the percentage came from.
 *
 * `null` means there is nothing to qualify — no comparison at all, or fourteen
 * days entirely on one side of every change this series' provider filed. A
 * reporting timezone is a setting on ONE provider's property, so each series
 * asks about its own changes and a GA4 move is no evidence about a Search
 * Console day.
 */
export function spannedTimeZoneChange<T extends WeeklyComparisonTrend>(
  trend: T,
): { trend: T; window: { start: string; end: string } } | null {
  const window = rollingWeeklyWindow(
    rollingDailyAverage(
      [...(trend.contextSeries ?? []), ...trend.series],
      7,
      trend.provisionalFrom,
    ),
  );
  if (window === null) return null;
  return windowSpansTimeZoneChange(trend.timeZoneChanges, window)
    ? { trend, window }
    : null;
}

/** Split a daily series anywhere the calendar has a gap. */
export function splitDailySeries(series: SeriesPoint[]): SeriesPoint[][] {
  const segments: SeriesPoint[][] = [];
  for (const point of series) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (
      !current ||
      !previous ||
      parseDate(point.t) === null ||
      parseDate(previous.t) === null ||
      parseDate(point.t)! - parseDate(previous.t)! !== DAY_MS
    ) {
      segments.push([point]);
    } else {
      current.push(point);
    }
  }
  return segments;
}

function isConsecutiveDailyWindow(points: SeriesPoint[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const previous = parseDate(points[index - 1]!.t);
    const current = parseDate(points[index]!.t);
    if (previous === null || current === null || current - previous !== DAY_MS) {
      return false;
    }
  }
  return points.length > 0;
}

/** A calendar date `days` later (earlier when negative), "YYYY-MM-DD". */
export function shiftDate(value: string, days: number): string {
  const time = parseDate(value);
  return time === null
    ? value
    : new Date(time + days * DAY_MS).toISOString().slice(0, 10);
}

function parseDate(value: string): number | null {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) ? time : null;
}
