// The Wall contract: the payload GET /api/wall returns, plus the freshness
// cadences the age badges read. Pure types, plain constants and pure
// derivations only, so it loads in workerd and in the browser.

import {
  REPORT_CADENCE_HOURS,
  REPORT_STALE_MULTIPLIER,
  type ReportingCoverage,
} from "@noticeos/contract/reporting";
import { INTEGRATION_CADENCE_HOURS } from "@noticeos/contract/integration-health";
import type { AnnotationItem } from "./annotations";
import type { FlagReading } from "./alert-language";
import type { CollectionVerification } from "./integrations";
import type { SignalVerification } from "./signal-liveness";
// Type-only, and it has to stay that way: `./surface` imports this module's
// `SeriesPoint`, so a value import either way would close a runtime cycle.
import type { SeriesPointOrGap } from "./surface";
import type { RevenueProjection } from './revenue-projection';
import type { DailyRevenueSummary } from './daily-revenue';

/** `milestone` is a kind, not a severity — never here. */
export type Severity = "error" | "warn" | "info";

/** flags.kind — the meaning of a flag, kept separate from how urgently it
 * needs attention. Milestones are always info-severity. */
export type FlagKind = "anomaly" | "opportunity" | "milestone";

/** One point in a sparkline series. `t` is a label (period 'YYYY-MM' or day
 * 'YYYY-MM-DD'); `v` is the value. Order is chronological ascending. */
export interface SeriesPoint {
  t: string;
  v: number;
}

/** One side of the ledger's split: money that reconciled, or money that has
 * only been reported. The two are separate fields so no caller can add them. */
export type LedgerFigure = import('@noticeos/contract/money').MoneyFigure;

/** The only P&L movement the portfolio band can defend: the last two complete
 * months, like-for-like by construction. The ledger's grain is 'YYYY-MM', so a
 * partial month against the same elapsed days of the prior one is not
 * derivable, and a partial month against a full one is never shown. The
 * current period is never one of the two, which is why both months are named
 * wherever this renders. `null` when fewer than two complete months have
 * booked: a delta nobody can defend is not rendered. */
export interface BookedDelta {
  currency: string;
  /** Signed change in major units. Subtracted in minor units, then divided
   * once, so the chip agrees with the figures to the cent. */
  value: number;
  /** Signed percent change against `priorPeriod`, for tone only. `null` when
   * the prior month booked exactly zero and a percent would divide by it. */
  percent: number | null;
  /** 'YYYY-MM' of the newer complete month — never the current period. */
  period: string;
  /** 'YYYY-MM' of the complete month it is measured against. */
  priorPeriod: string;
}

/** The part of the headline that no asset card below it states. The headline
 * sums every current ledger row for the month and the assets band excludes
 * asset #0, so a row recorded against the OS itself is inside the figure and on
 * no card. The band names that residue beside the figure so the cards add up
 * to it. Both zeroes in the ordinary case; each side renders only when it
 * holds money (`figureHasMoney`). */
export interface LedgerResidue {
  /** Reconciled residue — inside `PortfolioBand.booked`, on no card. */
  booked: LedgerFigure;
  /** Estimated residue — inside `PortfolioBand.forecast`, on no card. */
  forecast: LedgerFigure;
}

/** Portfolio band — the headline monthly net P&L. The headline is `booked`
 * and only `booked`; `forecast` carries estimates in their own field, under
 * their own label, and nothing sums the two. */
export interface PortfolioBand {
  /** Accounting period shown, 'YYYY-MM': the latest period that has a current
   * row, which is the current month whenever the current month has one. Ledger
   * rows arrive by import or by hand, so the first days of a month hold
   * nothing. `periodIsCurrent` travels beside it. */
  period: string;
  /** Is `period` the calendar month `now` falls in? Surfaces must name
   * `period` when this is false. */
  periodIsCurrent: boolean;
  /** Reconciled current (non-superseded) rows for `period` — the headline,
   * and the only figure the band presents as P&L. */
  booked: LedgerFigure;
  /** Estimated current (non-superseded) rows for `period` — reported, not
   * reconciled. Rendered as forecast, never inside `booked`. */
  forecast: LedgerFigure;
  /** Current revenue rows exist on each booking side, including an explicit
   * zero. Cost-only rows do not establish reported revenue. Absent in older
   * payloads; a zero then carries no revenue evidence by itself. */
  revenueRecorded?: { booked: boolean; forecast: boolean };
  /** Net per period over reconciled current rows (chronological) — the booked
   * trend, matching the headline. Monthly points: the ledger grain is
   * 'YYYY-MM'. */
  netTrend: SeriesPoint[];
  netTrendCurrency: string | null;
  /** Net by month over every current row, estimates included, drawn as the ROI
   * card's background and never as a printed figure — which is why it may
   * include estimates without booked money and forecast sharing a number. */
  netTrendAll: SeriesPoint[];
  netTrendAllCurrency: string | null;
  trendGranularity: "monthly" | "daily";
  /** Movement between the last two complete booked months, or null when there
   * are not two of them. Never involves `period`, which is still open. */
  bookedDelta: BookedDelta | null;
  /** Money inside `booked` / `forecast` that no asset card states — see
   * `LedgerResidue`. Zeroes in the ordinary case. */
  residue: LedgerResidue;
  /** True until a reconciled row exists. */
  firstRun: boolean;
  /** Whole days since the earliest recorded datum (ledger, else asset created). */
  daysIn: number;
}

/** Any money at all on one side of the split. Three zeroes are not a figure,
 * they are three numbers nobody asked about, so a side that holds none is
 * dropped rather than printed. `net` is derived from these two and adds no
 * information here. */
export function figureHasMoney(figure: LedgerFigure): boolean {
  return figure.revenue !== 0 || figure.cost !== 0;
}

/**
 * Does the portfolio band carry a real number to show? Before the first ledger
 * row of any kind the surfaces do not mount the card at all. A reconciled row
 * worth $0 does not hide it: `firstRun` is false the moment one exists, and a
 * confirmed zero is a fact. Nor does an empty current month, since `period`
 * falls back to the latest month that has rows.
 */
export function portfolioHasData(band: PortfolioBand): boolean {
  if (!band.firstRun) return true;
  return (
    figureHasMoney(band.booked) ||
    figureHasMoney(band.forecast) ||
    band.netTrend.some((point) => point.v !== 0)
  );
}

export type ScheduledLaneOutcome = "ran" | "skipped" | "failed";

/** Latest store-backed firing for one local-runner lane. */
export interface ScheduledLane {
  job: string;
  outcome: ScheduledLaneOutcome;
  startedAt: string;
}

/** System band — what the Wall strip's system state and Home's System tile
 * read: whether the OS's own report is owed and in, today's metered spend
 * against its daily share, report coverage and the scheduled lanes. */
export interface SystemBand {
  /** Asset #0's primary key: the desk's route to the OS's own page
   * (`useOsAssetId`), and half of `osReportMissing`. */
  assetId: string | null;
  /** Has asset #0 ever sent a report? */
  hasPulse: boolean;
  /**
   * Metered data spend on the current UTC day, counted over the report runs —
   * the providers the OS is billed for, and nothing else, because the data cap
   * is the only cap `dailyCapUsd` can honestly be drawn against. Never null: a
   * day with no metered call is a measured zero, read from the same rows every
   * other spend figure on the desk comes from.
   */
  spendTodayUsd: number;
  /** The day's share of the data cap = config/constants.json
   * `monthly_caps.data_usd` / days in the current UTC month. */
  dailyCapUsd: number;
  /** Ingest-freshness coverage across every asset that owes a report — the
   * asset set, left-joined to its latest pulse, not the pulses table. A site
   * that has never sent a report expects none and lands in `notExpected`; one
   * that sent a report and went quiet stays inside `expected` as `stale`. */
  ingest: ReportingCoverage;
  /** Every lane currently present in the job-run record, one latest row each. */
  scheduledLanes: ScheduledLane[];
}

/**
 * Is the OS's own report owed and absent? Only an installation with an OS row
 * (`assets.is_os = 1`) sends one, so with no such row nothing is owed and
 * nothing is missing.
 */
export function osReportMissing(system: Pick<SystemBand, "assetId" | "hasPulse">): boolean {
  return system.assetId !== null && !system.hasPulse;
}

/** One total on the Wall or a site's Overview. `metric` is the envelope
 * metric name — the join key that lets a total be fed either by the counters
 * lane or by the asset's own nightly report. */
export interface CounterCard {
  metric: string;
  /** Saved counter label, or words derived from an unconfigured metric name. */
  label: string;
  /** null = neither lane has a number for this metric yet (never rendered as 0,
   * and never rendered at all — the entry is skipped). */
  value: number | null;
  observedAt: string | null;
  /** Which lane produced `value`. `counters` = a counter_readings row
   * (observedAt is its own read time). `nightly` = the fallback: the latest
   * pulse envelope's `metrics[metric].total`, observedAt = that pulse's
   * received_at, so a nightly total carries no age badge of its own. null = no
   * value from either lane. */
  source: "counters" | "nightly" | null;
}

/** Available count totals for one Wall asset, resolved from the freshest lane.
 * The catalog includes missing configured cards so absence is never zero. */
export interface WallCounters {
  heading: string;
  /** Effective counters-job cadence; fast-lane freshness uses this interval. */
  cadenceHours: number;
  /** Configured cards in saved order, then discovered metrics by name. */
  cards: CounterCard[];
  /** The saved default selection, in order. Discovery never selects a card. */
  defaultMetrics: string[];
}

/** One slot in the fixed asset-header source inventory. Every asset renders
 * the same seven slots (nightly + six direct inputs), including skipped/N/A
 * sources, so absence never looks like a missing integration.
 *
 * Not a status to show directly: every screen reads a slot through
 * `sourceReadings` (`shared/connection-status`). Only a source no provider
 * collects (nightly report, uptime) is judged from `state` and its proof; for
 * a provider's source `state` carries the register's scope decision. */
export interface CardDataSource {
  id: string;
  label: string;
  state: "live" | "degraded" | "needs-setup" | "skipped" | "not-applicable";
  /** Store-backed explanation for the effective state. */
  detail?: string;
  /** When the evidence was observed; null for configuration-only states. */
  observedAt?: string | null;
  /** Typed successful outcome; older payloads without it remain unverified. */
  verification?: CollectionVerification;
}

/** One provider-backed daily chart. Values come from the latest successful
 * snapshot; the matching CardDataSource carries current run health. */
export interface SignalTrend {
  /**
   * The days immediately before `series`, in the same grain. They supply
   * prior-week and rolling-average context for the first visible date, and
   * they are the desk's history: the Wall draws `series` alone, and a surface
   * asking for a wider range reads `[...contextSeries, ...series]` and windows
   * it.
   */
  contextSeries?: SeriesPoint[];
  series: SeriesPoint[];
  /** First day whose value is still being processed and may change. */
  provisionalFrom: string | null;
  /** finished_at of the successful snapshot behind this series. */
  collectedAt: string | null;
  /**
   * Reporting-timezone changes inside this series' date range. A provider
   * buckets each event into a day using the asset's reporting timezone and
   * does not reprocess history, so a change leaves one series carrying two
   * units. Empty for the assets and periods that never changed.
   */
  timeZoneChanges: TimeZoneChangePoint[];
}

export interface TimeZoneChangePoint {
  /** The first provider day bucketed by the NEW timezone. */
  effectiveOn: string;
  from: string;
  to: string;
}

/**
 * The days a boundary move distorted on its own: the change day and the one
 * before it. Moving a day boundary by N hours moves N hours from one day to
 * its neighbour, so both are wrong by the move alone. Their values stay as
 * the provider reported them; they carry a marker instead.
 */
export function distortedByTimeZoneChange(
  changes: readonly TimeZoneChangePoint[],
  date: string,
): TimeZoneChangePoint | null {
  return (
    changes.find((change) => {
      const before = new Date(`${change.effectiveOn}T00:00:00.000Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      return date === change.effectiveOn || date === before.toISOString().slice(0, 10);
    }) ?? null
  );
}

/**
 * How far the day boundary moved, in hours. Positive means the boundary moved
 * earlier (the new zone is ahead of the old one); negative means later.
 * Evaluated on the change date rather than today, because both zones may have
 * crossed a DST line since. `null` when either zone name is not one this
 * runtime knows.
 */
export function timeZoneBoundaryShiftHours(
  change: TimeZoneChangePoint,
): number | null {
  const atMs = Date.parse(`${change.effectiveOn}T12:00:00.000Z`);
  if (!Number.isFinite(atMs)) return null;
  const from = zoneOffsetMinutes(change.from, atMs);
  const to = zoneOffsetMinutes(change.to, atMs);
  if (from === null || to === null) return null;
  return (to - from) / 60;
}

function zoneOffsetMinutes(timeZone: string, atMs: number): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(atMs))
      .find((part) => part.type === "timeZoneName")?.value;
    if (name === undefined) return null;
    if (name === "GMT" || name === "UTC") return 0;
    const match = /^(?:GMT|UTC)([+-])(\d{1,2}):?(\d{2})$/.exec(name);
    if (!match) return null;
    return (
      (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
    );
  } catch {
    // Unknown IANA name: the caller names the two zones without the size of the move.
    return null;
  }
}

/** The one sentence every surface uses for a distorted day: what moved, by
 * how much, what it did to this day, and that the number itself is untouched.
 * The mark's own hover already carries the date, so the note does not. */
export function distortedDayNote(
  change: TimeZoneChangePoint,
  date: string,
): string {
  const shift = timeZoneBoundaryShiftHours(change);
  const boundary =
    shift === null || shift === 0
      ? "boundary moved"
      : `boundary ${formatHourCount(Math.abs(shift))} ${shift > 0 ? "earlier" : "later"}`;
  const day = date === change.effectiveOn ? "day gained hours" : "day lost its last hours";
  return `Timezone ${change.from} → ${change.to}, ${boundary} · ${day} · value unaltered, not comparable`;
}

function formatHourCount(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/**
 * Does a comparison window span a change? A window starting ON the change day is
 * entirely in the new definition and is clean; one starting before it and ending
 * on or after it is not.
 */
export function windowSpansTimeZoneChange(
  changes: readonly TimeZoneChangePoint[],
  window: { start: string; end: string },
): TimeZoneChangePoint | null {
  return (
    changes.find(
      (change) => window.start < change.effectiveOn && window.end >= change.effectiveOn,
    ) ?? null
  );
}

/** Organic web-search clicks from the two central webmaster providers. Each
 * series keeps its own date horizon because Bing can trail Google by days. */
export interface WebSearchTrends {
  google: SignalTrend;
  bing: SignalTrend;
}

/** Add providers' daily series date by date. A date only one of them has
 * reported carries only that one: a provider's latency is never a zero. */
export function combineSeriesByDate(
  ...series: readonly (readonly SeriesPoint[])[]
): SeriesPoint[] {
  const totals = new Map<string, number>();
  for (const one of series) {
    for (const point of one) {
      totals.set(point.t, (totals.get(point.t) ?? 0) + point.v);
    }
  }
  return [...totals.entries()]
    .map(([t, v]) => ({ t, v }))
    .sort((left, right) => left.t.localeCompare(right.t));
}

/**
 * Two providers as one measurement — the desk states clicks, not Google's
 * clicks. Shared because the Worker and the browser both need the merge.
 * `provisionalFrom` takes the earliest of the two and `collectedAt` the
 * oldest: a pair is only as fresh as its stalest half.
 */
export function mergeSignalTrends(trends: readonly SignalTrend[]): SignalTrend {
  const provisional = trends
    .map((trend) => trend.provisionalFrom)
    .filter((value): value is string => value !== null)
    .sort();
  const collected = trends
    .map((trend) => trend.collectedAt)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    contextSeries: combineSeriesByDate(
      ...trends.map((trend) => trend.contextSeries ?? []),
    ),
    series: combineSeriesByDate(...trends.map((trend) => trend.series)),
    provisionalFrom: provisional[0] ?? null,
    collectedAt: collected[0] ?? null,
    timeZoneChanges: trends.flatMap((trend) => trend.timeZoneChanges),
  };
}

/** Every daily series the shared signal-trend loader can return for one
 * asset. A series a caller did not ask the store for stays empty rather than
 * absent, so both callers read one shape. */
export interface SignalTrendSet {
  /** GA4 daily distinct users. */
  activeUsers: SignalTrend;
  /** Date-aligned Google/Bing organic clicks, each with its own freshness. */
  webSearchClicks: WebSearchTrends;
  /** Date-aligned Google/Bing organic impressions. Kept separate from clicks
   * so the two different questions—visibility and visits—never share a scale. */
  webSearchImpressions: WebSearchTrends;
  /** GA4 daily sessions. A person can open several, so this is never the same
   * question as `activeUsers` and the two are never added together. */
  sessions: SignalTrend;
  /** GA4 daily page views. */
  pageViews: SignalTrend;
  /** GA4 daily event count. */
  events: SignalTrend;
  /** Search Console daily click-through rate, exactly as the provider reports
   * it: a 0–1 fraction, not a percentage. */
  searchCtr: SignalTrend;
  /** Search Console daily average position. Lower is better, so a falling
   * line is an improving one and any direction indicator must be inverted. */
  searchPosition: SignalTrend;
}

/** What one asset has in flight, from the newest task snapshot. Counts
 * exclude container-type tasks; the poller (`scripts/os-up.mjs`) does that,
 * because the stored lists are truncated and nothing downstream can.
 * `blocked` is the blocker-aware subset of `open`; `highPriority` cuts across
 * both stored statuses; `closedRecent` looks backward. Never add them. */
export interface WorkSummary {
  /** Not started. */
  open: number;
  /** P0+P1 across everything not closed. null = not measured by the poller
   * that wrote this snapshot, which never renders as zero: the chip is omitted. */
  highPriority: number | null;
  inProgress: number;
  /** Subset of `open` waiting on another task to close first. */
  blocked: number;
  /** Closed inside the poller's trailing-week window — momentum, not queue. */
  closedRecent: number;
  /** Open work per `bd` priority band, P0..P4; index is the priority. null
   * when the snapshot did not carry one, and the card then draws nothing. */
  priorities: number[] | null;
  /** When the poller photographed the hub; the widget ages itself against the
   * poller's cadence. */
  capturedAt: string;
}

/** The asset's serp-panel review obligation, as the newest task snapshot
 * recorded it: the open `panel-review` task if there is one, else the most
 * recently closed one. Every date is nullable because this row outlives the
 * poller that wrote it; a date that did not arrive costs the card its
 * precision, never its whole badge (`panelReviewState`). */
export interface PanelReview {
  /** The task in the asset's own project — the thing to go and close. */
  beadId: string;
  /** Which panel day this review is about ('YYYY-MM-DD', the archive's
   * `report_date`). This, not the close timestamp, decides whether a finished
   * review still covers the newest panel (`panelReviewState`). */
  panelDate: string | null;
  /** When triage is due: seven days after the landing. */
  dueAt: string | null;
  status: "open" | "closed";
  /** When it was closed. Absent on an open task, and on a closed one written
   * by a poller that did not record it. */
  closedAt: string | null;
  /** Whether this asset buys a tracked SERP panel (a `config/serp-panel.json`
   * entry). Not part of the obligation — every collecting asset owes the weekly
   * read — it decides only the noun the marker uses (`panelReviewNouns`). The
   * builders attach it from config; the task snapshot never carries it. */
  panel: boolean;
}

/** The words a review marker uses, chosen by whether the asset has a panel
 * at all, matching the two titles `panelReviewTitle` in
 * `scripts/runner/panel-review.mjs` files under. */
export interface PanelReviewNouns {
  /** Sentence-initial, for the line's label and the badge's accessible name. */
  label: string;
  /** The noun phrase a hover sentence is built around. */
  subject: string;
  /** How a hover names the day that landed. */
  collected: string;
}

export function panelReviewNouns(
  review: PanelReview | null | undefined,
): PanelReviewNouns {
  return review?.panel === false
    ? {
        label: "Signal collection",
        subject: "weekly signal collection",
        collected: "Collection landed",
      }
    : {
        label: "SERP panel",
        subject: "tracked SERP panel",
        collected: "Panel collected",
      };
}

/** What an asset card says about its panel review. `none` renders nothing —
 * no badge, no dash, no empty state. */
export type PanelReviewState = "none" | "pending" | "overdue" | "reviewed";

/** Epoch ms, or null when the string is absent or not a date. */
function instantOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * The one rule behind the panel-review badge. The question is about the panel,
 * not the task: has the newest collection been triaged? A finished review is
 * matched against the newest panel day by `panelDate`, not by close time — a
 * close newer than a later panel's arrival covers none of it, and a backfill
 * cannot fool the comparison. A review about an older day goes back to
 * `pending` even before its task is filed. Every degraded input lands in
 * `pending`, never `overdue`: overdue is only reached off a deadline that can
 * be read. The boundary is `>`, matching `isAmber`.
 */
export function panelReviewState(
  review: PanelReview | null | undefined,
  latestPanelDate: string | null,
  nowMs: number,
): PanelReviewState {
  if (!review) return "none";

  if (review.status === "closed") {
    if (instantOf(review.closedAt) === null) return "pending";
    const landed = instantOf(latestPanelDate);
    // No readable landing: nothing contradicts the close.
    if (landed === null) return "reviewed";
    const covered = instantOf(review.panelDate);
    if (covered === null) return "pending";
    return covered >= landed ? "reviewed" : "pending";
  }

  const dueAt = instantOf(review.dueAt);
  if (dueAt === null) return "pending";
  return nowMs > dueAt ? "overdue" : "pending";
}

/**
 * Which panel day the marker is about. On a pending or overdue review, the
 * newest day collected; only a `reviewed` marker names the review's own day,
 * because there it is the day that was read.
 */
export function panelDayOf(
  review: PanelReview | null | undefined,
  latestPanelDate: string | null,
  state: PanelReviewState,
): string | null {
  if (!review) return latestPanelDate;
  return state === "reviewed"
    ? (review.panelDate ?? latestPanelDate)
    : (latestPanelDate ?? review.panelDate);
}

/** One assets-band card. Order is fixed (seed order), never sorted. */
export interface AssetCard {
  id: string;
  displayName: string;
  status: string;
  senseOnly: boolean;
  /** Worst severity among OPEN flags. Cards render a dot only for actionable
   * warning/error states; healthy identity is the favicon. */
  worstSeverity: Severity | null;
  /** Attention-eligible conditions, not repeated firing counts. */
  openError: number;
  openWarn: number;
  /** This asset's reconciled current rows for `netPeriod` — the same split
   * the portfolio band leads with. Three zeroes = nothing reconciled this
   * period, never a null. */
  booked: LedgerFigure;
  /** This asset's estimated current rows for `netPeriod` — reported, not
   * reconciled. Labelled as forecast, never added to `booked`. */
  forecast: LedgerFigure;
  /** The accounting period `booked` and `forecast` cover ('YYYY-MM'), so the
   * card can name the month it is quoting without ambient context. */
  netPeriod: string;
  /** received_at of this asset's latest pulse (report-freshness sentence). */
  pulseReceivedAt: string | null;
  /** The operator declared that this asset sends no nightly report
   * (config/constants.json `no_nightly_report`). Whether a report is expected
   * is `expectsNightlyReport(noNightlyReport, pulseReceivedAt)`. Absent on an
   * older payload, which means not declared. */
  noNightlyReport?: boolean;
  /** received_at of this asset's FIRST pulse ever, or null when none arrived. */
  firstReportAt: string | null;
  /** Distinct pulse dates in the last 28 completed UTC days; absent on older
   * payloads, which means coverage unknown. */
  reportDays?: number | null;
  /** Effective state for the fixed seven-slot asset source inventory. */
  dataSources: CardDataSource[];
  /** Available pulse totals and the configured default row. Absent on an older
   * payload; an empty default selection adds no totals to the Wall. */
  counters?: WallCounters;
  /** GA4 daily active users, reconstructed from the latest values in the
   * append-only observation log. */
  activeUsers: SignalTrend;
  /** Future earnings estimate derived from stored daily revenue and traffic. */
  revenueProjection?: RevenueProjection;
  /** Yesterday's saved provider estimate. Missing is not zero. */
  dailyRevenue?: DailyRevenueSummary;
  /**
   * Organic web-search clicks, Google and Bing read as one measurement
   * (`mergeSignalTrends`). Its date horizon is the union of the two, so it can
   * run a few days wider than `activeUsers` at both ends, and those edge days
   * carry one provider's value alone: a provider's latency is never a zero.
   * Window by date (`windowSeries`), never by counting points. Empty on an
   * asset with neither provider wired.
   */
  searchClicks: SignalTrend;
  /**
   * This asset's net, month by month, ascending: revenue minus its direct
   * cost, superseded rows excluded, portfolio overhead allocated to nobody —
   * the same grouping the financials payload's by-asset table is built from.
   * A month this asset booked nothing in is a hole (`v: null`) on an unbroken
   * axis, never a zero and never an omission.
   */
  netByMonth: SeriesPointOrGap[];
  netByMonthCurrency: string | null;
  /** The month the store is standing in (`YYYY-MM`), or null when the ledger
   * holds nothing — the boundary `netByMonth`'s last point is provisional from,
   * carried beside it so no reader has to derive it from a clock of its own. */
  netByMonthProvisionalFrom: string | null;
  /** This asset's open work, or null when the snapshot cannot answer for it:
   * none filed yet, the poller could not read that repo, the asset has no task
   * project, or the newest row predates type-aware counts. Never zeros, which
   * would claim an empty queue. */
  work: WorkSummary | null;
  /** This asset's weekly review obligation, or null, which renders as nothing.
   * null covers three absences alike: no DataForSEO collection landed inside
   * `PANEL_LANDING_WINDOW_DAYS`, the newest snapshot carries no `panelReview`
   * for it, or that snapshot predates the field. Having no
   * `config/serp-panel.json` entry is not one of them: such an asset still owes
   * the read and states it in its own noun (`panelReviewNouns`). */
  panelReview: PanelReview | null;
  /** The newest panel day collected for this asset ('YYYY-MM-DD', the
   * `report_date` of its latest dataforseo/serp-panel run) — the day a
   * finished review has to be about for it to still count. Two manifest rows
   * for one panel day are one landing, which is why this is a day and not a
   * write timestamp. null when none has landed. */
  latestPanelDate: string | null;
}

/**
 * Does this asset have money to state for `netPeriod`? With neither side
 * carrying any there is no accounting block — but the card itself stays.
 * `figureHasMoney` decides each side, so a reconciled $0 (revenue 100, cost
 * 100) still shows.
 */
export function cardHasMoney(card: Pick<AssetCard, "booked" | "forecast">): boolean {
  return figureHasMoney(card.booked) || figureHasMoney(card.forecast);
}

/**
 * Rules whose repeated firings are one ongoing condition, not N events.
 * Grouping is opt-in: the obvious key (asset, rule_id, metric) is wrong for a
 * rule like `watch-window-closed`, whose firings on one metric carry different
 * `watchWindowId`s and ask for different decisions. An undeclared rule renders
 * one row per firing and can never merge two decisions into one. A rule earns
 * a place here by being a threshold re-evaluated on a schedule, where each
 * firing re-states one standing condition and carries no subject of its own.
 */
export const RECURRING_CONDITION_RULES: ReadonlySet<string> = new Set([
  "asset-declared",
  "flow-poisson-low",
]);

/** The columns a flag row must carry to be grouped into a condition. */
export interface ConditionFiring {
  /** flags.id — the identity an undeclared rule's group is keyed by. */
  id: number;
  asset: string;
  ruleId: string;
  metric: string | null;
  firedAt: string;
}

/** One condition's open firings, as counted for both surfaces. */
export interface ConditionGroup<F extends ConditionFiring> {
  /** The firing that stands for the group: the first row in caller order.
   * Both builders read severity-first then `fired_at DESC`, so it is the newest
   * reading. */
  latest: F;
  /** Every open firing of this condition, in caller order. */
  firings: F[];
  /** `firings.length` — 1 for an ordinary event. */
  occurrences: number;
  /** The onset: a condition is as old as it has been true, not as old as its
   * most recent re-reading. */
  firstFiredAt: string;
}

/**
 * Collapse open firings into conditions — the one derivation behind both the
 * Wall's attention list and the asset page's Current signals. The key is
 * (asset, rule_id, metric) for a declared rule and the flag's own id for
 * everything else, so an undeclared rule's firings land in groups of one. It
 * is also the key `applyFlagAction` re-derives in SQL. Order is the caller's:
 * the representative is `firings[0]`, and groups come back in first-seen
 * order, so a caller's severity ordering survives.
 */
export function groupConditionFirings<F extends ConditionFiring>(
  rows: readonly F[],
): ConditionGroup<F>[] {
  const groups = new Map<string, F[]>();
  for (const row of rows) {
    // NUL joins the parts: no field can contain one, so none can forge another's boundary.
    const key = RECURRING_CONDITION_RULES.has(row.ruleId)
      ? `${row.asset}\u0000${row.ruleId}\u0000${row.metric ?? ""}`
      : `#${row.id}`;
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map((firings) => {
    const latest = firings[0]!;
    return {
      latest,
      firings,
      occurrences: firings.length,
      firstFiredAt: firings.reduce(
        (earliest, row) => (row.firedAt < earliest ? row.firedAt : earliest),
        latest.firedAt,
      ),
    };
  });
}

/** One asset inside a cross-asset attention group. It carries its own flag
 * id: the group says one fact once, never merges decisions. Mark read /
 * Resolve under an expanded member act on that member's flag only. */
export interface AttentionMember {
  /** flags.id — this member's own acknowledge/resolve target. */
  id: number;
  asset: string;
  assetDisplayName: string;
  firedAt: string;
  verification?: SignalVerification;
}

export interface AttentionItem {
  /** flags.id — stable target for acknowledge/resolve actions. */
  id: number;
  asset: string;
  assetDisplayName: string;
  severity: Severity;
  kind: FlagKind;
  /** The rule's own words, verbatim from the store — the audit trail, and the
   * fallback headline for any rule the translator doesn't know. */
  message: string;
  firedAt: string;
  metric: string | null;
  /** flags.rule_id — which rule fired, and so which translation applies. */
  ruleId: string;
  /** flags.rule_inputs, parsed (the column is TEXT). null when the rule stored
   * none or the JSON is unreadable — the headline then degrades to `message`. */
  ruleInputs: Record<string, unknown> | null;
  /** Timeline events on this asset in the 48h before the condition started
   * (`firstFiredAt`); [] renders nothing. Anchored to the first firing, not the
   * newest: the 48h before a routine re-evaluation reliably hold nothing. */
  correlatedChanges: AnnotationItem[];
  /** How many open firings this row stands for — 1 for an ordinary event.
   * Only rules in {@link RECURRING_CONDITION_RULES} ever exceed 1. */
  occurrences: number;
  /** When this condition FIRST fired. Equals `firedAt` when `occurrences` is 1,
   * and is what the row ages from — a condition is as old as its onset, not as
   * old as its most recent re-reading. */
  firstFiredAt: string;
  /** Tasks filed from this condition's flag numbers in the latest hub snapshot.
   * Absent when the project or this snapshot field could not be read. */
  handoffBeads?: import('./asset-detail').HandoffBead[];
  verification?: SignalVerification;
  /** The assets this row stands for, when one fact is true of several at once.
   * Absent on every ordinary row and on a group of one. Surfaces read the
   * presence of this field, not the rule id. */
  members?: AttentionMember[];
  /** This condition's stored readings, newest first (`flag_evidence`); absent
   * when it has none or the store predates them. */
  readings?: FlagReading[];
}

/**
 * A condition the operator parked, with the date it comes back: the same
 * condition, grouping and headline as an `AttentionItem`, minus the demand for
 * attention until `snoozeUntil`. Its scope is wider than the open list's
 * error/warn, because Snooze is offered on every open row, info and milestone
 * included; the portfolio's counts keep the error/warn scope
 * `worker/flag-scope.ts` defines.
 */
export interface SnoozedItem extends AttentionItem {
  /** flags.snooze_until — when this condition returns to the open lists. The
   * latest of the group's firings: the row is quiet until its last member is. */
  snoozeUntil: string;
}

/** The human-intervention half of the Wall's attention horizon. `waiting` is
 * the sum the newest task snapshot could measure, paired with explicit
 * coverage so a partial read renders `N+`. Zero only renders as calm when
 * every photographed project supplied the total; a missing snapshot is 0/0
 * coverage — unknown, never "nobody needs you". */
export interface OperatorPosture {
  waiting: number;
  /** Gates + P0/P1 asks from projects that supplied the untruncated count. */
  urgent: number;
  measuredProjects: number;
  urgentMeasuredProjects: number;
  projectCount: number;
  /** When the local runner photographed the task hub, not payload render time. */
  capturedAt: string | null;
}

/** The core inbox before a hub reading; zero coverage proves no count. */
export function unreadOperatorPosture(): OperatorPosture {
  return { waiting: 0, urgent: 0, measuredProjects: 0, urgentMeasuredProjects: 0, projectCount: 0, capturedAt: null };
}

/** What one Wall refresh computes (`buildWallPayload`): the TV and the desk
 * pages read it, and the MCP `list_properties` tool hands part of it to
 * agents. Every key names the screen that draws it in
 * `WALL_PAYLOAD_INVENTORY` (shared/materiality.ts); a field no screen draws is
 * not computed. */
export interface WallPayload {
  /** When the Worker assembled this payload (ISO). */
  generatedAt: string;
  portfolio: PortfolioBand;
  system: SystemBand;
  /** File-owned Home/Wall widgets. Included in the polled read model so a
   * read-only Wall on another device sees applied Home edits without reload. */
  dashboard: import("./dashboard").DashboardConfig;
  assets: AssetCard[];
  attention: AttentionItem[];
  /** Conditions parked until a date — open in the store, quiet until then.
   * Never merged into `attention`. */
  snoozed: SnoozedItem[];
  /** Actionable human-labelled tasks plus open human approvals, across the
   * core hub. A legacy null is an unread inbox. */
  operator: OperatorPosture | null;
  /** Latest ledger recorded_at: how old the ledger is. The MCP `list_properties`
   * tool hands it to agents beside the portfolio (worker/mcp-route.ts). */
  ledgerRecordedAt: string | null;
}

/** Expected data cadence per lane, in hours. Age badges turn amber past
 * `AMBER_MULTIPLIER`× these. */
export const CADENCE_HOURS = {
  /** The nightly report lane, straight from the contract — the same cadence
   * the ingest freshness cron ages a report against. */
  pulse: REPORT_CADENCE_HOURS,
  /** GA4 + GSC share the 15-minute Sense cron. */
  signals: INTEGRATION_CADENCE_HOURS.signals,
  /** Bing publishes this traffic dataset daily. */
  bingSignals: INTEGRATION_CADENCE_HOURS.bingSignals,
  /** DataForSEO provider datasets are archived once per week. */
  dataforseoSignals: INTEGRATION_CADENCE_HOURS.dataforseoSignals,
  /** PostHog product analytics families are archived once a day at 12:30 UTC. */
  posthogSignals: INTEGRATION_CADENCE_HOURS.posthogSignals,
  /** Clarity's export makes one call per project a day. */
  claritySignals: 24,
  /** Served-layer hygiene checks run once nightly at 04:00 UTC. */
  hygiene: 24,
  /** The home-page check runs every hour as the site's uptime (`runUptimeChecks`). */
  uptime: 1,
  ledger: 24 * 31,
} as const;

/** One multiplier for every lane, held to the contract's own
 * `REPORT_STALE_MULTIPLIER` so pulse age badges stale at the very number the
 * ingest cron flags at. */
export const AMBER_MULTIPLIER = REPORT_STALE_MULTIPLIER;
