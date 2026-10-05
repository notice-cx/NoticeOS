// Shared Wall contract: the single payload GET /api/wall returns, plus the
// freshness cadences the age badges read. Imported by BOTH the Worker (payload
// assembly) and the client (rendering) so the shape can never drift between
// them. Pure types, plain constants, and pure derivations over them — no runtime
// deps, safe in workerd.

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
// TYPE-ONLY, AND IT HAS TO STAY THAT WAY. `./surface` imports this module's
// `SeriesPoint`, so a value import either way would close a runtime cycle;
// both directions are erased at compile, and this one only names the gap-aware
// series shape a card's monthly net travels in (bead `ro-78qo.37`).
import type { SeriesPointOrGap } from "./surface";
import type { RevenueProjection } from './revenue-projection';
import type { DailyRevenueSummary } from './daily-revenue';

/** doc 02 severity enum. `milestone` is a KIND, not a severity — never here. */
export type Severity = "error" | "warn" | "info";

/** db/0001 flags.kind — the meaning of a flag, kept separate from how urgently
 * it needs attention. Milestones are always info-severity, but kind still
 * travels on every flag so a surface never has to infer meaning from color. */
export type FlagKind = "anomaly" | "opportunity" | "milestone";

/** One point in a sparkline series. `t` is a label (period 'YYYY-MM' or day
 * 'YYYY-MM-DD'); `v` is the value. Order is chronological ascending. */
export interface SeriesPoint {
  t: string;
  v: number;
}

/** One side of the ledger's honesty split (docs/02 §"Revenue & cost"): money
 * that reconciled, or money that has only been reported. The two are separate
 * fields precisely so no caller can add them by accident — a total mixing them
 * would be a booked P&L containing money nobody has confirmed. */
export type LedgerFigure = import('@noticeos/contract/money').MoneyFigure;

/** The only P&L movement the PORTFOLIO band can defend (bead `ro-7yv`).
 *
 * doc 10's headline definition: a comparable-period delta is month-to-date
 * versus the SAME ELAPSED DAYS in the prior month, never a partial month
 * against a full one. The ledger's grain is 'YYYY-MM' and its amounts are
 * whole-month reported figures, so a prior month's first-N-days total is not
 * derivable at all — the doc's preferred comparison cannot be computed from
 * this store, and the band used to ship the forbidden one instead (the last
 * two trend points, i.e. today's partial month against last month entire).
 *
 * What IS computable is the last two COMPLETE months: two sides that each
 * cover a whole month, so they are like-for-like by construction. The current
 * period is never one of them, which is exactly why both months are NAMED
 * wherever this renders — the chip is about closed books, not about the
 * headline above it.
 *
 * `null` when fewer than two complete months have booked. A delta nobody can
 * defend is not rendered smaller or greyer; it is not rendered.
 */
export interface BookedDelta {
  currency: string;
  /** Signed change in major units. SUBTRACTED in minor units, then divided
   * once, so the chip agrees with the figures to the cent (bead `ro-wtt`). */
  value: number;
  /** Signed percent change against `priorPeriod`, for tone only. `null` when
   * the prior month booked exactly zero and a percent would divide by it. */
  percent: number | null;
  /** 'YYYY-MM' of the newer complete month — never the current period. */
  period: string;
  /** 'YYYY-MM' of the complete month it is measured against. */
  priorPeriod: string;
}

/** The part of the headline that NO asset card below it states (bead
 * `ro-t0z`).
 *
 * The headline sums every current ledger row for the month; the ASSETS band
 * excludes asset #0. So a row recorded against the OS itself would be inside the
 * figure and on no card, and an operator adding the cards up would find them
 * quietly short of the number above them — the exact invariant `ro-uwo.2`
 * established and tests.
 *
 * Nothing writes such a row today, and `workers/ingest/src/routes/revenue.ts`
 * has no is_os guard, so one POST is all it would take. Rather than forbid the
 * row or drop it from the headline — either of which decides on the operator's
 * behalf that OS money is not portfolio money — the band STATES it: the residue
 * is named on the same card as the figure it is inside of, and the arithmetic
 * closes in public.
 *
 * Both zeroes in the ordinary case, and each side renders only when it holds
 * money (`figureHasMoney`), so today this adds nothing to the Wall at all. */
export interface LedgerResidue {
  /** Reconciled residue — inside `PortfolioBand.booked`, on no card. */
  booked: LedgerFigure;
  /** Estimated residue — inside `PortfolioBand.forecast`, on no card. */
  forecast: LedgerFigure;
}

/** PORTFOLIO band — the headline monthly net P&L, the least-interpretive number.
 *
 * The headline is `booked` and ONLY `booked`. The Wall used to wait for one
 * reconciled row to exist and then sum every current row, so a single
 * reconciliation could unlock a "portfolio total" mostly composed of estimates
 * while the empty-state copy on the same surface said estimates do not count
 * (doc 19 finding 4). `forecast` now carries those estimates in their own field,
 * under their own label, and nothing sums the two. */
export interface PortfolioBand {
  /** Accounting period shown, 'YYYY-MM'.
   *
   * NOT always the current calendar month (bead `ro-bdkp`). Every ledger row in
   * this store arrives by import or by hand, so the first days of a month hold
   * nothing at all — and a band reading only the current month showed no money
   * for those days, on the one surface D13 says must lead with money. It now
   * shows the LATEST period that has a current row, which is the current month
   * whenever the current month has one.
   *
   * The shift is never silent: `periodIsCurrent` travels beside it and the card
   * names the month whenever this is not today's. */
  period: string;
  /** Is `period` the calendar month `now` falls in?
   *
   * false means the figures below describe a month the reader is no longer in,
   * because the current one has no ledger row yet. Surfaces MUST name `period`
   * when this is false — a September glance must never be read as September's
   * money. */
  periodIsCurrent: boolean;
  /** RECONCILED current (non-superseded) rows for `period` — the headline.
   * This is money somebody confirmed, and it is the only figure the band
   * presents as P&L. */
  booked: LedgerFigure;
  /** ESTIMATED current (non-superseded) rows for `period` — reported, not
   * reconciled. Rendered as forecast, visibly distinct, never inside `booked`. */
  forecast: LedgerFigure;
  /** Current revenue rows exist on each booking side, including an explicit
   * zero. Cost-only rows do not establish reported revenue. Absent in older
   * payloads; a zero then carries no revenue evidence by itself. */
  revenueRecorded?: { booked: boolean; forecast: boolean };
  /** Net per period over RECONCILED current rows (chronological) — the BOOKED
   * trend, matching the headline. Monthly points in Phase 0: the ledger grain is
   * 'YYYY-MM', so daily net is not derivable. */
  netTrend: SeriesPoint[];
  netTrendCurrency: string | null;
  /**
   * Net by month over EVERY current row — estimates included — drawn as the ROI
   * card's background rather than as a figure.
   *
   * `netTrend` above is reconciled-only, which is right for anything that
   * states a number. But a portfolio whose months are all still estimates has an
   * empty reconciled trend, and a "NO DATA" placard is a worse answer than an
   * honestly labelled shape. Because this is ambient background and never a
   * printed figure, it can include estimates without breaking the rule that
   * booked money and forecast never share a number.
   */
  netTrendAll: SeriesPoint[];
  netTrendAllCurrency: string | null;
  trendGranularity: "monthly" | "daily";
  /** Movement between the last two COMPLETE booked months, or null when there
   * are not two of them. Never involves `period`, which is still open. */
  bookedDelta: BookedDelta | null;
  /** Money inside `booked` / `forecast` that no asset card states — see
   * `LedgerResidue`. Zeroes in the ordinary case. */
  residue: LedgerResidue;
  /** doc 10 first-run state: true until a reconciled row exists. When true the
   * band renders "P&L starts with the first reconciled month — N days in.",
   * beside whatever `forecast` has been reported so far. */
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
 * Does the PORTFOLIO band carry a real number to show? (bead `ro-yf3`)
 *
 * Everything the card renders is money: a booked headline, the booked trend
 * beneath it, and the forecast block below the rule. Before the first ledger row
 * of ANY kind there is none of that, and the card is left holding a title, an
 * age badge with no date, and a sentence explaining its own emptiness. That is
 * wall noise, not state — so the surfaces do not mount it at all. Absence is the
 * honest render.
 *
 * This is a derivation, not a payload field, so there is exactly one rule and no
 * way for a held last-good payload to disagree with the Worker that built it.
 * The first real row — reconciled OR estimated — flips it back to true and the
 * card returns unchanged.
 *
 * Note what does NOT hide the card: a reconciled row worth $0. `firstRun` is
 * false the moment one exists, and a booked zero somebody confirmed is a fact
 * the operator asked for.
 *
 * Nor does an empty CURRENT month (bead `ro-bdkp`). `period` falls back to the
 * latest month that has rows, so the only store this returns false for is one
 * whose ledger is empty outright — the same first-run absence it was written
 * for, rather than the first four days of every month forever.
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

/** SYSTEM band — what the Wall strip's one system state and Home's System
 * tile read: whether the OS's own report is owed and in, today's metered
 * spend against its daily share, report coverage and the scheduled lanes.
 * Nothing else rides here (bead `ro-trai.44`): the old System card's agents,
 * queue, monthly cap and work widget left the Wall with D28. */
export interface SystemBand {
  /** Asset #0's primary key: the desk's route to the OS's own page
   * (`useOsAssetId`), and half of `osReportMissing`. */
  assetId: string | null;
  /** Has asset #0 ever sent a report? */
  hasPulse: boolean;
  /**
   * METERED DATA SPEND on the current UTC day, counted over the report runs
   * — the providers the OS is billed for, and nothing else (bead `ro-rggc`).
   *
   * The definition is not decoration: it is the only reading `dailyCapUsd` can
   * honestly be drawn against, since the data cap is the portfolio's only cap
   * (D6 amended 2026-09-05, bead `ro-uj7x`). Model spend happens in sessions
   * billed outside the OS, nothing meters it, and folding it in here would run
   * the meter permanently over a ceiling that never covered it.
   *
   * NEVER null (bead `ro-sq42`). It used to come from asset #0's report, which
   * nothing wrote, so the honest rendering was an absent row (doc 17 rule 6).
   * It is now counted from the OS's own record of the calls it made, and a day
   * with no metered call is a MEASURED zero rather than a hole — rule 6 forbids
   * a meter drawn at a zero *nobody reported*, and this zero is reported by the
   * same rows every other spend figure on the desk is read from. So the row
   * draws every day, and it survives asset #0 going quiet the way the freshness
   * line does: the store remembers what was spent even when nothing reports.
   */
  spendTodayUsd: number;
  /** The day's share of the data cap = config/constants.json
   * `monthly_caps.data_usd` / days in the current UTC month. */
  dailyCapUsd: number;
  /** Ingest-freshness coverage across every asset that OWES a report — the
   * asset set, left-joined to its latest pulse, not the pulses table (docs/19
   * finding 5). A site that has never sent a report expects none (D29
   * amended, bead `ro-ujb9.121`) and lands in `notExpected`; one that sent a
   * report and went quiet stays inside `expected` as `stale`. */
  ingest: ReportingCoverage;
  /** Every lane currently present in the job-run record, one latest row each. */
  scheduledLanes: ScheduledLane[];
}

/**
 * IS THE OS'S OWN REPORT OWED AND ABSENT? (bead `ro-ujb9.161`) Only an
 * installation with an OS row (`assets.is_os = 1`, `assetId` above) sends one,
 * so with no such row nothing is owed and nothing is missing — the same idea as
 * a site's `expectsNightlyReport`: nothing expected, nothing red. A new
 * installation (`pnpm start`, the journey fixture) has no OS row.
 */
export function osReportMissing(system: Pick<SystemBand, "assetId" | "hasPulse">): boolean {
  return system.assetId !== null && !system.hasPulse;
}

/** One total on the Wall or a site's Overview. `metric` is the ENVELOPE
 * metric name — the join key that lets
 * a total be fed either by the 15-minute counters lane or by the asset's own
 * nightly report, so the primitive is format-agnostic. */
export interface CounterCard {
  metric: string;
  /** Saved counter label, or words derived from an unconfigured metric name. */
  label: string;
  /** null = neither lane has a number for this metric yet (never rendered as 0,
   * and never rendered at all — the entry is skipped). */
  value: number | null;
  observedAt: string | null;
  /** Which lane produced `value`. `counters` = a counter_readings row (fast lane,
   * observedAt is its own read time). `nightly` = the fallback: the latest pulse
   * envelope's `metrics[metric].total`, observedAt = that pulse's received_at —
   * so a nightly total carries NO age badge of its own, because the card's
   * last-report badge already states exactly that age (doc 14 one-representation).
   * null = no value from either lane. */
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

/** One slot in the fixed asset-header source inventory. Every asset
 * renders the same seven slots (nightly + six direct inputs), including
 * skipped/N/A sources, so absence never looks like a missing integration.
 *
 * NOT A STATUS TO SHOW (bead `ro-ujb9.96.7.16`). Every screen reads a slot
 * through `sourceReadings` (`shared/connection-status`), the same model the
 * Integrations page and the asset's Data sources use: a provider's source is
 * that site's status over the monitoring items, and only a source no provider
 * collects (nightly report, uptime) is judged from `state` and its proof. For
 * a provider's source `state` still carries the register's scope decision
 * (skipped, not applicable). */
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
   * The days immediately BEFORE `series`, in the same grain.
   *
   * They supply prior-week and rolling-average context for the first visible
   * date, so the first point of a window is already an average rather than a
   * stub. The Wall never draws them: its card charts `series` and nothing else,
   * which is what pins the TV's four legible weeks whatever the payload
   * carries.
   *
   * SINCE `ro-78qo.35` THEY ARE ALSO THE DESK'S HISTORY. The wall payload
   * carries ninety days per asset because doc 21 gives every surface a
   * 7 · 28 · 90 range and /assets reads this same payload; a 90d button drawing
   * 28 days of line would be the page lying about its own window. Twenty-eight
   * of those days are `series` and the rest are here, so a surface asking for a
   * range wider than the Wall's window reads `[...contextSeries, ...series]`
   * and windows it — exactly what the asset page's `averageOverRange` already
   * does. Nothing that draws `series` alone changed.
   */
  contextSeries?: SeriesPoint[];
  series: SeriesPoint[];
  /** First day whose value is still being processed and may change. */
  provisionalFrom: string | null;
  /** finished_at of the successful snapshot behind this series. */
  collectedAt: string | null;
  /**
   * Reporting-timezone changes inside this series' date range (`ro-tzq`).
   *
   * A provider buckets each event into a day using the asset's reporting
   * timezone, so a change to that timezone changes what a DAY IS. The provider
   * does not reprocess history, which leaves one series carrying two units —
   * and a date alone cannot say which side of the line a point is on.
   *
   * Carried on the series rather than looked up by each consumer, because every
   * consumer asks the same two questions: does my comparison window span one of
   * these, and is this point one of the days the move distorted.
   *
   * Empty for the assets and the periods that never changed, which is
   * almost all of them.
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
 * before it.
 *
 * Moving a day boundary by N hours does not relabel days, it moves N hours from
 * one day to its neighbour. Both are wrong by the move alone and neither is
 * evidence about the asset. Their VALUES stay exactly as the provider
 * reported them — the numbers are what was measured, and rewriting them would
 * destroy the only record of that — so what they carry is a marker instead.
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
 * How far the day boundary moved, in hours, as of the change's own date.
 *
 * The two zone names are the only record of the size of the move, and "three
 * hours" is the fact a reader needs — the two names side by side
 * is a pair of strings until somebody subtracts them. Positive means the
 * boundary moved EARLIER (the new zone is ahead of the old one, so its midnight
 * arrives first, closing the previous day short); negative means later.
 *
 * Evaluated ON the change date rather than today, because both zones may have
 * crossed a DST line since, and the move the reader is asking about is the one
 * that happened then. `null` when either zone name is not one this runtime
 * knows — a marker with no hour count is still a marker.
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
    // An unknown IANA name is data we cannot arithmetic on; the caller degrades
    // to naming the two zones without the size of the move.
    return null;
  }
}

/**
 * The one sentence every surface uses for a distorted day (`ro-kukv.8`).
 *
 * The mark on a chart is geometry; this is the words behind it, and it lives
 * here so the bars, the line and any later surface cannot describe the same day
 * three different ways. It says what moved, by how much, and — the part a
 * reader actually needs — that the number itself is untouched.
 */
export function distortedDayNote(
  change: TimeZoneChangePoint,
  date: string,
): string {
  // Four facts as one label line (bead `ro-ujb9.96.6.12`): what moved, by how
  // much, what it did to THIS day, and that the number itself is untouched.
  // The mark's own hover already carries the date, so the note does not.
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

/**
 * Add two providers' daily series date by date.
 *
 * A date only ONE of them has reported carries only that one: a provider's
 * latency is never a zero (doc 21), and the surface reading the number says so
 * where it is read.
 */
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
 * TWO PROVIDERS AS ONE MEASUREMENT — the desk states clicks, not Google's
 * clicks.
 *
 * IT LIVES IN THE SHARED CONTRACT RATHER THAN BESIDE ONE SURFACE (bead
 * `ro-78qo.35`). This exact rule is what commit `ed58223` was written to fix:
 * the asset page's strip added Google and Bing while its Growth charts read
 * Google alone, so one page printed 25,452 clicks and 16,905 clicks for the
 * same asset over the same 28 days and gave the reader no way to tell which was
 * the metric. `metricWindow` became the page's one derivation. The wall payload
 * now needs the same merge for /assets' comparison table, and a WORKER cannot
 * import a browser module — so the rule moves here, where both sides reach it,
 * rather than being typed out a second time.
 *
 * `provisionalFrom` takes the EARLIEST of the two, which is the conservative
 * side: the alternative compares a settled Bing day against a Google day still
 * being counted and calls the pair complete. `collectedAt` takes the OLDEST for
 * the same reason — a pair is only as fresh as its stalest half.
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
 * asset. The Wall's card draws one of them (active users); the asset page
 * draws all of them. A series a caller did not ask the store for stays EMPTY
 * rather than absent, so both callers read one shape and neither has to branch. */
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
  /** Search Console daily average position. LOWER IS BETTER — 1 is the top of
   * the results page — so a falling line here is an improving one, and any
   * direction indicator over it has to be inverted before it is honest. */
  searchPosition: SignalTrend;
}

/** What one asset has in flight, from the newest beads snapshot — the card's
 * present-state answer to "what is being done about this asset right now?".
 *
 * Counts EXCLUDE epic-type containers, and the exclusion happens in the poller
 * (`scripts/os-up.mjs`) because nothing downstream can do it: the stored lists
 * are truncated, so a reader holding this payload can neither find the epics in
 * a 39-item queue nor subtract them from a count that already absorbed them.
 *
 * `open` and `inProgress` are the two distinct stored-status sets. `blocked`
 * is the blocker-aware subset of `open`; `highPriority` cuts across both
 * stored statuses, and `closedRecent` looks backward. They are answers to
 * different questions and are never added indiscriminately. */
export interface WorkSummary {
  /** Not started. */
  open: number;
  /** P0+P1 across everything not closed — the urgency signal, and the reason
   * this widget exists on a card the operator only glances at.
   *
   * null = not measured by the poller that wrote this snapshot, which is not
   * the same claim as zero and never renders as one: the chip is omitted. */
  highPriority: number | null;
  inProgress: number;
  /** Subset of `open` waiting on another bead to close first. */
  blocked: number;
  /** Closed inside the poller's trailing-week window — momentum, not queue. */
  closedRecent: number;
  /** Open work per `bd` priority band, P0..P4 — the queue's SHAPE, and the one
   * field that lets the card answer "what KIND of 121 is this?" rather than
   * just "121". Index is the priority. null when the snapshot did not carry
   * one, in which case the card draws no distribution rather than a flat one it
   * made up. */
  priorities: number[] | null;
  /** When the poller photographed the hub. The widget ages itself against the
   * poller's own cadence, so a dead poller is visible on the card rather than
   * only on /work. */
  capturedAt: string;
}

/** The asset's serp-panel review obligation, as the newest beads snapshot
 * recorded it: the OPEN `panel-review` bead if there is one, else the most
 * recently closed one (bead `ro-9hx` owns writing it, `ro-rkp` reading it).
 *
 * Every date is nullable HERE and only here. The writer always sends them, but
 * this row outlives the poller that wrote it, and a reader that requires a field
 * goes dark exactly when someone changes the writer. A date that did not arrive
 * costs the card its precision, never its whole badge — see `panelReviewState`,
 * where an unreadable `dueAt` yields the quiet state rather than an invented
 * accusation of lateness. */
export interface PanelReview {
  /** The bead in the asset's own spoke — the thing to go and close. */
  beadId: string;
  /** WHICH PANEL DAY this review is about ('YYYY-MM-DD', the archive's
   * `report_date`). This — not the close timestamp — is what decides whether a
   * finished review still covers the newest panel; see `panelReviewState`. */
  panelDate: string | null;
  /** When triage is due: seven days after the landing. */
  dueAt: string | null;
  status: "open" | "closed";
  /** When it was closed. Absent on an open bead, and absent on a closed one
   * written by a poller that did not record it. */
  closedAt: string | null;
  /** Whether this asset buys a tracked SERP panel — a `config/serp-panel.json`
   * entry, the same key set the collector gates the sixth report family on.
   *
   * NOT part of the obligation, and it does not change one: since `ro-478` every
   * collecting asset owes the weekly read, panel or no panel. It decides one
   * thing only — the NOUN the marker states the obligation in (`panelReviewNouns`
   * below), so the Tower says what the bead in the asset's own spoke says.
   * The builders attach it from config; the beads snapshot never carries it,
   * because the hub has no opinion about what the operator bought. */
  panel: boolean;
}

/** The words a review marker is allowed to use, chosen by whether the asset
 * has a panel at all (bead `ro-z0g`).
 *
 * The runner has spoken with two nouns since `ro-478`: `panelReviewTitle` in
 * `scripts/runner/panel-review.mjs` titles a panel asset's bead "Triage the … serp panel
 * for …" and a panel-less one's "Triage the … signal collection for …". The
 * Tower assumed the first for everyone, so an asset that collects the five
 * report families a week and buys no panel carried a marker naming a tracked
 * SERP panel it does not have. A board and the bead it points at must describe one obligation in one
 * vocabulary, and the wrong one here named a thing the operator never bought.
 *
 * The panel wording is byte-identical to what shipped, so a panel asset's
 * marker is untouched; only the second form is new.
 */
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

/** What an asset card says about its panel review, at a glance.
 *
 * `none` renders NOTHING — no badge, no dash, no empty state. An asset that
 * has landed no collection inside the window owes no read, and a marker on
 * every such card explaining that it has nothing to review would be noise on
 * the whole Wall to say nothing about any of it. */
export type PanelReviewState = "none" | "pending" | "overdue" | "reviewed";

/** Epoch ms, or null when the string is absent or not a date. */
function instantOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * The one rule behind the panel-review badge (bead `ro-rkp`).
 *
 * The question the card answers is about the PANEL, not about the bead: has the
 * newest tracked-SERP collection been triaged? So a finished review is matched
 * against the newest panel DAY in the archive, and a review about an older day
 * does not cover the newer one — it goes back to `pending`, because the
 * operator's obligation is outstanding again even though the bead for it has
 * not been filed yet (the runner lane files on its own cadence, and the poller
 * photographs the hub a minute later). Claiming `reviewed` there would be the
 * exact failure this bead exists to stop: a panel nobody read, on a card that
 * says it was read.
 *
 * PANEL DAY, not close time, and the difference is a real bug rather than a
 * preference (ro-9hx, 2026-08-02). Panel A lands Monday, panel B lands the
 * following Monday, and the operator finally closes A's review on Tuesday: the
 * close is newer than B's arrival while covering none of it. Comparing
 * `panelDate` to the landing's own `report_date` asks what the review was
 * actually about. It is also the only comparison a backfill cannot fool — a
 * re-archived older panel writes a later `finished_at` than a newer panel's.
 *
 * `pending` is where every degraded input lands. A closed review with no
 * `closedAt` or no `panelDate`, an open one whose `dueAt` is unreadable — all
 * quiet, none of them `overdue`. Overdue is the error-toned state, and the OS
 * only escalates to it off a deadline it can actually read.
 *
 * The boundary is `>`, matching `isAmber`: the badge turns at the first
 * millisecond PAST the deadline, so a review looked at exactly on time is on
 * time.
 */
export function panelReviewState(
  review: PanelReview | null | undefined,
  latestPanelDate: string | null,
  nowMs: number,
): PanelReviewState {
  if (!review) return "none";

  if (review.status === "closed") {
    // The age the badge counts from. Without it there is a finished review
    // nobody can date, which is not a `reviewed` anyone should be reassured by.
    if (instantOf(review.closedAt) === null) return "pending";
    const landed = instantOf(latestPanelDate);
    // No readable landing: nothing contradicts the close, so the close stands.
    if (landed === null) return "reviewed";
    const covered = instantOf(review.panelDate);
    // A review that cannot name its own panel day cannot be shown to cover the
    // newest one either.
    if (covered === null) return "pending";
    return covered >= landed ? "reviewed" : "pending";
  }

  const dueAt = instantOf(review.dueAt);
  if (dueAt === null) return "pending";
  return nowMs > dueAt ? "overdue" : "pending";
}

/**
 * WHICH panel day the marker is about (bead `ro-elf`).
 *
 * On a pending or overdue review that is the newest day collected — the one
 * waiting to be triaged. On a review that closed against an older day it is the
 * NEWER day that put the obligation back, which is the fact the operator needs
 * rather than the one they already dealt with. Only a `reviewed` marker names
 * the review's own day, because there it is the day that was actually read.
 *
 * A derivation rather than a line inside the badge, because the card renders the
 * badge and the asset page states the same day in words beside it: two
 * copies of this fallback chain is exactly how one surface starts naming a
 * different day than the marker next to it.
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

/** One ASSETS-band card. Order is FIXED (seed order) — never sorted. */
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
  /** This asset's RECONCILED current rows for `netPeriod` — the same split
   * the PORTFOLIO band leads with (bead `ro-uwo.2`), one grain down. The card
   * used to carry a single `netThisMonth` summed over every current row
   * regardless of booking state, so a Wall showing a booked headline sat
   * directly above asset nets that included estimates and could not add up
   * to it. Three zeroes = nothing reconciled this period, never a null. */
  booked: LedgerFigure;
  /** This asset's ESTIMATED current rows for `netPeriod` — reported, not
   * reconciled. Labelled as forecast on the card, never added to `booked`. */
  forecast: LedgerFigure;
  /** The accounting period `booked` and `forecast` cover ('YYYY-MM'), so the
   * card can name the month it is quoting without ambient context. */
  netPeriod: string;
  /** received_at of this asset's latest pulse (report-freshness sentence). */
  pulseReceivedAt: string | null;
  /** The operator declared that this asset sends no nightly report
   * (config/constants.json `no_nightly_report`, bead `ro-ujb9.96.8`). Whether a
   * report is expected is `expectsNightlyReport(noNightlyReport,
   * pulseReceivedAt)`: never while declared, and otherwise only once one has
   * arrived. Absent on an older payload, which means not declared. */
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
   * Organic web-search clicks, GOOGLE AND BING READ AS ONE MEASUREMENT
   * (`mergeSignalTrends` above, bead `ro-78qo.35`).
   *
   * Not `WebSearchTrends`. A comparison table states clicks; it does not state
   * Google's clicks beside Bing's and leave the reader to add them, and a
   * surface that merged them in one column while another read Google alone is
   * the exact defect `ed58223` was written to remove. The two providers'
   * identities belong to a chart with a legend — the asset page's Growth pair,
   * which still draws a line each — and not to a 96px cell.
   *
   * ITS DATE HORIZON IS THE UNION OF THE TWO, so it can run a few days wider
   * than `activeUsers` at both ends — Bing trails Google, and each provider
   * keeps its own window. Those edge days carry one provider's value alone,
   * which is the rule, not a defect: a provider's latency is never a zero. A
   * reader windowing by DATE (`windowSeries`) gets the range it asked for
   * either way; a reader counting points would not.
   *
   * Empty on every asset that has neither provider wired, which is a designed
   * state and never a zero.
   */
  searchClicks: SignalTrend;
  /**
   * This asset's net, month by month, over every month the ledger holds a
   * current row for it — ascending (bead `ro-78qo.35`).
   *
   * The same two-tier read `/financials` makes for ONE period, taken over all
   * of them: revenue minus this asset's DIRECT cost, superseded rows excluded,
   * portfolio overhead allocated to nobody. It comes off the same grouping the
   * financials payload's by-asset table is built from — one derivation, two
   * payloads — so the Wall, /assets and /financials cannot disagree about a
   * asset's month.
   *
   * MONTHLY GRAIN, so the open month is provisional at `YYYY-MM` and not at a
   * day. A month this asset booked nothing in is a HOLE (`v: null`) on an
   * otherwise unbroken axis, never a zero and never an omission: "nothing was
   * recorded" and "it earned nothing" are different facts, and a sparkline that
   * simply joined the months it was handed would draw March next to July as
   * though they were consecutive (bead `ro-78qo.37`).
   */
  netByMonth: SeriesPointOrGap[];
  netByMonthCurrency: string | null;
  /** The month the store is standing in (`YYYY-MM`), or null when the ledger
   * holds nothing — the boundary `netByMonth`'s last point is provisional from,
   * carried beside it so no reader has to derive it from a clock of its own. */
  netByMonthProvisionalFrom: string | null;
  /** This asset's open work, or null when the snapshot cannot answer for it:
   * none filed yet, the poller could not read that repo, the asset has no
   * beads project, or the newest row predates type-aware counts. The Sites
   * table then says it has no work data — never zeros, which would claim an
   * empty queue. */
  work: WorkSummary | null;
  /** This asset's weekly review obligation, or null — which renders as
   * nothing at all. null covers three different absences on purpose, because
   * the card's answer to all three is identical: no DataForSEO collection has
   * landed for this asset inside `PANEL_LANDING_WINDOW_DAYS`, or the newest
   * snapshot carries no `panelReview` for it (nothing filed yet), or that
   * snapshot predates the field entirely. Having no `config/serp-panel.json`
   * entry is NOT one of them since `ro-1tu`: such an asset still collects,
   * still owes the read, and states it in its own noun (`panelReviewNouns`). */
  panelReview: PanelReview | null;
  /** The newest panel DAY collected for this asset ('YYYY-MM-DD', the
   * `report_date` of its latest dataforseo/serp-panel report run) —
   * the day a finished review has to be about for it to still count. Two
   * manifest rows for one panel day are one landing, which is why this is the
   * day and not a write timestamp. null when none has ever landed, or when the
   * asset has no panel. */
  latestPanelDate: string | null;
}

/**
 * Does this asset have money to state for `netPeriod`? (bead `ro-uwo.2`)
 *
 * The same stance `portfolioHasData` takes, at card grain: the accounting block
 * is money and nothing else, so with neither side carrying any there is no
 * block — not a zero, and not a row explaining its own emptiness. What it does
 * NOT hide is the card itself: an asset is a great deal more than its ledger
 * (counters, charts, open work), so absence here removes one block, never the
 * asset.
 *
 * `figureHasMoney` decides each side, so a reconciled $0 somebody confirmed
 * (revenue 100, cost 100) still shows — a confirmed zero is a fact.
 */
export function cardHasMoney(card: Pick<AssetCard, "booked" | "forecast">): boolean {
  return figureHasMoney(card.booked) || figureHasMoney(card.forecast);
}

/** One ATTENTION-band line: an open error/warn flag.
 *
 * The row carries FACTS, not the sentence: `ruleId` + `ruleInputs` + `metric` +
 * the rule's raw `message` are what the store holds, and `translateAlert`
 * (shared/alert-language) turns them into the operator's headline at render
 * time. The payload never ships prose it would then have to keep in sync with
 * the detail page's — one translator serves both surfaces. */
/**
 * Rules whose repeated firings are ONE ONGOING CONDITION, not N events
 * (`ro-kukv.1`).
 *
 * Measured on the live store 2026-08-31: of 26 open error/warn flags, SIXTEEN
 * were `asset-declared` on one asset, one per night from 2026-08-04 to 2026-08-31,
 * every one reading "Api requests well below normal — N vs ~X/day" with only the
 * numbers different. They do not tell the operator sixteen things; they tell him
 * one thing sixteen times, and they push the other ten conditions off the
 * screen.
 *
 * WHY A DECLARED LIST RATHER THAN A GENERAL RULE. The obvious key —
 * (asset, rule_id, metric) — is WRONG, and the live store proves it:
 * `watch-window-closed` fires twice on one asset with metric `position`, but
 * each firing carries a different `watchWindowId` and asks for a different
 * decision. Collapsing those would hide a decision, which is strictly worse than
 * the noise this exists to remove.
 *
 * So grouping is opt-in and the default is today's behaviour. An undeclared rule
 * renders one row per firing — noisy, but it can never merge two decisions into
 * one. A rule earns a place here by being a THRESHOLD RE-EVALUATED ON A
 * SCHEDULE, where each firing re-states one standing condition against a fresh
 * reading and carries no subject of its own.
 */
export const RECURRING_CONDITION_RULES: ReadonlySet<string> = new Set([
  // Nightly pulse threshold: "this metric is below its own baseline", re-read
  // every night for as long as it stays true.
  "asset-declared",
  // Same shape, Poisson floor rather than a ratio.
  "flow-poisson-low",
]);

/** The columns a flag row must carry to be grouped into a condition. Both
 * payload builders' row shapes satisfy it; neither has to hand over its whole
 * row type to do so. */
export interface ConditionFiring {
  /** flags.id — the identity an undeclared rule's group is keyed by. */
  id: number;
  asset: string;
  ruleId: string;
  metric: string | null;
  firedAt: string;
}

/** One condition's open firings, as counted for BOTH surfaces. */
export interface ConditionGroup<F extends ConditionFiring> {
  /** The firing that stands for the group: the FIRST row in caller order.
   * Both builders read severity-first then `fired_at DESC`, so it is the newest
   * reading — the numbers an operator would act on. */
  latest: F;
  /** Every open firing of this condition, in caller order. */
  firings: F[];
  /** `firings.length` — 1 for an ordinary event. */
  occurrences: number;
  /** The ONSET: a condition is as old as it has been true, not as old as its
   * most recent re-reading. */
  firstFiredAt: string;
}

/**
 * Collapse open firings into conditions — the ONE derivation behind both the
 * Wall's attention list and the asset page's Current signals (`ro-kukv.5`).
 *
 * It exists as a shared function rather than as two loops because the two
 * surfaces had already disagreed about the same store: `ro-kukv.1` grouped the
 * Wall and left the asset page reading `flags.open` per firing, so one asset's
 * `asset-declared` condition was one row saying "16× in 26d" on one screen and
 * sixteen rows on the other. An operator moving between them saw two different
 * portfolios.
 *
 * The key is (asset, rule_id, metric) for a declared rule and the flag's own id
 * for everything else — so an undeclared rule's firings land in groups of one
 * with no special case, and can never merge two decisions into one. See
 * {@link RECURRING_CONDITION_RULES} for why the obvious key is unsafe.
 *
 * It is also the key `applyFlagAction` re-derives in SQL, which is what lets the
 * Mark read / Resolve pair under a grouped row mean what the row says.
 *
 * ORDER IS THE CALLER'S. The representative is `firings[0]`, so a caller decides
 * which firing speaks for the condition by how it sorts its query; both builders
 * sort severity then `fired_at DESC`. Groups come back in first-seen order, so a
 * caller's severity ordering survives the grouping.
 */
export function groupConditionFirings<F extends ConditionFiring>(
  rows: readonly F[],
): ConditionGroup<F>[] {
  const groups = new Map<string, F[]>();
  for (const row of rows) {
    // NUL joins the parts: no asset id, rule id or metric can contain one, so
    // no field's contents can forge another's boundary and merge two conditions
    // that are not the same one.
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

/** One asset inside a cross-asset attention group (`ro-kukv.6`).
 *
 * It carries its OWN flag id on purpose: the group is a way of saying one fact
 * once, never a way of merging four decisions into one. Mark read / Resolve
 * under an expanded member act on that member's flag and nothing else. */
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
  /** Timeline events on this asset in the 48h BEFORE the condition STARTED
   * (`firstFiredAt`). [] when nothing correlates, which renders nothing at all
   * (absence is the answer).
   *
   * The window is anchored to the first firing rather than the newest because
   * the useful question about a month-old condition is what happened when it
   * BEGAN. Correlating against tonight's re-reading would search the 48h before
   * a routine re-evaluation and reliably find nothing. */
  correlatedChanges: AnnotationItem[];
  /**
   * How many OPEN firings this row stands for — 1 for an ordinary event.
   *
   * Only rules in {@link RECURRING_CONDITION_RULES} ever exceed 1. The number is
   * load-bearing rather than decorative: "firing nightly for four weeks" and
   * "fired twice this week" are different situations that a per-firing band
   * renders identically, and the operator has to be able to tell them apart
   * without reading.
   */
  occurrences: number;
  /** When this condition FIRST fired. Equals `firedAt` when `occurrences` is 1,
   * and is what the row ages from — a condition is as old as its onset, not as
   * old as its most recent re-reading. */
  firstFiredAt: string;
  /** Tasks filed from this condition's flag numbers in the latest hub snapshot.
   * Absent when the project or this snapshot field could not be read. */
  handoffBeads?: import('./asset-detail').HandoffBead[];
  verification?: SignalVerification;
  /** The ASSETS this row stands for, when one fact is true of several of them
   * at once (`ro-kukv.6`, decision D15). Absent on every ordinary row, and
   * absent on a group of one — a single asset renders exactly as it always did.
   *
   * Retained grouped alert payloads use this field. The surfaces read the
   * PRESENCE of this field, not the rule id, so a second cross-asset fact can
   * join without teaching every component a new special case. */
  members?: AttentionMember[];
  /** This condition's stored readings, newest first (`flag_evidence`, db/0040,
   * bead `ro-ujb9.220`); absent when it has none or the store predates them. */
  readings?: FlagReading[];
}

/**
 * A condition the operator parked, with the date it comes back (`ro-c7qq`).
 *
 * It is an `AttentionItem` and not a shape of its own because it IS one — the
 * same condition, the same grouping, the same translated headline — minus the
 * demand for attention until `snoozeUntil`. A parallel type would be the first
 * step towards a second alert vocabulary.
 *
 * The list exists so a snooze is never a silent hide: `/alerts` renders it
 * under its own heading with an Unsnooze on each row. Its scope is therefore
 * WIDER than the open list's error/warn (`ro-w13s`): Snooze is offered on every
 * open row of the asset page's state hero, info and milestone included, so a
 * ledger that dropped those would hide exactly the rows the operator silenced
 * and could no longer find. Nothing about the portfolio's COUNTS changes —
 * `attention`, the asset cards' openError/openWarn and worstSeverity all keep
 * the error/warn scope `worker/flag-scope.ts` defines.
 */
export interface SnoozedItem extends AttentionItem {
  /** flags.snooze_until — when this condition returns to the open lists. The
   * LATEST of the group's firings: the row is quiet until its last member is. */
  snoozeUntil: string;
}

/** The human-intervention half of the Wall's fixed attention horizon.
 *
 * `waiting` is the sum the newest beads snapshot could actually measure. It is
 * paired with explicit coverage so a partial read renders `N+` rather than an
 * exact-looking lie. `urgent` has its own coverage because it arrived one
 * writer generation later. Zero can only render as calm when every
 * photographed project supplied the total; a missing snapshot is 0/0 coverage
 * — unknown, never "nobody needs you". */
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
 * `WALL_PAYLOAD_INVENTORY` (shared/materiality.ts), and a field no screen
 * draws is not computed (bead `ro-trai.44`). */
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
   * Never merged into `attention`: a snoozed row is not asking for anything
   * yet, and one list holding both would put the count back where the operator
   * cannot read it. */
  snoozed: SnoozedItem[];
  /** Actionable human-labelled beads + open human gates, across the core hub.
   * A legacy null is an unread inbox; current writers supply explicit coverage. */
  operator: OperatorPosture | null;
  /** Latest ledger recorded_at: how old the ledger is. The MCP `list_properties`
   * tool hands it to agents beside the portfolio (worker/mcp-route.ts). */
  ledgerRecordedAt: string | null;
}

/** Expected data cadence per lane, in hours. Age badges turn amber past
 * `AMBER_MULTIPLIER`× these (doc 10). Pulses are nightly; the ledger reconciles
 * roughly monthly, so its lane tolerates a much longer gap before it reads stale. */
export const CADENCE_HOURS = {
  /** The nightly report lane, straight from the contract — the same cadence the
   * ingest freshness cron ages a report against, so the badge on a card and the
   * flag in ATTENTION cannot describe one asset differently (ro-uwo.1). */
  pulse: REPORT_CADENCE_HOURS,
  /** GA4 + GSC share the 15-minute Sense cron. An hour-scale fallback would
   * leave a dead collector looking healthy for days. */
  signals: INTEGRATION_CADENCE_HOURS.signals,
  /** Bing publishes this traffic dataset daily; pulling faster only duplicates
   * snapshots and spends provider capacity without fresher values. */
  bingSignals: INTEGRATION_CADENCE_HOURS.bingSignals,
  /** DataForSEO provider datasets are archived once per week. */
  dataforseoSignals: INTEGRATION_CADENCE_HOURS.dataforseoSignals,
  /** PostHog product analytics families are archived once a day at 12:30 UTC. */
  posthogSignals: INTEGRATION_CADENCE_HOURS.posthogSignals,
  /** Clarity's export makes one call per project a day at 04:30 UTC — the same
   * one-day obligation the ingest's own health read holds it to (bead
   * `ro-at7t`). */
  claritySignals: 24,
  /** Served-layer hygiene checks run once nightly at 04:00 UTC. */
  hygiene: 24,
  /** The home-page check runs again every hour as the site's uptime (the
   * ingest's hourly tick, `runUptimeChecks`, bead `ro-ujb9.165`). */
  uptime: 1,
  ledger: 24 * 31,
} as const;

/** Doc 10 principle 2's one rule for every lane — and, for the report lane, the
 * contract's own `REPORT_STALE_MULTIPLIER`. Held to the contract deliberately:
 * `CADENCE_HOURS.pulse × AMBER_MULTIPLIER` is what the coverage count and every
 * pulse age badge measure staleness at, so it must stay the very number the
 * ingest cron flags at rather than a second 2 that happens to match. */
export const AMBER_MULTIPLIER = REPORT_STALE_MULTIPLIER;
