import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { FlagRecord, ProductDay, PulseMetric } from "@shared/asset-detail";
import { humanizeMetric, translateAlert } from "@shared/alert-language";
import { MEDIAVINE_REPORTING_CLOCK, revenueCalendarDate, siteRevenueWindow } from "@shared/daily-revenue";
import { productReportSummary } from "@shared/product-reports";
import { shiftLabel, type RangeDays } from "@shared/surface";
import type { SeriesPoint, SignalTrend } from "@shared/wall";
import type { BarStripPoint } from "@/components/viz/BarStrip";
import type { HealthColumn, HealthRow, HealthState } from "@/components/viz/HealthGrid";
import type { StatComparison } from "@/components/viz/StatTile";
import { formatCompact, formatInt, formatPeriodMonthLong, formatSeriesDate, formatSignedMoney, formatUsd } from "@/lib/format";
import { ledgerMonth, metricWindow, type Aggregate } from "@/routes/asset-detail/overview-metrics";

/**
 * The Overview's hero row read once from the site's own read: money, people,
 * search and the site's product figure, each over the page's range with its
 * yardstick, the days nobody reported and the alert it is about; and each
 * data source's last thirty days. A day nobody reported stays null, and a
 * source this read holds no daily record for says so rather than drawing one.
 */

export type MeasureKey = "money" | "people" | "search" | "product";

export interface MeasureDay {
  t: string;
  /** null: nothing reported that day. */
  v: number | null;
  /** Sources that owed this day and did not report it. With a value, the day
   * is partial; without one, it is missing. Empty and null: nothing was owed. */
  missing: readonly string[];
}

export interface MeasureGap {
  start: string;
  end: string;
  days: number;
  /** Who was silent, when the measure has more than one source. */
  who: string | null;
  /** Another source still reported: the bars are partial, not missing. */
  partial: boolean;
}

export interface MeasureAlert {
  flagId: number;
  severity: "error" | "warn";
  /** Where the condition begins on the chart: its onset, or the chart's first
   * day when it began before the range. */
  since: string;
  /** The day the condition began. */
  onset: string;
  firstFiredAt: string;
  headline: string;
}

export interface Measure {
  key: MeasureKey;
  /** What the figure is: "Visitors a day". */
  name: string;
  /** Over which window: "28 days", "September", "latest report". */
  window: string;
  value: number | null;
  /** Why there is no figure, in the operator's words. */
  absent: string;
  format: (value: number) => string;
  /** The same figure, short enough for an axis. */
  axis: (value: number) => string;
  estimated: boolean;
  comparison: StatComparison | null;
  /** The chart's days, oldest first; empty when the measure has no daily series. */
  days: MeasureDay[];
  /** The figure's recent history at stat scale. */
  history: BarStripPoint[];
  provisionalFrom: string | null;
  /** The level the chart is read against, with its name. */
  usual: { value: number; label: string } | null;
  /** The alert rule's own normal range, when one is about this measure. */
  normal: { low: number; high: number } | null;
  alert: MeasureAlert | null;
  gaps: MeasureGap[];
  /** The sources drawn, named as a chart key names them. */
  sources: string[];
  /** What one unit is called in a readout: "visitors". */
  unit: string;
  /** How many of the window's days reported, when fewer than all of them did. */
  reported: { days: number; of: number } | null;
  /** The nightly-report metric a product figure states. */
  metric: string | null;
  /** The newest day the figure is from, when its source is late. */
  asOf: string | null;
}

/** The longest stretch a stat's history draws: past it, bars turn to hairlines. */
const HISTORY_DAYS = 28;

const count = (value: number) => (value >= 100_000 ? formatCompact(value) : formatInt(value));
const money = (value: number) => formatUsd(value, { cents: Math.abs(value) < 100 });
const axisMoney = (value: number) => (value >= 1000 ? `$${formatCompact(value)}` : formatUsd(value));

/** "Sep 6–8", "Aug 30–Sep 2", "Sep 6". */
export function dateRange(start: string, end: string): string {
  if (start === end) return formatSeriesDate(start);
  return start.slice(0, 7) === end.slice(0, 7)
    ? `${formatSeriesDate(start)}–${Number(end.slice(8))}`
    : `${formatSeriesDate(start)}–${formatSeriesDate(end)}`;
}

/** Every calendar day from `end - length + 1` to `end`. */
export function calendarDays(end: string, length: number, start?: string): string[] {
  const first = shiftLabel(end, -(length - 1));
  const from = start && start > first ? start : first;
  const out: string[] = [];
  for (let day = from; day <= end; day = shiftLabel(day, 1)) out.push(day);
  return out;
}

interface Source {
  name: string;
  points: readonly SeriesPoint[];
  /** The last day this source owes; its own newest day unless it is late. */
  owedThrough?: string;
}

/** A source owes every day from its first report to its newest (or to the day
 * it is late for); a day it skipped inside that stretch is a gap. A day before
 * its first report is owed by nobody. */
export function measureDays(domain: readonly string[], sources: readonly Source[]): { days: MeasureDay[]; gaps: MeasureGap[] } {
  const reads = sources
    .filter((source) => source.points.length > 0 || source.owedThrough)
    .map((source) => {
      const byDate = new Map(source.points.map((point) => [point.t, point.v]));
      const dates = source.points.map((point) => point.t).sort();
      const first = dates[0] ?? source.owedThrough!;
      const last = source.owedThrough && (dates.at(-1) ?? "") < source.owedThrough ? source.owedThrough : dates.at(-1)!;
      return { name: source.name, byDate, first, last };
    });
  const days = domain.map((t): MeasureDay => {
    let total: number | null = null;
    const missing: string[] = [];
    for (const read of reads) {
      const value = read.byDate.get(t);
      if (value !== undefined) total = (total ?? 0) + value;
      else if (t >= read.first && t <= read.last) missing.push(read.name);
    }
    return { t, v: total, missing };
  });
  const several = reads.length > 1;
  const gaps: MeasureGap[] = [];
  for (const day of days) {
    if (day.missing.length === 0) continue;
    const who = several ? day.missing.join(" and ") : null;
    const partial = day.v !== null;
    const open = gaps.at(-1);
    if (open && open.end === shiftLabel(day.t, -1) && open.who === who && open.partial === partial) {
      open.end = day.t;
      open.days += 1;
    } else {
      gaps.push({ start: day.t, end: day.t, days: 1, who, partial });
    }
  }
  return { days, gaps };
}

/** The last `HISTORY_DAYS` of a measure's days, at stat scale. */
function historyOf(days: readonly MeasureDay[]): BarStripPoint[] {
  return days.slice(-HISTORY_DAYS).map((day) => ({ t: day.t, v: day.v }));
}

/** The days a measure's figure has only some of its sources for. */
export function partialDays(measure: Pick<Measure, "days">): string[] {
  return measure.days.filter((day) => day.v !== null && day.missing.length > 0).map((day) => day.t);
}

const hasPoints = (trend: SignalTrend) => trend.series.length > 0;

interface TrafficInput {
  key: "people" | "search";
  name: string;
  unit: string;
  kind: Aggregate;
  sources: { name: string; trend: SignalTrend }[];
  days: RangeDays;
}

/** People or search over the range, from `metricWindow`, the one derivation
 * the page has for a metric over a window. The usual level is the window
 * before it, a day at a time, so the chart's dashed line is the same
 * comparison the figure's change is made against. */
function trafficMeasure({ key, name, unit, kind, sources, days }: TrafficInput): Measure {
  const window = metricWindow(sources.map((one) => one.trend), days, kind);
  const end = window.merged.series.at(-1)!.t;
  const { days: drawn, gaps } = measureDays(
    calendarDays(end, days),
    sources.map((one) => ({ name: one.name, points: [...(one.trend.contextSeries ?? []), ...one.trend.series] })),
  );
  const delta = window.delta;
  const priorPerDay = delta ? (kind === "mean" ? delta.priorTotal : delta.priorTotal / delta.priorPeriods) : null;
  const ownPerDay = window.settled.length > 0 ? window.settled.reduce((sum, point) => sum + point.v, 0) / window.settled.length : null;
  return {
    key,
    name,
    window: `${days} days`,
    value: window.value,
    absent: window.settled.length === 0 ? "not reported yet" : "too few days yet",
    format: count,
    axis: formatCompact,
    estimated: false,
    comparison: delta
      ? { percent: delta.percent, change: delta.change, against: `vs prior ${days} days`, comparable: delta.comparable }
      : null,
    days: drawn,
    history: historyOf(drawn),
    provisionalFrom: window.merged.provisionalFrom,
    usual: priorPerDay !== null
      ? { value: priorPerDay, label: `prior ${days} days · ${count(priorPerDay)} a day` }
      : ownPerDay !== null
        ? { value: ownPerDay, label: `average · ${count(ownPerDay)} a day` }
        : null,
    normal: null,
    alert: null,
    gaps,
    sources: sources.map((one) => one.name),
    unit,
    reported: window.settled.length > 0 && window.settled.length < days ? { days: window.settled.length, of: days } : null,
    metric: null,
    asOf: null,
  };
}

/** One product-analytics measure as a daily series; a day with no figure is absent. */
function productTrend(days: readonly ProductDay[], pick: (day: ProductDay) => number | null): SignalTrend {
  return {
    series: days.flatMap((day) => {
      const value = pick(day);
      return value === null ? [] : [{ t: day.date, v: value }];
    }),
    provisionalFrom: null,
    collectedAt: null,
    timeZoneChanges: [],
  };
}

function peopleMeasure(data: AssetDetailFor<"overview">, days: RangeDays): Measure | null {
  const { activeUsers } = data.performance;
  if (hasPoints(activeUsers)) {
    return trafficMeasure({ key: "people", name: "Visitors a day", unit: "visitors", kind: "mean", sources: [{ name: "GA4", trend: activeUsers }], days });
  }
  const product = data.executive?.product?.webDaily?.days ?? [];
  const people = productTrend(product, (day) => day.people);
  if (!hasPoints(people)) return null;
  return trafficMeasure({ key: "people", name: "People a day", unit: "people", kind: "mean", sources: [{ name: "PostHog", trend: people }], days });
}

function searchMeasure(data: AssetDetailFor<"overview">, days: RangeDays): Measure | null {
  const { google, bing } = data.performance.webSearchClicks;
  const sources = [
    ...(hasPoints(google) ? [{ name: "Google", trend: google }] : []),
    ...(hasPoints(bing) ? [{ name: "Bing", trend: bing }] : []),
  ];
  if (sources.length === 0) return null;
  return trafficMeasure({ key: "search", name: "Search clicks", unit: "clicks", kind: "sum", sources, days });
}

/** Ad revenue over the range, ending yesterday on the network's own clock (the
 * Money tab's window), against the same number of days before it. Estimates,
 * and they say so. With no daily revenue, the accounting month stands in. */
function moneyMeasure(data: AssetDetailFor<"overview">, days: RangeDays, nowMs: number): Measure | null {
  const history = data.dailyRevenue;
  if (history && history.days.length > 0) {
    const window = siteRevenueWindow(history, nowMs, MEDIAVINE_REPORTING_CLOCK.timeZone, days);
    const points = history.days.map((day) => ({ t: day.date, v: day.amountMinor / 100 }));
    const { days: drawn, gaps } = measureDays(calendarDays(window.to, days), [{ name: "Ad revenue", points }]);
    const inWindow = points.filter((point) => point.t >= window.from && point.t <= window.to);
    const priorFrom = shiftLabel(window.from, -days);
    const prior = points.filter((point) => point.t >= priorFrom && point.t < window.from);
    const total = (list: readonly SeriesPoint[]) => list.reduce((sum, point) => sum + point.v, 0);
    const value = inWindow.length > 0 ? total(inWindow) : null;
    const reachable = priorFrom >= history.from && prior.length > 0;
    const priorTotal = total(prior);
    return {
      key: "money",
      name: "Ad revenue",
      window: `${days} days`,
      value,
      absent: "not reported yet",
      format: money,
      axis: axisMoney,
      estimated: true,
      comparison: value !== null && reachable
        ? {
            percent: priorTotal === 0 ? null : ((value - priorTotal) / priorTotal) * 100,
            change: value - priorTotal,
            against: `vs prior ${days} days`,
            comparable: prior.length === inWindow.length,
          }
        : null,
      days: drawn,
      history: historyOf(drawn),
      provisionalFrom: null,
      usual: reachable
        ? { value: priorTotal / prior.length, label: `prior ${days} days · ${money(priorTotal / prior.length)} a day` }
        : inWindow.length > 0
          ? { value: total(inWindow) / inWindow.length, label: `average · ${money(total(inWindow) / inWindow.length)} a day` }
          : null,
      normal: null,
      alert: null,
      gaps,
      sources: ["Ad revenue"],
      unit: "",
      reported: inWindow.length > 0 && inWindow.length < days ? { days: inWindow.length, of: days } : null,
      metric: null,
      asOf: null,
    };
  }
  const month = ledgerMonth(data.ledger);
  if (!month) return null;
  // The accounting month is stated to the cent, in its own currency, signed.
  const net = (value: number) => formatSignedMoney(value, month.currency, { cents: true });
  return {
    key: "money",
    name: "Net",
    window: formatPeriodMonthLong(month.period),
    value: month.net,
    absent: "no money recorded",
    format: net,
    axis: net,
    estimated: month.booking === "forecast",
    comparison: null,
    days: [],
    history: month.series.length >= 2 ? month.series.map((point) => ({ t: point.t, v: point.v })) : [],
    provisionalFrom: null,
    usual: null,
    normal: null,
    alert: null,
    gaps: [],
    sources: [],
    unit: "",
    reported: null,
    metric: null,
    asOf: null,
  };
}

/** The metric a flow rule fired on, as the nightly report names it. */
function flagMetric(flag: FlagRecord): string | null {
  const named = flag.ruleInputs?.metric;
  return typeof named === "string" ? named : flag.metric;
}

const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Problems first, the most severe and then the newest leading. */
export function rankedFlags(flags: readonly FlagRecord[]): FlagRecord[] {
  return flags
    .filter((flag) => flag.severity === "error" || flag.severity === "warn")
    .sort((a, b) => (a.severity === b.severity ? b.firstFiredAt.localeCompare(a.firstFiredAt) : a.severity === "error" ? -1 : 1));
}

/** The open alert a nightly-report metric's own rule raised, if any. */
function metricAlert(flags: readonly FlagRecord[], metrics: readonly PulseMetric[]): { flag: FlagRecord; metric: PulseMetric } | null {
  for (const flag of rankedFlags(flags)) {
    if (!flag.ruleId.startsWith("flow-")) continue;
    const metric = metrics.find((one) => one.name === flagMetric(flag));
    if (metric) return { flag, metric };
  }
  return null;
}

/** The smallest count whose Poisson(λ) cumulative chance reaches `p`. */
export function poissonQuantile(lambda: number, p: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 400) return Math.max(0, Math.round(lambda + normalQuantile(p) * Math.sqrt(lambda)));
  let term = Math.exp(-lambda);
  let total = term;
  let k = 0;
  while (total < p && k < lambda * 4 + 50) {
    k += 1;
    term *= lambda / k;
    total += term;
  }
  return k;
}

/** The standard normal quantile (Acklam's rational approximation). */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** The alert rule's own normal for one day: the counts its baseline makes
 * likely at the rule's own sensitivity. Only the single-day rule has one; a
 * pooled window or a percentage tripwire states no daily range. */
function ruleNormal(flag: FlagRecord, fallbackAlpha: number): { low: number; high: number } | null {
  if (flag.ruleId !== "flow-poisson-low") return null;
  const lambda = number(flag.ruleInputs?.baselinePerDay) ?? number(flag.ruleInputs?.lambda);
  const alpha = number(flag.ruleInputs?.alpha) ?? fallbackAlpha;
  if (lambda === null || !(alpha > 0 && alpha < 0.5)) return null;
  return { low: poissonQuantile(lambda, alpha), high: poissonQuantile(lambda, 1 - alpha) };
}

/** The rule's sensitivity as the site's settings hold it. */
function settingsAlpha(data: AssetDetailFor<"overview">): number {
  const knob = data.rules.knobs.find((one) => one.key === "alpha");
  return number(knob?.raw) ?? 0.01;
}

const sentence = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * The site's one product figure: the nightly-report metric an open alert is
 * about, else the report's first metric. The figure is the latest report's
 * 24 hours against the reports before it (`productReportSummary`, the
 * comparison every product cell makes); under an alert the chart is read
 * against the rule's own normal instead. A report that is late owes the days
 * since its last one, so they draw as missing rather than as the end.
 */
function productMeasure(data: AssetDetailFor<"overview">, days: RangeDays, nowMs: number, reportLate: boolean): Measure | null {
  const metrics = data.metrics.filter((metric) => metric.series.length > 0);
  if (metrics.length === 0) return null;
  const alerted = metricAlert(data.flags.open, metrics);
  const metric = alerted?.metric ?? metrics[0]!;
  const summary = productReportSummary(metric, data.wiring.lastPulseDate);
  const today = revenueCalendarDate(new Date(nowMs), data.osTimeZone);
  const points = metric.series.filter((point) => Number.isFinite(point.v));
  const newest = points.at(-1)!.t;
  // A late report owes the days since its last one, drawn as missing; once
  // the whole range is owed, the chart draws the last reports there were
  // instead of a range of nothing, and the figure says how old it is.
  const owing = reportLate && today > newest && shiftLabel(today, -(days - 1)) <= newest;
  const end = owing ? today : newest;
  const { days: drawn, gaps } = measureDays(
    calendarDays(end, days, points[0]!.t),
    [{ name: "Nightly report", points, owedThrough: end }],
  );
  const value = metric.last24h;
  const prior = summary.previousMean;
  const flag = alerted?.flag ?? null;
  const baseline = flag ? number(flag.ruleInputs?.baselinePerDay) : null;
  const unit = humanizeMetric(metric.name);
  // The onset on the chart's own axis: an older condition starts at its left
  // edge, and one dated after the newest report sits on that report.
  const onset = flag ? flag.firstFiredAt.slice(0, 10) : null;
  const since = onset === null ? null : onset < drawn[0]!.t ? drawn[0]!.t : onset > end ? end : onset;
  return {
    key: "product",
    name: sentence(unit),
    window: "latest report",
    value,
    absent: "not in the latest report",
    format: count,
    axis: formatCompact,
    estimated: false,
    comparison: value !== null && prior !== null
      ? {
          percent: prior === 0 ? null : ((value - prior) / prior) * 100,
          change: value - prior,
          against: `vs prior ${summary.previousCount} ${summary.previousCount === 1 ? "report" : "reports"}`,
        }
      : null,
    days: drawn,
    history: historyOf(drawn),
    provisionalFrom: null,
    usual: baseline !== null
      ? { value: baseline, label: `normally ~${count(Math.round(baseline))} a day` }
      : prior !== null
        ? { value: prior, label: `prior ${summary.previousCount} reports · ${count(Math.round(prior))} a day` }
        : null,
    normal: flag ? ruleNormal(flag, settingsAlpha(data)) : null,
    alert: flag && since && onset
      ? {
          flagId: flag.id,
          severity: flag.severity === "error" ? "error" : "warn",
          since,
          onset,
          firstFiredAt: flag.firstFiredAt,
          headline: translateAlert(flag).headline,
        }
      : null,
    gaps,
    sources: ["Nightly report"],
    unit,
    reported: null,
    metric: metric.name,
    asOf: reportLate && today > newest ? newest : null,
  };
}

/** The hero row, money first, then people, search and the product figure;
 * a measure the site has no number for is left out. */
export function overviewMeasures(
  data: AssetDetailFor<"overview">,
  days: RangeDays,
  nowMs: number,
  reportLate = false,
): Measure[] {
  return [
    moneyMeasure(data, days, nowMs),
    peopleMeasure(data, days),
    searchMeasure(data, days),
    productMeasure(data, days, nowMs, reportLate),
  ].filter((measure): measure is Measure => measure !== null);
}

/** An alert this old no longer takes the chart by default. */
const FRESH_ALERT_MS = 7 * 86_400_000;

/** Which measure the chart opens on: the operator's own pick while it has
 * days to draw; otherwise the one a fresh alert is about, else the first with
 * days. A week-old alert keeps its mark on its figure and stops leading. */
export function chartedMeasure(measures: readonly Measure[], picked: MeasureKey | null, nowMs: number): Measure | null {
  const drawable = measures.filter((measure) => measure.days.length > 0);
  return drawable.find((measure) => measure.key === picked)
    ?? drawable.find((measure) => measure.alert !== null && nowMs - Date.parse(measure.alert.firstFiredAt) < FRESH_ALERT_MS)
    ?? drawable[0]
    ?? null;
}

/** The highest and lowest complete day, and the newest one. A partial,
 * missing or still-counting day is none of them. */
export function landmarks(measure: Pick<Measure, "days" | "provisionalFrom">): {
  best: MeasureDay | null;
  worst: MeasureDay | null;
  newest: MeasureDay | null;
} {
  const settled = measure.days.filter((day) =>
    day.v !== null && day.missing.length === 0 && (measure.provisionalFrom === null || day.t < measure.provisionalFrom));
  if (settled.length === 0) return { best: null, worst: null, newest: null };
  const newest = settled.at(-1)!;
  if (settled.length < 3) return { best: null, worst: null, newest };
  const best = settled.reduce((top, day) => (day.v! > top.v! ? day : top));
  const worst = settled.reduce((low, day) => (day.v! < low.v! ? day : low));
  return { best, worst: worst.v === best.v ? null : worst, newest };
}

// --- data sources, day by day -------------------------------------------------

export type SourceDayState = "reported" | "counting" | "missed" | "late" | "before";

export interface SourceDays {
  id: string;
  /** What the row prints. */
  name: string;
  /** The full name, on hover and to screen readers. */
  label: string;
  /** The source's state now, in the grid's words; null for a row read only
   * from its data. */
  state: HealthState | null;
  stateLabel: string | null;
  since: string | null;
  detail: string | null;
  /** One state per day, oldest first; null when this read holds no daily record. */
  days: { t: string; state: SourceDayState }[] | null;
  /** The newest day that reported. */
  through: string | null;
}

/** The days each source's own data in this read covers, and its unfinished tail. */
function sourceDates(data: AssetDetailFor<"overview">, id: string): { dates: Set<string>; provisionalFrom: string | null } | null {
  const of = (...trends: SignalTrend[]) => ({
    dates: new Set(trends.flatMap((trend) => trend.series.map((point) => point.t))),
    provisionalFrom: trends.find((trend) => trend.series.length > 0)?.provisionalFrom ?? null,
  });
  const { performance } = data;
  switch (id) {
    case "ga4":
      return of(performance.activeUsers, performance.sessions);
    case "gsc":
      return of(performance.webSearchClicks.google, performance.webSearchImpressions.google);
    case "bing-webmaster":
      return of(performance.webSearchClicks.bing, performance.webSearchImpressions.bing);
    case "nightly-report":
      return { dates: new Set(data.metrics.flatMap((metric) => metric.series.map((point) => point.t))), provisionalFrom: null };
    case "posthog":
      return { dates: new Set((data.executive?.product?.webDaily?.days ?? []).map((day) => day.date)), provisionalFrom: null };
    default:
      return null;
  }
}

function dayStates(dates: Set<string>, provisionalFrom: string | null, domain: readonly string[]): SourceDays["days"] {
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  return domain.map((t) => ({
    t,
    state: dates.has(t)
      ? provisionalFrom !== null && t >= provisionalFrom ? "counting" : "reported"
      : t < first ? "before" : t > last ? "late" : "missed",
  }));
}

/**
 * Each data source in use on this site, a cell per day over the last
 * `length` days: reported, still counting, missed, owed and not yet in, or
 * before the source began. The state on the right is the source's reading now,
 * from the same row Home's grid draws (`siteHealthRow`). Ad revenue has no
 * source slot of its own, so its row is read from its days alone.
 */
export function sourceHistory(
  data: AssetDetailFor<"overview">,
  row: HealthRow,
  columns: readonly HealthColumn[],
  today: string,
  length = 30,
): { rows: SourceDays[]; notConnected: string[]; domain: string[] } {
  const domain = calendarDays(today, length);
  const rows: SourceDays[] = [];
  const notConnected: string[] = [];
  for (const column of columns) {
    const cell = row.cells.find((one) => one.column === column.id);
    if (!cell || cell.state === "not-using") continue;
    if (cell.state === "not-connected") {
      notConnected.push(column.short);
      continue;
    }
    const read = sourceDates(data, column.id);
    const days = read ? dayStates(read.dates, read.provisionalFrom, domain) : null;
    rows.push({
      id: column.id,
      // The report is the one source whose short name says nothing alone.
      name: column.id === "nightly-report" ? "Nightly report" : column.short,
      label: column.label,
      state: cell.state,
      stateLabel: cell.label ?? null,
      since: cell.since ?? null,
      detail: cell.detail ?? null,
      days,
      through: read ? [...read.dates].sort().at(-1) ?? null : null,
    });
  }
  const revenue = data.dailyRevenue?.days ?? [];
  if (revenue.length > 0) {
    const dates = new Set(revenue.map((day) => day.date));
    rows.push({
      id: "ad-revenue",
      name: "Ad revenue",
      label: "Ad revenue",
      state: null,
      stateLabel: null,
      since: null,
      detail: null,
      days: dayStates(dates, null, domain),
      through: [...dates].sort().at(-1) ?? null,
    });
  }
  return { rows, notConnected, domain };
}

/** The open alerts a source's row already draws: the nightly report that
 * stopped arriving or could not be fetched. */
export function drawnBySourceRow(flag: Pick<FlagRecord, "ruleId">): boolean {
  return flag.ruleId === "ingest-freshness" || flag.ruleId === "asset-pull-failed";
}
