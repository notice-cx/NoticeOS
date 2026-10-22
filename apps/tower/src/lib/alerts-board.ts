// The open alerts read into the Alerts page's drawings: each alert's reading
// against the normal its own rule computed, the board's groups by site with
// the long-standing folded apart, and the week's timeline. Every number comes
// from the stored rule inputs; a rule that kept no normal draws none.
import { lnPoissonPmf } from "@noticeos/contract/poisson";
import type { AlertHistoryRow } from "@shared/alert-history";
import { humanizeMetric, translateAlert, type FlagReading } from "@shared/alert-language";
import type { AttentionItem } from "@shared/wall";
import type { BarStripPoint } from "@/components/viz/BarStrip";
import type { TimelineLane, TimelineSpan } from "@/components/viz/EventTimeline";
import { incidentGroup, rankIncidents } from "@/components/viz/IncidentList";
import { isGrouped } from "@/lib/attention";

const DAY_MS = 86_400_000;
/** The timeline's window and the age past which an alert folds: one week. */
export const ALERT_WEEK_MS = 7 * DAY_MS;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sentence(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function metricWords(inputs: Record<string, unknown>, metric: string | null): string {
  const name = str(inputs.metric) ?? metric;
  const words = name ? humanizeMetric(name) : "";
  return words ? sentence(words) : "This metric";
}

const limitLabel = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const percentLabel = (value: number) => `${Math.round(value)}%`;

/** A reading against its rule's normal, in NormalBand's terms, with the
 * usual level the readings strip draws as its dashed line. */
export interface AlertNormal {
  value: number;
  low?: number;
  high?: number;
  /** What is measured and over what window: "Plans saved in 24 hours". */
  label: string;
  unit?: string;
  bad: "below" | "above";
  format?: (value: number) => string;
  /** The level the rule is centred on, for the readings strip. */
  level: { value: number; label: string };
}

/**
 * The counts a Poisson(λ) puts between its two α tails. The low edge is the
 * rule's own line: `flow-*` fires when P(X ≤ observed) < α, so every count
 * from `low` up is one the rule accepts. The high edge is the same α taken
 * from the other tail of the same distribution.
 */
export function poissonNormalRange(lambda: number, alpha: number): { low: number; high: number } {
  if (!(lambda > 0) || !(alpha > 0) || alpha >= 0.5) return { low: 0, high: Math.max(0, Math.round(lambda)) };
  // Mass more than twelve deviations below λ is under e^-72, so the sum can
  // start there and stay exact to the precision α is stored at.
  const start = Math.max(0, Math.floor(lambda - 12 * Math.sqrt(lambda) - 10));
  let logCdf = Number.NEGATIVE_INFINITY;
  let low: number | null = null;
  const logLow = Math.log(alpha);
  const logHigh = Math.log1p(-alpha);
  for (let k = start; ; k += 1) {
    const term = lnPoissonPmf(k, lambda);
    const hi = Math.max(logCdf, term);
    logCdf = hi === Number.NEGATIVE_INFINITY ? hi : hi + Math.log(Math.exp(logCdf - hi) + Math.exp(term - hi));
    if (low === null && logCdf >= logLow) low = k;
    if (logCdf >= logHigh) return { low: low ?? k, high: k };
  }
}

/** A Poisson rule's reading: its count, its λ and its α, from one set of
 * stored inputs. Null when any is missing. */
function poissonReading(ruleId: string, inputs: Record<string, unknown>): { value: number; lambda: number; alpha: number; hours: number } | null {
  const alpha = num(inputs.alpha);
  const baseline = num(inputs.baselinePerDay);
  if (ruleId === "flow-poisson-low") {
    const value = num(inputs.observed);
    const lambda = num(inputs.lambda) ?? baseline;
    if (value === null || lambda === null || alpha === null) return null;
    return { value, lambda, alpha, hours: 24 };
  }
  if (ruleId === "flow-lowvol-window") {
    const value = num(inputs.windowObserved);
    const hours = num(inputs.windowHours) ?? 72;
    const lambda = num(inputs.lambda) ?? (baseline === null ? null : (baseline * hours) / 24);
    if (value === null || lambda === null || alpha === null) return null;
    return { value, lambda, alpha, hours };
  }
  return null;
}

function windowWords(hours: number): string {
  if (hours === 24) return "24h";
  return hours % 24 === 0 ? `${hours / 24} days` : `${hours}h`;
}

/**
 * The reading this alert's rule judged, against the range that rule calls
 * normal, or null when the rule kept no range: a failed fetch or a sitemap
 * check has a cause, not a normal.
 */
export function alertNormal(facts: Pick<AttentionItem, "ruleId" | "ruleInputs" | "metric">): AlertNormal | null {
  const inputs = facts.ruleInputs ?? {};
  if ("prediction" in inputs) {
    if (!inputs.prediction || typeof inputs.prediction !== "object" || Array.isArray(inputs.prediction)) return null;
    const prediction = inputs.prediction as Record<string, unknown>;
    if (prediction.model === "weekday-log-predictive-v1") {
      const value = num(inputs.windowObserved) ?? num(inputs.observed);
      const low = num(prediction.lower), high = num(prediction.upper), typical = num(prediction.typical);
      if (value === null || value < 0 || low === null || high === null || typical === null || typical < 0 || low < 0 || high < low) return null;
      const hours = num(inputs.windowHours) ?? 24;
      if (hours <= 0) return null;
      return { value, low, high, label: `${metricWords(inputs, facts.metric)} in ${windowWords(hours)}`,
        unit: `in ${windowWords(hours)}`, bad: "below", level: { value: typical, label: `trend reference ${Math.round(typical).toLocaleString("en-US")}` } };
    }
    // A future prediction model cannot be interpreted with a legacy Poisson band.
    return null;
  }
  const poisson = poissonReading(facts.ruleId, inputs);
  if (poisson) {
    const { low, high } = poissonNormalRange(poisson.lambda, poisson.alpha);
    const window = windowWords(poisson.hours);
    return {
      value: poisson.value,
      low,
      high,
      label: `${metricWords(inputs, facts.metric)} in ${poisson.hours === 24 ? "24 hours" : window}`,
      unit: `in ${window}`,
      bad: "below",
      level: { value: poisson.lambda, label: `usual ${Math.round(poisson.lambda).toLocaleString("en-US")}` },
    };
  }
  if (facts.ruleId === "flow-pct-drop") {
    const value = num(inputs.observed);
    const baseline = num(inputs.baselinePerDay);
    const fraction = num(inputs.minDropFraction);
    if (value === null || value < 0 || baseline === null || baseline <= 0 || fraction === null || fraction < 0 || fraction > 1) return null;
    const low = baseline * (1 - fraction);
    return { value, low, bad: "below", label: `${metricWords(inputs, facts.metric)} in 24 hours`, unit: "in 24h", format: limitLabel,
      level: { value: low, label: `limit ${limitLabel(low)}` } };
  }
  if (facts.ruleId === "hygiene-html-depth") {
    const value = num(inputs.words);
    const median = num(inputs.baseline_median);
    const ratio = num(inputs.threshold_ratio);
    if (value === null || value < 0 || median === null || median <= 0 || ratio === null || ratio < 0 || ratio > 1) return null;
    const low = median * ratio;
    return { value, low, bad: "below", label: "Words served in home page HTML", unit: "words", format: limitLabel,
      level: { value: low, label: `limit ${limitLabel(low)} words` } };
  }
  if (facts.ruleId === "ingest-freshness" && str(inputs.state) !== "never-reported") {
    const age = num(inputs.ageHours);
    const threshold = num(inputs.thresholdHours);
    if (age === null || threshold === null) return null;
    return {
      value: age,
      low: 0,
      high: threshold,
      label: "Hours since the last nightly report",
      unit: "hours",
      bad: "above",
      level: { value: threshold, label: `fires after ${threshold}h` },
    };
  }
  if (facts.ruleId === "ga4-quota-pressure") {
    const buckets = Array.isArray(inputs.pressured) ? inputs.pressured : [];
    const shares = buckets
      .map((bucket) => (typeof bucket === "object" && bucket !== null ? num((bucket as Record<string, unknown>).share) : null))
      .filter((share): share is number => share !== null);
    const threshold = num(inputs.threshold_ratio);
    if (shares.length === 0 || threshold === null) return null;
    return {
      value: Math.min(...shares) * 100,
      low: threshold * 100,
      high: 100,
      label: "GA4 quota left",
      unit: "left",
      bad: "below",
      format: percentLabel,
      level: { value: threshold * 100, label: `fires below ${percentLabel(threshold * 100)}` },
    };
  }
  return null;
}

/**
 * The condition's stored readings as one bar a night, oldest first, read with
 * the same rule as the row's band. A night between them with no stored
 * reading is an empty slot, so the bars stay evenly spaced in time. Null
 * under two readings: one night is the band itself.
 */
export function readingNights(facts: Pick<AttentionItem, "ruleId" | "metric"> & { readings?: readonly FlagReading[] }): BarStripPoint[] | null {
  const byDay = new Map<string, number>();
  for (const reading of facts.readings ?? []) {
    const normal = alertNormal({ ruleId: facts.ruleId, metric: facts.metric, ruleInputs: reading.ruleInputs });
    const day = reading.at.slice(0, 10);
    // Newest first: the first reading of a day is that day's last word.
    if (normal && !byDay.has(day)) byDay.set(day, normal.value);
  }
  if (byDay.size < 2) return null;
  const days = [...byDay.keys()].sort();
  const nights: BarStripPoint[] = [];
  for (let at = Date.parse(`${days[0]}T00:00:00Z`), last = Date.parse(`${days.at(-1)}T00:00:00Z`); at <= last; at += DAY_MS) {
    const t = new Date(at).toISOString().slice(0, 10);
    nights.push({ t, v: byDay.get(t) ?? null });
  }
  return nights;
}

/** The headline without its figures: "Plans saved well below normal" from
 * "Plans saved well below normal — 19 vs ~58/day". The row below says the rest. */
export function shortHeadline(headline: string): string {
  const cut = headline.indexOf(" — ");
  return cut > 0 ? headline.slice(0, cut) : headline;
}

/** One site's open alerts on the board, worst first. A row that stands for
 * several sites belongs to none of them and is grouped on its own. */
export interface BoardSite {
  key: string;
  /** null for the rows that stand for several sites. */
  asset: string | null;
  name: string;
  items: AttentionItem[];
}

export interface AlertBoard {
  sites: BoardSite[];
  /** Open for over a week, ranked, folded under their own heading. */
  longStanding: AttentionItem[];
}

const rankable = (item: AttentionItem) => ({ item, severity: item.severity === "error" ? ("error" as const) : ("warn" as const), since: item.firstFiredAt });

function ranked(items: readonly AttentionItem[]): AttentionItem[] {
  return rankIncidents(items.map(rankable)).map((entry) => entry.item);
}

export const SEVERAL_SITES = "several";

/** Sites by their worst open alert, errors first, then the newest onset; the
 * long-standing apart, so a 67-day-old fault never sits beside a fresh one. */
export function alertBoard(items: readonly AttentionItem[], nowMs: number): AlertBoard {
  const longStanding: AttentionItem[] = [];
  const bySite = new Map<string, BoardSite>();
  for (const item of items) {
    if (incidentGroup({ since: item.firstFiredAt }, nowMs, null) === "long-standing") {
      longStanding.push(item);
      continue;
    }
    const key = isGrouped(item) ? SEVERAL_SITES : item.asset;
    let site = bySite.get(key);
    if (!site) {
      site = isGrouped(item)
        ? { key, asset: null, name: "Several assets", items: [] }
        : { key, asset: item.asset, name: item.assetDisplayName, items: [] };
      bySite.set(key, site);
    }
    site.items.push(item);
  }
  const sites = [...bySite.values()].map((site) => ({ ...site, items: ranked(site.items) }));
  const lead = (site: BoardSite) => rankable(site.items[0]!);
  const order = rankIncidents(sites.map((site) => ({ site, ...lead(site) }))).map((entry) => entry.site);
  return { sites: order, longStanding: ranked(longStanding) };
}

/** Sites in the order the board reads them: the site of the worst, newest
 * open alert first, then every other site in the order given. */
export function siteOrder(open: readonly AttentionItem[], sites: readonly { id: string; label: string }[]): { id: string; label: string }[] {
  const order = new Map<string, { id: string; label: string }>();
  for (const item of ranked(open)) {
    const members = isGrouped(item) ? item.members! : [{ asset: item.asset, assetDisplayName: item.assetDisplayName }];
    for (const member of members) {
      if (!order.has(member.asset)) order.set(member.asset, { id: member.asset, label: member.assetDisplayName });
    }
  }
  for (const site of sites) if (!order.has(site.id)) order.set(site.id, site);
  return [...order.values()];
}

/** The week's rows and bars: a row per site, every open alert from its onset
 * to now, and what settled this week as a closed bar. A grouped row draws a
 * bar on each site it stands for. */
export function alertTimeline(
  open: readonly AttentionItem[],
  settled: readonly AlertHistoryRow[],
  options: {
    nowMs: number;
    order: readonly { id: string; label: string }[];
    sitePath: (id: string) => string;
    openHref: (item: AttentionItem) => string;
    settledHref: (row: AlertHistoryRow) => string;
  },
): { lanes: TimelineLane[]; spans: TimelineSpan[] } {
  const lanes = new Map<string, TimelineLane>();
  const lane = (id: string, label: string) => {
    if (!lanes.has(id)) lanes.set(id, { id, label, href: options.sitePath(id) });
  };
  for (const site of options.order) lane(site.id, site.label);
  const spans: TimelineSpan[] = [];
  for (const item of open) {
    const label = shortHeadline(translateAlert(item).headline);
    const severity = item.severity === "error" ? "error" : "warn";
    const members = isGrouped(item) ? item.members! : [{ asset: item.asset, assetDisplayName: item.assetDisplayName, firedAt: item.firstFiredAt }];
    for (const member of members) {
      lane(member.asset, member.assetDisplayName);
      spans.push({ id: `open:${item.id}:${member.asset}`, lane: member.asset, from: member.firedAt, to: null, severity, label, href: options.openHref(item) });
    }
  }
  const weekStart = options.nowMs - ALERT_WEEK_MS;
  for (const row of settled) {
    const closed = row.flag.resolvedAt ?? row.flag.dispositionAt;
    if (closed === null || Date.parse(closed) < weekStart) continue;
    // A milestone is news, not a problem that ran from onset to a fix.
    if (row.flag.kind === "milestone" || row.flag.severity === "info") continue;
    lane(row.asset.id, row.asset.displayName);
    spans.push({
      id: `settled:${row.flag.id}`,
      lane: row.asset.id,
      from: row.flag.firstFiredAt,
      to: closed,
      severity: row.flag.severity === "error" ? "error" : "warn",
      label: shortHeadline(translateAlert(row.flag).headline),
      href: options.settledHref(row),
    });
  }
  return { lanes: [...lanes.values()], spans };
}
