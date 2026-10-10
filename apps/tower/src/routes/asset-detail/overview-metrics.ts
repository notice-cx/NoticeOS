import { moneyCurrency } from '@noticeos/contract/money';
import type {
  AssetDetailPayload,
  FlagRecord,
  LedgerRollup,
  LedgerSlice,
} from "@shared/asset-detail";
import {
  averageSeries,
  periodDelta,
  shiftLabel,
  windowSeries,
  type PeriodDelta,
  type SurfaceWindow,
} from "@shared/surface";
import {
  combineSeriesByDate,
  figureHasMoney,
  mergeSignalTrends,
  type SeriesPoint,
  type SignalTrend,
  type TimeZoneChangePoint,
} from "@shared/wall";
import { formatMoney } from "@/lib/format";

/**
 * WHAT THE OVERVIEW'S SIX NUMBERS ARE MADE OF (doc 14, bead `ro-78qo.3`).
 *
 * The arithmetic every desk surface shares — windows, rolling averages, the
 * period delta and its honesty flag — is `shared/surface.ts`. What is here is
 * only what this page's own numbers need on top of it: two providers read as
 * one measurement, a daily count of people that may not be summed, this month's
 * side of the ledger, and how long the newest alert has been running.
 */

/** Add two providers' daily series date by date. A date only one of them has
 * reported carries only that one: a provider's latency is never a zero
 * (doc 14), and the About says so where the number is read.
 *
 * The rule moved to `shared/wall.ts` for bead `ro-78qo.35`: the wall payload
 * needs the same merge for /assets' comparison table, and a worker cannot
 * import a browser module. This is the name this page has always called it. */
export const combineByDate = combineSeriesByDate;

/** The shape `periodDelta` and `HeroChart` both read, for one metric that may be
 * made of more than one provider's series. */
export interface MergedTrend {
  series: SeriesPoint[];
  contextSeries: SeriesPoint[];
  provisionalFrom: string | null;
  timeZoneChanges: TimeZoneChangePoint[];
}

/**
 * Two providers as one measurement: the strip states clicks, not Google's
 * clicks.
 *
 * A day EITHER of them is still filling is provisional for the pair, which is
 * the conservative side of the rule — the alternative compares a settled Bing
 * day against a Google day still being counted and calls the pair complete.
 */
export function mergeTrends(trends: readonly SignalTrend[]): MergedTrend {
  const merged = mergeSignalTrends(trends);
  return {
    series: merged.series,
    contextSeries: merged.contextSeries ?? [],
    provisionalFrom: merged.provisionalFrom,
    timeZoneChanges: merged.timeZoneChanges,
  };
}

export type Aggregate = "sum" | "mean";

/**
 * `mean` is not a stylistic choice. Sessions, clicks and impressions are events
 * and add up over a month. Active users is a daily count of DISTINCT people, and
 * a person who visits on Monday and Tuesday is one person — so a 28-day "total"
 * would be a number nobody could act on, in the same family of mistake doc 14
 * bans when it says never to sum hourly users into a daily figure.
 */
export function aggregate(points: readonly SeriesPoint[], kind: Aggregate): number {
  const total = points.reduce((sum, point) => sum + point.v, 0);
  return kind === "sum" ? total : points.length === 0 ? 0 : total / points.length;
}

/** The days a provider has finished with, which is what a comparison may read. */
export function settledSeries(
  series: readonly SeriesPoint[],
  provisionalFrom: string | null,
): SeriesPoint[] {
  return provisionalFrom === null
    ? [...series]
    : series.filter((point) => point.t < provisionalFrom);
}

/**
 * The trailing average across the visible window, drawn with the days BEFORE it
 * so the first point of a 7-day range is already an average rather than a stub
 * (doc 14's pre-roll rule: average the whole series, then window).
 */
export function averageOverRange(
  trend: MergedTrend,
  days: number,
  window = 7,
): SeriesPoint[] {
  const settled = settledSeries(
    [...trend.contextSeries, ...trend.series],
    trend.provisionalFrom,
  );
  return windowSeries(averageSeries(settled, window), days);
}

/** doc 14: fewer than three complete days in the window is a dash and no
 * sparkline — three points is the least a direction can be read from. */
export const MIN_POINTS = 3;

/**
 * ONE METRIC OVER ONE WINDOW — and the ONE derivation the asset page has for it
 * (bead `ro-78qo.4`).
 *
 * The Overview's KPI strip and the Growth tab's chart pairs state the same four
 * measures about the same asset over the same range, and until this existed they
 * built them separately: Growth read Google alone where the strip read Google
 * and Bing as one measurement, so one asset page printed 16,905 search clicks in
 * one place and 25,452 in another. Both numbers were arithmetically fine and one
 * of them was a lie, which is exactly the failure doc 14's "one representation
 * per fact" is about.
 *
 * So the merge, the settled window, the aggregate, the delta and the
 * three-point floor all live here, and both surfaces render what this returns.
 * A page cannot disagree with itself about a number it does not compute twice.
 */
export interface MetricWindow {
  /** Every provider's series added date by date. */
  merged: MergedTrend;
  /** The window's own complete days — what the figure and the floor are read
   * from. */
  settled: SeriesPoint[];
  /** Calendar dates used by the headline and comparison, including missing
   * report dates. Null when there is no completed observation to anchor them. */
  completedWindow: SurfaceWindow | null;
  /** Calendar dates plotted around the newest raw observation. These can be
   * later than the headline window when the provider is still counting. */
  reportedWindow: SurfaceWindow | null;
  /** `false` when the window holds fewer than three complete days: the figure
   * is a dash and nothing draws a series. */
  enough: boolean;
  /** The figure itself, unformatted. `null` when there is not enough to state
   * one. */
  value: number | null;
  delta: ReturnType<typeof periodDelta>;
  /** The trailing average across the window, for a sparkline. */
  spark: SeriesPoint[];
}

export function metricWindow(
  trends: readonly SignalTrend[],
  days: number,
  kind: Aggregate,
): MetricWindow {
  const merged = mergeTrends(trends);
  const settled = windowSeries(
    settledSeries(merged.series, merged.provisionalFrom),
    days,
  );
  const enough = settled.length >= MIN_POINTS;
  const comparison = periodDelta(
    merged.series,
    days,
    merged.timeZoneChanges,
    merged.provisionalFrom,
  );
  const completedEnd = settled.at(-1)?.t;
  const reportedEnd = merged.series.at(-1)?.t;
  return {
    merged,
    settled,
    completedWindow: completedEnd === undefined ? null : {
      start: shiftLabel(completedEnd, -(days - 1)), end: completedEnd,
    },
    reportedWindow: reportedEnd === undefined || days < 1 ? null : {
      start: shiftLabel(reportedEnd, -(days - 1)), end: reportedEnd,
    },
    enough,
    value: enough ? aggregate(settled, kind) : null,
    delta:
      comparison && kind === "mean"
        ? withComparedValues(
            comparison,
            comparison.currentTotal / comparison.currentPeriods,
            comparison.priorTotal / comparison.priorPeriods,
          )
        : comparison,
    spark: enough ? averageOverRange(merged, days) : [],
  };
}

/** Keep the shared calendar/coverage checks while comparing the actual unit
 * displayed: daily people or an impression-weighted rate, never their sums. */
function withComparedValues(
  delta: PeriodDelta,
  current: number,
  prior: number,
): PeriodDelta {
  const change = current - prior;
  return {
    ...delta,
    currentTotal: current,
    priorTotal: prior,
    change,
    percent: prior === 0 ? null : (change / prior) * 100,
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

/**
 * THE CHART THE OVERVIEW OPENS ON (bead `ro-ujb9.124`).
 *
 * The operator's own pick while it has a series to draw; otherwise the first
 * metric, in the strip's own order, that has one. A site whose first source is
 * Bing opens on its search clicks, not on an empty users chart beside them.
 * `null` when no metric has a series: there is no chart to open on.
 */
export function leadMetric<K extends string>(
  metrics: readonly { key: K; selectable: boolean }[],
  picked: K | null = null,
): K | null {
  const drawable = metrics.filter((one) => one.selectable);
  return (drawable.find((one) => one.key === picked) ?? drawable[0])?.key ?? null;
}

/** A rate needs its denominator on the same date. CTR is total clicks / total
 * impressions; position is sum(daily position × impressions) / impressions.
 * Missing pairs and zero denominators are unknown, not zero-rate days. */
export function weightedMetricWindow(
  values: SignalTrend,
  weights: SignalTrend,
  days: number,
  kind: "ratio" | "weighted-mean",
): Pick<MetricWindow, "value" | "delta" | "spark"> {
  const valueByDate = new Map(
    [...(values.contextSeries ?? []), ...values.series].map((point) => [point.t, point.v]),
  );
  const weightByDate = new Map(
    [...(weights.contextSeries ?? []), ...weights.series].map((point) => [point.t, point.v]),
  );
  const provisionalFrom =
    [values.provisionalFrom, weights.provisionalFrom]
      .filter((date): date is string => date !== null)
      .sort()[0] ?? null;
  const paired = [...valueByDate]
    .flatMap(([t, value]) => {
      const weight = weightByDate.get(t);
      if (!Number.isFinite(value) || weight === undefined || !Number.isFinite(weight) || weight <= 0) return [];
      if (provisionalFrom !== null && t >= provisionalFrom) return [];
      return [{ t, v: kind === "ratio" ? value / weight : value }];
    })
    .sort((left, right) => left.t.localeCompare(right.t));
  const average = (points: readonly SeriesPoint[]): number | null => {
    const denominator = points.reduce((sum, point) => sum + weightByDate.get(point.t)!, 0);
    if (denominator === 0) return null;
    const numerator = points.reduce((sum, point) => sum + (
      kind === "ratio"
        ? valueByDate.get(point.t)!
        : point.v * weightByDate.get(point.t)!
    ), 0);
    return numerator / denominator;
  };
  const window = windowSeries(paired, days);
  const comparison = periodDelta(paired, days, [
    ...values.timeZoneChanges,
    ...weights.timeZoneChanges,
  ]);
  const current = average(window);
  const prior = comparison
    ? average(paired.filter((point) =>
        point.t >= comparison.priorWindow.start && point.t <= comparison.priorWindow.end,
      ))
    : null;
  return {
    value: window.length >= MIN_POINTS ? current : null,
    delta: comparison && current !== null && prior !== null && window.length >= MIN_POINTS
      ? withComparedValues(comparison, current, prior)
      : null,
    spark: window.length >= MIN_POINTS ? window : [],
  };
}

// --- money -----------------------------------------------------------------
export interface LedgerMonth {
  period: string;
  net: number | null;
  currency: string | null;
  /** Which half of the honesty split this net is (docs/02). Never both. */
  booking: "booked" | "forecast";
  /** What the net is made of, at the same size as the figure. */
  composition: string;
  /** Net by month on the SAME side, chronological. Booked and forecast are
   * never joined into one line — a total mixing them is the thing the split
   * exists to prevent. */
  series: SeriesPoint[];
}

/**
 * THIS MONTH'S NET, and which of the two books it came out of.
 *
 * `booked` when anything has reconciled, else `forecast`. Never the sum, and
 * never a forecast quoted as though it had settled — the KPI prints the word
 * beside the figure.
 */
export function ledgerMonth(ledger: LedgerSlice): LedgerMonth | null {
  const current = ledger.periods[0];
  if (!current) return null;
  const booking: "booked" | "forecast" = figureHasMoney(current.booked.figure)
    ? "booked"
    : "forecast";
  const rollup = booking === "booked" ? current.booked : current.forecast;
  if (!figureHasMoney(rollup.figure)) return null;
  return {
    period: current.period,
    net: rollup.figure.net,
    currency: rollup.figure.currency,
    booking,
    composition: composition(rollup),
    series: moneyCurrency(ledger.periods.map(period => booking === 'booked' ? period.booked.figure : period.forecast.figure)) === null ? [] : [...ledger.periods].reverse().flatMap((period) => {
      const side = booking === "booked" ? period.booked : period.forecast;
      return side.figure.currency !== null && figureHasMoney(side.figure)
        ? [{ t: period.period, v: side.figure.net }]
        : [];
    }),
  };
}

function composition(rollup: LedgerRollup): string {
  const revenue = rollup.revenueByFamily
    .slice(0, 2)
    .map((entry) => `${entry.family} ${formatMoney(entry.amount, entry.currency, { cents: true })}`);
  const costs = rollup.figure.cost;
  return [...revenue, costs !== null && costs > 0 ? `costs ${formatMoney(costs, rollup.figure.currency, { cents: true })}` : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

// --- alerts ----------------------------------------------------------------
export interface AlertPosture {
  open: number;
  error: number;
  warn: number;
  /** The newest firing this asset has on record, open, parked or settled — what "last
   * one 4d ago" is measured from. */
  latestFiredAt: string | null;
}

export function alertPosture(flags: AssetDetailPayload["flags"]): AlertPosture {
  const every: FlagRecord[] = [...flags.open, ...flags.notCurrent, ...flags.snoozed, ...flags.history];
  const latest = every
    .map((flag) => flag.firedAt)
    .sort()
    .at(-1);
  return {
    open: flags.open.length,
    error: flags.open.filter((flag) => flag.severity === "error").length,
    warn: flags.open.filter((flag) => flag.severity === "warn").length,
    latestFiredAt: latest ?? null,
  };
}
