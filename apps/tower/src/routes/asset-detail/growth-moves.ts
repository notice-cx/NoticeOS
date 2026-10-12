import type { AssetDetailPayload } from "@shared/asset-detail";
import type { PeriodDelta, RangeDays } from "@shared/surface";
import type { SignalTrend } from "@shared/wall";
import type { BarStripPoint } from "@/components/viz/BarStrip";
import { formatCompact, formatInt } from "@/lib/format";
import { MIN_POINTS, metricWindow, weightedMetricWindow, type Aggregate } from "@/routes/asset-detail/overview-metrics";
import { partialDays, trafficMeasure } from "@/routes/asset-detail/overview-measures";

// Every series the Growth tab reads, as one move each: the window's figure,
// its change against the window before, its recent days and the earlier level
// they are read against. Counts come from `metricWindow` and `trafficMeasure`
// and rates from `weightedMetricWindow`, the derivations the Overview and the
// charts below already state, so a number on this board is the number
// everywhere else.

export type MoveGroup = "audience" | "search";

export interface GrowthMove {
  key: string;
  group: MoveGroup;
  label: string;
  unit: string;
  value: number | null;
  absent: string;
  format: (value: number) => string;
  delta: PeriodDelta | null;
  /** The change in the good direction, in percent; null when there is none
   * to draw (no prior window, a zero prior, or not comparable). */
  improvement: number | null;
  /** The recent days, oldest first, at most 28, in the strip's own units: a
   * rate in percent, because a bar strip's floor is one. */
  days: BarStripPoint[];
  /** How the strip prints a day and the baseline, in those units. */
  stripFormat: (value: number) => string;
  provisionalFrom: string | null;
  partial: string[];
  /** The earlier window's level, a day at a time. */
  baseline: number | null;
  /** The bars' identity ink. */
  tone: string;
}

interface CountSpec {
  key: string;
  group: MoveGroup;
  label: string;
  unit: string;
  kind: Aggregate;
  sources: { name: string; trend: SignalTrend }[];
  format: (value: number) => string;
}

interface RateSpec {
  key: string;
  group: MoveGroup;
  label: string;
  unit: string;
  /** The stored daily rate: fewer than three days of it is no trend. */
  trend: SignalTrend;
  values: SignalTrend;
  weights: SignalTrend;
  kind: "ratio" | "weighted-mean";
  format: (value: number) => string;
  lowerIsBetter?: boolean;
}

/** The newest days a row draws; past it a bar is a hairline. */
const ROW_DAYS = 28;

const reported = (trend: SignalTrend) => trend.series.length > 0;
/** Fewer than three reported days is no trend: the row is left out rather
 * than drawn as a dash pretending to a series. */
const enough = (trend: SignalTrend) => trend.series.length >= MIN_POINTS;

function improvementOf(delta: PeriodDelta | null, lowerIsBetter = false): number | null {
  if (delta === null || !delta.comparable || delta.percent === null) return null;
  return lowerIsBetter ? -delta.percent : delta.percent;
}

/** A count: its figure and change from `metricWindow`, its days and the
 * earlier window's daily level from `trafficMeasure`, which reads the same
 * window. */
function countMove(spec: CountSpec, days: RangeDays): GrowthMove | null {
  const sources = spec.sources.filter((source) => reported(source.trend));
  if (!sources.some((source) => enough(source.trend))) return null;
  const window = metricWindow(sources.map((source) => source.trend), days, spec.kind);
  const measure = trafficMeasure({ key: "people", name: spec.label, unit: spec.unit, kind: spec.kind, sources, days });
  return {
    key: spec.key,
    group: spec.group,
    label: spec.label,
    unit: spec.unit,
    value: window.value,
    absent: measure.absent,
    format: spec.format,
    stripFormat: spec.format,
    delta: window.delta,
    improvement: improvementOf(window.delta),
    days: measure.history,
    provisionalFrom: measure.provisionalFrom,
    partial: partialDays(measure),
    baseline: window.delta ? (measure.usual?.value ?? null) : null,
    tone: "text-traffic",
  };
}

/** A rate: a ratio or an impression-weighted mean, never the mean of daily
 * rates, from `weightedMetricWindow`. Its prior level is the same weighted
 * figure over the earlier window. */
function rateMove(spec: RateSpec, days: RangeDays): GrowthMove | null {
  if (!enough(spec.trend)) return null;
  const window = weightedMetricWindow(spec.values, spec.weights, days, spec.kind);
  // A ratio's days are fractions of one; drawn in percent they have height.
  const unit = spec.kind === "ratio" ? 100 : 1;
  return {
    key: spec.key,
    group: spec.group,
    label: spec.label,
    unit: spec.unit,
    value: window.value,
    absent: "too few days yet",
    format: spec.format,
    stripFormat: (value) => spec.format(value / unit),
    delta: window.delta,
    improvement: improvementOf(window.delta, spec.lowerIsBetter),
    days: window.spark.slice(-ROW_DAYS).map((point) => ({ t: point.t, v: point.v * unit })),
    provisionalFrom: null,
    partial: [],
    baseline: window.delta ? window.delta.priorTotal * unit : null,
    tone: "text-foreground",
  };
}

/**
 * The board's rows, audience first. Impressions keep the compact format the
 * chart below prints, so "10K" is one number on both.
 */
export function growthMoves(performance: AssetDetailPayload["performance"], days: RangeDays): GrowthMove[] {
  const { google: clicksGoogle, bing: clicksBing } = performance.webSearchClicks;
  const { google: viewsGoogle, bing: viewsBing } = performance.webSearchImpressions;
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const moves = [
    countMove({ key: "active-users", group: "audience", label: "Active users", unit: "a day", kind: "mean", sources: [{ name: "GA4", trend: performance.activeUsers }], format: formatInt }, days),
    countMove({ key: "sessions", group: "audience", label: "Sessions", unit: "visits", kind: "sum", sources: [{ name: "GA4", trend: performance.sessions }], format: formatInt }, days),
    countMove({ key: "page-views", group: "audience", label: "Page views", unit: "pages opened", kind: "sum", sources: [{ name: "GA4", trend: performance.pageViews }], format: formatInt }, days),
    countMove({ key: "events", group: "audience", label: "Events", unit: "tracked actions", kind: "sum", sources: [{ name: "GA4", trend: performance.events }], format: formatInt }, days),
    countMove({ key: "clicks", group: "search", label: "Clicks", unit: "from search", kind: "sum", sources: [{ name: "Google", trend: clicksGoogle }, { name: "Bing", trend: clicksBing }], format: formatInt }, days),
    countMove({ key: "impressions", group: "search", label: "Impressions", unit: "appearances", kind: "sum", sources: [{ name: "Google", trend: viewsGoogle }, { name: "Bing", trend: viewsBing }], format: formatCompact }, days),
    rateMove({ key: "search-ctr", group: "search", label: "Click rate", unit: "clicks ÷ impressions", trend: performance.searchCtr, values: clicksGoogle, weights: viewsGoogle, kind: "ratio", format: percent }, days),
    rateMove({ key: "search-position", group: "search", label: "Average position", unit: "weighted by impressions", trend: performance.searchPosition, values: performance.searchPosition, weights: viewsGoogle, kind: "weighted-mean", format: (value) => value.toFixed(1), lowerIsBetter: true }, days),
  ];
  return moves.filter((move): move is GrowthMove => move !== null);
}
