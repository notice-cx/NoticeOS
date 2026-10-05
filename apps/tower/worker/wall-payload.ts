import { moneyFigure, minorToMajorUnits, moneyCurrency } from '@noticeos/contract/money';
import { loadIntegrationEvidence, serpPanelAssets } from './integration-evidence';
// Wall payload assembly — the one read the Tower makes over the central store.
// Every band's data is derived here from the Phase-0 tables (assets, pulses,
// flags, ledger). Pure over the call's Postgres store; tests exercise this
// exact SQL against isolated real Postgres. Ledger reconciliation semantics (db/README):
// a row is CURRENT when nothing supersedes it; net = revenue − cost over the
// current rows for a period.

import { assetDisplayName } from "@noticeos/contract/asset-name";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { readSites } from "./asset-registry";
import { openFlagsSql, snoozedFlagsSql } from "./flag-scope";
import { countAttentionConditions, reviewAlertConditions } from "./alert-evidence";
import { readFlagReadings, readingsOf } from "./flag-evidence";
import { isAttentionEligible } from "../shared/signal-liveness";
import type { PullConfigEntry, SerpPanelConfig } from "./asset-config";
import { loadDataForSeoSpend } from "./metered-spend";
import { alertHandoffsOf, type BeadsSnapshot, loadLatestBeadsSnapshot } from "./beads-snapshot";
import { beadsReading } from "./task-source";
import { readLatestJobRuns } from "./job-runs";
import { cardPanelReviewsOf, loadLatestPanelLandings } from "./panel-review";
import {
  WALL_SIGNAL_CHART_DAYS,
  emptySignalTrendSet,
  loadSignalTrends,
} from "./signal-trends";
import { cents, loadAssetMonths, monthDate } from "./ledger-history";
import { flagDbRow } from "./flag-records";
import { readPulseCoverage } from "./pulse-history";
import { countersCadenceHours, readCounterReadings, readLatestCounterTotals, resolveWallCounters, type CountersConfig } from "./counters";
import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import { projectRevenue, REVENUE_HISTORY_DAYS, type RevenueDay } from '../shared/revenue-projection';
import { revenueHolidays } from './revenue-holidays';
import { MEDIAVINE_REPORTING_CLOCK, revenueCalendarDate, yesterdayRevenue } from '../shared/daily-revenue';
import {
  releasedFreshnessFlag,
  reportingState,
  summarizeReporting,
} from "@noticeos/contract";
import { CORRELATION_WINDOW_HOURS, correlateChanges } from "../shared/alert-language";
import type { AnnotationItem, AnnotationKind } from "../shared/annotations";
import type { IntegrationsConfig } from "../shared/integrations";
import type { DashboardConfig } from "../shared/dashboard";
import {
  AMBER_MULTIPLIER,
  CADENCE_HOURS,
  mergeSignalTrends,
  type AssetCard,
  type AttentionItem,
  type BookedDelta,
  type FlagKind,
  type LedgerFigure,
  type LedgerResidue,
  type PortfolioBand,
  type Severity,
  type SignalTrendSet,
  type SnoozedItem,
  type SystemBand,
  type WallPayload,
  type WorkSummary,
} from "../shared/wall";

/** The tunables the SYSTEM band needs, sourced from config/constants.json. */
export interface WallConstants {
  /** monthly_caps.data_usd — the portfolio's only monthly ceiling since the
   * inference cap was withdrawn (D6, bead `ro-uj7x`). The strip's "over the
   * daily data pace" reads the day's share of it. */
  dataUsd: number;
}

export interface BuildOptions {
  now: Date;
  constants: WallConstants;
  /** Same declared register and pull schedule used by /api/integrations. The
   * card source strip consumes the shared effective-state helpers. */
  integrations: IntegrationsConfig;
  pullConfig: PullConfigEntry[];
  /** config/tower.json, injected into the Worker at build time. */
  dashboard: DashboardConfig;
  /** config/serp-panel.json — which assets have a tracked SERP panel at
   * all. The Tower reads only the key set: the queries are the collector's
   * business, but an asset absent from this file owes no panel review, and
   * its card must therefore say nothing rather than nothing-yet. */
  serpPanel: SerpPanelConfig;
  /** The operator's clock: config/constants.json `os_time_zone` as SAVED,
   * resolved store first (bead `ro-ujb9.88`). It decides the open month, each
   * card's "yesterday" and the projection's month, so none of them may keep
   * the zone of the last build after a Settings save. */
  osTimeZone: string;
  /** config/constants.json `no_nightly_report` as SAVED (bead `ro-ujb9.96.8`):
   * the assets declared as sending no nightly report. None is owed, so each is
   * outside the SYSTEM card's denominator, carries no freshness alert, and its
   * card shows "No report". Absent or null declares none. */
  noNightlyReport?: readonly string[] | null;
  counters?: CountersConfig;
  schedules?: ScheduleOverrides | null;
}

const MS_PER_DAY = 86_400_000;

/** One (asset, booking state) money total for the shown period, in integer
 * cents — the single row shape both the PORTFOLIO headline and every asset
 * card are derived from. */
interface LedgerStateRow {
  currency: string;
  asset: string;
  bookingState: string;
  revenueMinor: number;
  costMinor: number;
  revenueRecorded: boolean;
}

type AttentionRow = {
  id: number;
  pulseId: number | null;
  asset: string;
  assetDisplayName: string;
  assetIsOs: number;
  severity: string;
  kind: string;
  message: string | null;
  firedAt: string;
  metric: string | null;
  ruleId: string;
  ruleInputs: string | null;
};

/** An attention row plus the date its silence ends. */
type SnoozedRow = AttentionRow & {
  snoozeUntil: string;
};

/** The alert columns the Wall reads from `noticeos.current_flags` joined with
 * its site (bead ro-ujb9.76.5.2): the workspace's number, the day's report
 * number, the newest reading. */
const ATTENTION_COLUMNS = `f.flag_number::int AS id, f.pulse_day_number::int AS "pulseId", f.asset_id AS asset,
                a.display_name AS "assetDisplayName", (CASE WHEN a.is_os THEN 1 ELSE 0 END) AS "assetIsOs",
                f.severity, f.kind, f.message, f.fired_at AS "firedAt", f.metric,
                f.rule_id AS "ruleId", f.rule_inputs::text AS "ruleInputs"`;

/** A flag row with its asset named the way every surface names it: the OS's
 * own row by the product (bead `ro-ujb9.77.10`). */
function namedFlagRow<T extends AttentionRow>(row: T): T {
  return { ...row, assetDisplayName: assetDisplayName(row.assetIsOs, row.assetDisplayName) };
}

interface AnnotationRow extends Record<string, unknown> {
  id: number;
  asset: string;
  at: string;
  kind: string;
  ref: string | null;
  note: string | null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function severityFromRank(rank: number): Severity | null {
  if (rank >= 3) return "error";
  if (rank === 2) return "warn";
  if (rank === 1) return "info";
  return null;
}

function daysInMonthUTC(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The changes filed in a window, every site's, newest first. On Postgres (bead
 * ro-ujb9.76.5.7): one bounded seek per site down its (site, time) index, as
 * the feed reads (`OFFSET 0` keeps each site's read its own, where Postgres
 * would flatten it into one pass over every site's changes); a change is known
 * by its workspace's number, and two at one instant come newest-filed first,
 * as D1's index gave them.
 */
export const WALL_CHANGES_SQL = `SELECT n.annotation_number::int AS id, a.asset_id AS asset, n.at, n.kind, n.ref, n.note
  FROM noticeos.assets a
  CROSS JOIN LATERAL (
    SELECT c.annotation_number, c.at, c.kind, c.ref, c.note
      FROM noticeos.annotations c
     WHERE c.workspace_id = a.workspace_id AND c.asset_id = a.asset_id
       AND c.at >= $1::timestamptz AND c.at <= $2::timestamptz
    OFFSET 0) n
 ORDER BY n.at DESC, n.annotation_number DESC`;

/**
 * Annotations that could correlate with any of `firedAts`, grouped by asset.
 * Reads once from the earliest alert's window start — every alert's window is
 * the same width, so that bound covers all of them — and returns an empty map
 * when there are no alerts, so a quiet portfolio costs no query at all.
 */
async function readChangesForAlerts(
  store: WorkspaceStore,
  firedAts: string[],
): Promise<Map<string, AnnotationItem[]>> {
  const out = new Map<string, AnnotationItem[]>();
  const times = firedAts.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return out;

  const from = new Date(Math.min(...times) - CORRELATION_WINDOW_HOURS * 3_600_000).toISOString();
  const to = new Date(Math.max(...times)).toISOString();
  const rows = await store.read((tx) => tx.query<AnnotationRow>(WALL_CHANGES_SQL, [from, to]));

  for (const r of rows) {
    const list = out.get(r.asset) ?? [];
    list.push({ id: r.id, at: javascriptInstant(r.at), kind: r.kind as AnnotationKind, ref: r.ref, note: r.note });
    out.set(r.asset, list);
  }
  return out;
}

/**
 * Each asset's open work, keyed by asset id — the Sites table's Tasks column —
 * from one photograph of the hub, so the payload takes the queue counts and
 * the panel-review beads off the same row: two reads could land either side of
 * a poller write and put a site's work and its review obligation in different
 * minutes.
 *
 * It is the same newest snapshot the Tasks page reads (`./beads-snapshot`),
 * and answers for an asset only when that snapshot can honestly answer:
 *
 *   - a project the poller could not read (`ok: false`) is ABSENT, not zeroed,
 *     because "we could not look" and "there is nothing to do" are different
 *     facts and only one of them is good news;
 *   - an asset with no entry at all (no beads project in config/beads.json)
 *     simply never lands in the map.
 *
 * Both become `work: null` on the card, which renders as a quiet "no work data"
 * line. There is no path here that produces a zero the store did not observe.
 *
 * A count the poller did not measure travels as null and is dropped one chip at
 * a time rather than costing the asset its whole widget — a snapshot written
 * by a poller one generation behind still knows how much is open, and saying
 * nothing about all of it because one field is missing would be its own kind of
 * dishonesty (see the skew rule in workers/ingest/src/beads-snapshots.ts).
 */
export function cardWorkOf(snapshot: BeadsSnapshot | null): Map<string, WorkSummary> {
  const out = new Map<string, WorkSummary>();
  if (!snapshot) return out;
  for (const project of snapshot.projects) {
    if (!project.ok) continue;
    const { open, highPriority, inProgress, blocked, closedRecent } = project.counts;
    out.set(project.asset, {
      open,
      highPriority,
      inProgress,
      blocked,
      closedRecent,
      priorities: project.priorities,
      capturedAt: snapshot.capturedAt,
    });
  }
  return out;
}

export async function buildWallPayload(
  /** The call's store, which every read below takes. */
  store: WorkspaceStore,
  {
    now,
    constants,
    integrations,
    pullConfig,
    dashboard,
    serpPanel,
    osTimeZone,
    noNightlyReport,
    counters,
    schedules,
  }: BuildOptions,
): Promise<WallPayload> {
  const nowMs = now.getTime();
  /** Who owes no nightly report — one set, read by the coverage, the alert
   * list and every card below, so they cannot disagree about one asset. */
  const declaredNoReport = new Set(noNightlyReport ?? []);
  /** The one instant every flag query below binds. "Open" depends on the clock
   * since snooze arrived (`worker/flag-scope.ts`), and a payload that read it
   * twice could count a condition in the open list and in the snoozed one. */
  const nowIso = now.toISOString();
  /** The calendar month the operator is standing in — what "still open" means
   * anywhere below. The money blocks pick their own period (see `ro-bdkp`
   * further down); this is the one that follows the clock.
   *
   * THE OPERATOR'S clock, not UTC's (bead `ro-ujb9.88`). It was the UTC month,
   * so for the last hours of every month west of Greenwich the money card
   * already stood in the next month while the ledger and /financials (which
   * read the operator's zone) still stood in this one. Provider reports and
   * their projection keep the provider's separate clock (D42). */
  const operatorToday = revenueCalendarDate(now, osTimeZone);
  const revenueToday = revenueCalendarDate(now, MEDIAVINE_REPORTING_CLOCK.timeZone);
  const currentPeriod = operatorToday.slice(0, 7);

  // --- assets (by their place in the list; the System to SYSTEM, rest to cards) -
  const assetRows = (await readSites(store)).map((row) => ({
    id: row.id,
    displayName: assetDisplayName(row.isOs, row.displayName),
    status: row.status,
    senseOnly: row.senseOnly,
    isOs: row.isOs,
  }));

  const osAsset = assetRows.find((a) => a.isOs === 1) ?? null;
  const cardAssets = assetRows.filter((a) => a.isOs !== 1);

  // --- PORTFOLIO + per-asset P&L: reconciled and estimated kept APART --------
  // ONE grouped read for both grains (bead `ro-uwo.2`). The headline is the sum
  // of exactly the rows the cards state, so the two surfaces cannot disagree:
  // there is a single query, a single filter, and a single split. The per-asset
  // net used to come from a second query with no booking_state at all, which is
  // how the Wall came to sit booked money above asset nets full of estimates
  // — doc 19 finding 4, one grain down.
  //
  // Summed in `amount_minor` (integer cents, db/0018) and divided once, at the
  // end, per figure. Adding REAL dollars — or dividing per asset and adding the
  // quotients — leaves a headline nobody can prove to the cent.
  //
  // WHICH MONTH THEY DESCRIBE (bead `ro-bdkp`). Both grains used to read the
  // current calendar month and nothing else. Every row in this ledger arrives by
  // import or by hand, so the first days of a month hold none — on 2026-09-04
  // the store held June–August and nothing for September, `portfolioHasData`
  // went false, and the surface D13 says must LEAD WITH MONEY led with nothing
  // for four days. That repeats every month, forever, until something books.
  //
  // The rule is one line: the latest period, not in the future, that has any
  // current row. The current month wins the moment it has one, so the other 26
  // days of the month are byte-identical to before; with no rows at all it
  // stays the current month and the band still hides itself. Booking state is
  // deliberately not part of the test — D13's headline is cost-led, so a month
  // holding only cost rows is money and still leads.
  //
  // ONE choice, fed to BOTH the band and the cards, so `ro-uwo.2`'s invariant
  // (the cards add up to the headline) survives the fallback. And the shift is
  // never silent: `periodIsCurrent` ships beside it and the card names the
  // month, so a September glance can never be read as September's money.
  // The ledger is on Postgres (bead ro-ujb9.76.6.1): every money read below is
  // of the view that holds only current entries (`./ledger-history`).
  const latestLedgerPeriod =
    (
      await store.read((tx) =>
        tx.query<{ period: string | null }>(
          `SELECT to_char(MAX(period_month), 'YYYY-MM') AS period
             FROM noticeos.financial_ledger
            WHERE period_month <= $1::date`,
          [monthDate(currentPeriod)],
        ),
      )
    )[0]?.period ?? null;
  const period = latestLedgerPeriod ?? currentPeriod;
  const periodIsCurrent = period === currentPeriod;

  const ledgerRows: LedgerStateRow[] = (
    await store.read((tx) =>
      tx.query<{ asset: string; bookingState: string; currency: string; revenueMinor: bigint; costMinor: bigint; revenueRecorded: boolean }>(
        `SELECT asset_id AS asset, booking_state AS "bookingState", currency,
                BOOL_OR(kind = 'revenue') AS "revenueRecorded",
                COALESCE(SUM(CASE WHEN kind='revenue' THEN amount_minor ELSE 0 END), 0)::bigint AS "revenueMinor",
                COALESCE(SUM(CASE WHEN kind='cost'    THEN amount_minor ELSE 0 END), 0)::bigint AS "costMinor"
           FROM noticeos.financial_ledger
          WHERE period_month = $1::date
          GROUP BY asset_id, booking_state, currency`,
        [monthDate(period)],
      ),
    )
  ).map((row) => ({ ...row, revenueMinor: cents(row.revenueMinor), costMinor: cents(row.costMinor) }));

  const portfolioFigure = (bookingState: string): LedgerFigure =>
    moneyFigure(ledgerRows.filter(row => row.bookingState === bookingState),
      moneyCurrency(ledgerRows.map(row => moneyFigure([row]))) ?? 'USD');
  const assetFigure = (asset: string, bookingState: string): LedgerFigure =>
    moneyFigure(ledgerRows.filter(row => row.asset === asset && row.bookingState === bookingState),
      moneyCurrency(ledgerRows.filter(row => row.asset === asset).map(row => moneyFigure([row]))) ?? 'USD');
  /**
   * The headline minus the cards, in cents (bead `ro-t0z`).
   *
   * The headline spans EVERY asset; the cards below it exclude asset #0. So a
   * ledger row recorded against the OS itself sits inside the figure and on no
   * card, and the cards stop adding up to the number above them — the invariant
   * `ro-uwo.2` established. Nothing writes such a row today and
   * `workers/ingest/src/routes/revenue.ts` has no is_os guard, so one POST is
   * all it takes.
   *
   * Defined as the SUBTRACTION rather than as "asset #0's rows", because that is
   * what the operator's arithmetic actually leaves over: `cardAssets` is the one
   * list the cards are built from, so any future reason to omit an asset is
   * carried here automatically instead of silently reopening the gap.
   */
  const cardAssetIds = new Set(cardAssets.map((a) => a.id));
  const residueFigure = (bookingState: string): LedgerFigure =>
    moneyFigure(ledgerRows.filter(row => row.bookingState === bookingState && !cardAssetIds.has(row.asset)),
      portfolioFigure(bookingState).currency ?? 'USD');
  const booked = portfolioFigure("reconciled");
  const forecast = portfolioFigure("estimated");
  const residue: LedgerResidue = {
    booked: residueFigure("reconciled"),
    forecast: residueFigure("estimated"),
  };

  // The BOOKED trend: reconciled rows only, so the line under the headline
  // charts the same money the headline states (ledger grain is monthly).
  // Kept in MINOR units here; the delta below subtracts before anything is
  // divided, and the series divides once on the way out.
  const netByPeriodMinor = (
    await store.read((tx) =>
      tx.query<{ t: string; v: bigint; currency: string }>(
        `SELECT to_char(period_month, 'YYYY-MM') AS t, currency,
                COALESCE(SUM(CASE WHEN kind='revenue' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS v
           FROM noticeos.financial_ledger
          WHERE booking_state = 'reconciled'
          GROUP BY period_month, currency
          ORDER BY period_month ASC`,
      ),
    )
  ).map((r) => ({ t: r.t, v: cents(r.v), currency: r.currency }));

  const currencyOf = (rows: readonly { currency: string }[]): string | null =>
    rows.length && rows.every(row => row.currency === rows[0]!.currency) ? rows[0]!.currency : null;
  const netTrendCurrency = currencyOf(netByPeriodMinor);
  const netTrend = netTrendCurrency === null ? [] : netByPeriodMinor
    .map(row => ({ t: row.t, v: minorToMajorUnits(row.v, row.currency) })).slice(-12);

  // The SHAPE of the portfolio, every current row regardless of booking state.
  // The reconciled trend above is the one the headline may be charted against;
  // this one exists because a portfolio whose months are all still estimates has
  // no reconciled trend at all, and "no data" is a worse answer than an honestly
  // labelled one. It is drawn as the card's BACKGROUND — ambient shape, never a
  // figure — so it can include estimates without ever sharing a number with the
  // booked headline.
  const netTrendAllRows = (
    await store.read((tx) =>
      tx.query<{ t: string; v: bigint; currency: string }>(
        `SELECT to_char(period_month, 'YYYY-MM') AS t, currency,
                COALESCE(SUM(CASE WHEN kind='revenue' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS v
           FROM noticeos.financial_ledger
          GROUP BY period_month, currency
          ORDER BY period_month ASC`,
      ),
    )
  )
    .map(row => ({ t: row.t, v: cents(row.v), currency: row.currency }));
  const netTrendAllCurrency = currencyOf(netTrendAllRows);
  const netTrendAll = netTrendAllCurrency === null ? [] : netTrendAllRows
    .map(row => ({ t: row.t, v: minorToMajorUnits(row.v, row.currency) })).slice(-12);

  // The delta the band is allowed to state (bead `ro-7yv`). It used to be the
  // last two points of the trend above — and the last point is `period`, the
  // month still being lived in, so on the 3rd of a month the chip reported a
  // collapse that was only the calendar. doc 10 forbids exactly that pairing.
  //
  // Every month strictly BEFORE the current period is closed, so the newest two
  // of them are the like-for-like pair this grain can support; a month-to-date
  // figure for a prior month is not derivable from 'YYYY-MM' rows at all. Fewer
  // than two closed months is no delta — not a zero, not a dash: nothing.
  //
  // Read against `currentPeriod`, never against the chosen `period` (bead
  // `ro-bdkp`): "closed" is a fact about the calendar, so a headline that fell
  // back to August must not thereby declare August unclosed and drop it from
  // its own comparison.
  const closedPeriods = [...new Set(netByPeriodMinor.filter(row => row.t < currentPeriod).map(row => row.t))];
  const closedMonths = closedPeriods.map(period => {
    const rows = netByPeriodMinor.filter(row => row.t === period);
    return rows.length === 1 ? rows[0] : undefined;
  });
  const latestClosed = closedMonths.at(-1);
  const priorClosed = closedMonths.at(-2);
  const bookedDelta: BookedDelta | null =
    latestClosed && priorClosed && latestClosed.currency === priorClosed.currency
      && Number.isSafeInteger(latestClosed.v - priorClosed.v)
      ? {
          currency: latestClosed.currency,
          value: minorToMajorUnits(latestClosed.v - priorClosed.v, latestClosed.currency),
          percent:
            priorClosed.v === 0
              ? null
              : ((latestClosed.v - priorClosed.v) / Math.abs(priorClosed.v)) * 100,
          period: latestClosed.t,
          priorPeriod: priorClosed.t,
        }
      : null;

  // First-run state: portfolio stays in the empty state until a reconciled row
  // exists (doc 10). Estimated rows do not "book" P&L — and now that they ride
  // their own field, the first-run card can show them as forecast instead of
  // hiding what has been reported.
  const [reconciled] = await store.read((tx) =>
    tx.query<{ x: number }>(
      `SELECT 1 AS x FROM noticeos.financial_ledger WHERE booking_state = 'reconciled' LIMIT 1`,
    ),
  );
  const firstRun = !reconciled;

  // The earlier of the first money entry and the first site (both on Postgres).
  const [earliest] = await store.read((tx) =>
    tx.query<{ ts: string | null }>(
      `SELECT LEAST((SELECT MIN(recorded_at) FROM noticeos.financial_ledger),
                    (SELECT MIN(created_at) FROM noticeos.assets)) AS ts`,
    ),
  );
  const earliestMs = earliest?.ts ? Date.parse(javascriptInstant(earliest.ts)) : nowMs;
  const daysIn = Number.isNaN(earliestMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - earliestMs) / MS_PER_DAY));

  const portfolio: PortfolioBand = {
    period,
    periodIsCurrent,
    booked,
    forecast,
    revenueRecorded: {
      booked: ledgerRows.some(row => row.bookingState === 'reconciled' && row.revenueRecorded),
      forecast: ledgerRows.some(row => row.bookingState === 'estimated' && row.revenueRecorded),
    },
    netTrend,
    netTrendCurrency,
    netTrendAll,
    netTrendAllCurrency,
    trendGranularity: "monthly",
    bookedDelta,
    residue,
    firstRun,
    daysIn,
  };

  // --- per-asset latest pulse (freshness map + ingest coverage) --------------
  // Index seeks per asset, not a pass over every stored night (`ro-ujb9.63`,
  // `./pulse-history`). The asset page reads the same statement for one asset.
  const pulseCoverage = await readPulseCoverage(store, nowIso);
  const latestPulse = new Map([...pulseCoverage].map(([asset, c]) => [asset, c.latest]));
  // Setup reads actual coverage as well as arrival time, from this same query.
  const firstPulse = new Map([...pulseCoverage].map(([asset, c]) => [asset, c.first]));
  const reportDays = new Map([...pulseCoverage].map(([asset, c]) => [asset, c.reportDays]));
  const [counterReadings, nightlyTotals] = await Promise.all([
    readCounterReadings(store), readLatestCounterTotals(store),
  ]);
  const counterCadence = countersCadenceHours(schedules ?? null);

  // Counted over the ASSET rows, never over the pulses map (docs/19 finding 5),
  // by the rule the ingest freshness cron counts with (`owesNightlyReport`): a
  // site that has never sent a report (D29 amended, `ro-ujb9.121`) or was
  // declared as sending none owes nothing and sits outside the denominator, so
  // "N/M nightly reports fresh" counts only the reports somebody is owed.
  const ingest = summarizeReporting(
    assetRows.map((a) =>
      reportingState(
        a.status,
        latestPulse.get(a.id) ?? null,
        nowMs,
        CADENCE_HOURS.pulse * AMBER_MULTIPLIER,
        declaredNoReport.has(a.id),
      ),
    ),
  );

  // One task-hub photograph feeds every site's work, its panel review and the
  // task source's one reading (`./task-source`, D32): whether a source is
  // connected, and the Needs you counts, come off the same row.
  const beadsSnapshot = await loadLatestBeadsSnapshot(store);
  const tasks = beadsReading(store, beadsSnapshot);
  const workByAsset = cardWorkOf(beadsSnapshot);

  // --- SYSTEM: what the strip's one state and Home's System tile read -------
  // The metered data cap alone. It used to be that plus a $100/mo inference
  // ceiling nothing measured, so the pace this meter drew was partly against a
  // budget the OS could not spend (D6 amended 2026-09-05, bead `ro-uj7x`).
  const dailyCapUsd = constants.dataUsd / daysInMonthUTC(now);

  // TODAY'S METERED DATA SPEND — counted, not reported (bead `ro-sq42`).
  //
  // This used to be read out of asset #0's report envelope, from four candidate
  // metric names, and nothing in this repo ever wrote one: the row was absent on
  // every real Wall while `/integrations` was already summing the same money out
  // of the store beside it. The store is the honest door. The report runs are
  // the OS's own record of every metered call it made, so the figure is
  // arithmetic over evidence already held rather than a report nobody sends —
  // and the reader is `loadDataForSeoSpend`, the SAME function the Health page's
  // spend summary and `/settings`' budget meter call, windowed to today. A day's
  // figure here and a month's there, one sum.
  //
  // WHY THE PAYLOAD AND NOT THE ENVELOPE: the self-report is written once a day
  // and this payload is polled every minute, so a spend that arrived by envelope
  // would be up to a day stale on a meter whose whole job is pace.
  //
  // UTC days, matching `daysInMonthUTC` above: the denominator is a UTC month's
  // share, so a numerator counted on another calendar would be a ratio of two
  // different clocks.
  const { spentUsd: spendTodayUsd } = await loadDataForSeoSpend(store, now, "day");

  const system: SystemBand = {
    assetId: osAsset?.id ?? null,
    // Has the OS's own row ever reported? The coverage read above already
    // holds every asset's latest arrival, the OS's included, so this costs no
    // query of its own (bead `ro-trai.44`).
    hasPulse: osAsset ? latestPulse.has(osAsset.id) : false,
    spendTodayUsd,
    dailyCapUsd,
    ingest,
    scheduledLanes: await readLatestJobRuns(store),
  };

  // One evidence-reviewed selection owns both card counts and attention rows.
  // Read all severities before grouping so detail and Wall share condition grain.
  const openFlagRows = (
    await store.read((tx) =>
      tx.query<AttentionRow>(
        `SELECT ${ATTENTION_COLUMNS}
           FROM noticeos.current_flags f
           JOIN noticeos.assets a ON a.workspace_id = f.workspace_id AND a.asset_id = f.asset_id
          WHERE ${openFlagsSql("f", "$1::timestamptz")}
          ORDER BY CASE f.severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                   f.fired_at DESC, f.flag_id DESC`,
        [nowIso],
      ),
    )
  ).map(flagDbRow).filter((row) => !releasedFreshnessFlag(row, declaredNoReport)).map(namedFlagRow);
  // ^ A freshness flag on an asset that now declares no report is about a
  // report nobody owes: the next freshness run resolves it, and until then it
  // is neither an alert nor a card's error count.
  const reviewed = await reviewAlertConditions(store, openFlagRows, nowMs);
  const flagsByAsset = countAttentionConditions(reviewed);
  const attentionConditions = reviewed.filter((condition) =>
    isAttentionEligible(condition.liveness)
    && ["error", "warn"].includes(condition.latest.severity));

  // NO REPORT ENVELOPE IS READ HERE (bead `ro-trai.44`). The old card's
  // activity sparkline and its all-time totals were the last things on this
  // payload that parsed one; D28 moved both off the Wall, and a site's
  // Overview reads its own totals from the asset page's read. What a report's
  // ARRIVAL says — first, latest, days covered — is the coverage read above.
  const panelAssetIds = serpPanelAssets(serpPanel);
  const integrationEvidence = await loadIntegrationEvidence(store, {
    now, integrations, serpPanel, presentation: 'compact',
  });
  // THE SEARCH LANE COMES BACK (bead `ro-78qo.35`). It was switched off on
  // 2026-08-01 because the asset CARD charts no search history — the work
  // widget took that space (doc 10) — and reading a lane nothing draws is cost
  // a television pays every sixty seconds for nothing.
  //
  // What changed is not the card: /assets reads this same payload, and doc 21's
  // comparison table asks each row for search clicks beside its users. So the
  // lane is read again, and the two providers are merged into ONE card field
  // rather than shipped as a pair — the card still draws none of it, and the
  // Wall's own cost is one more query against an index it already had.
  //
  // Secondary series stay off: impressions, sessions, page views, events, CTR
  // and position are the asset page's, and no desk table asks a row for them.
  const signalTrendsByAsset = await loadSignalTrends(store, WALL_SIGNAL_CHART_DAYS, {
    includeWebSearch: true,
    nowMs,
  });
  const revenueByAsset = new Map<string, RevenueDay[]>();
  // Stored Mediavine report dates, bounded on that provider's reporting day.
  for (const day of await store.read((tx) => tx.query<{ asset: string; date: string; amountMinor: bigint }>(
    `SELECT asset_id AS asset, report_date AS date, amount_minor AS "amountMinor"
       FROM noticeos.mediavine_current_daily
      WHERE report_date >= $1::date - ${REVENUE_HISTORY_DAYS + 1} AND report_date <= $1::date
      ORDER BY asset_id COLLATE "C", report_date`, [revenueToday]))) {
    const rows = revenueByAsset.get(day.asset) ?? [];
    rows.push({ date: day.date, amountMinor: cents(day.amountMinor) });
    revenueByAsset.set(day.asset, rows);
  }
  // No provider reads on a Wall refresh. Skip the longer traffic read until a
  // daily revenue source has actually supplied history, and read it only for
  // the assets that have (bead `ro-ujb9.102`): `projectRevenue` answers "no
  // revenue" before it looks at traffic, so every other asset's sessions were
  // read and never used.
  const revenueTraffic = revenueByAsset.size ? await loadSignalTrends(store, REVENUE_HISTORY_DAYS, { includeWebSearch: false, includeSessions: true, assets: [...revenueByAsset.keys()], nowMs }) : new Map<string, SignalTrendSet>();
  // The desk's per-asset ledger history, from the SAME grouping /financials'
  // by-asset table is built from (`./ledger-history`) — one derivation, two
  // payloads, so the Wall and the accounting page cannot disagree about a
  // asset's month.
  const ledgerMonthsByAsset = await loadAssetMonths(store);
  /**
   * The month the store is standing in, for `netByMonth`'s provisional tail.
   *
   * The CLOCK's month, not the ledger's newest — a card whose last row is
   * August is not drawing a provisional point in September, and a reader
   * standing in September is not looking at a settled month. Null when no asset
   * has a ledger month at all, because a boundary on an empty series is a claim
   * about nothing.
   */
  const openLedgerPeriod = [...ledgerMonthsByAsset.values()].some(
    (entry) => entry.months.length > 0,
  )
    ? currentPeriod
    : null;
  // The operator and review slices come from the same photograph as each
  // site's work above.
  // Tasks is core; an unread hub produces unknown counts, never an exact zero.
  const operator = tasks.needsYou();
  const panelReviewByAsset = cardPanelReviewsOf(
    beadsSnapshot,
    panelAssetIds,
  );
  const panelLandingByAsset = await loadLatestPanelLandings(
    store,
    nowMs,
    panelAssetIds,
  );

  const assets: AssetCard[] = cardAssets.map((a) => {
    const f = flagsByAsset.get(a.id);
    const senseOnly = a.senseOnly === 1;
    const signalTrends = signalTrendsByAsset.get(a.id) ?? emptySignalTrendSet();
    // The marker follows the REVIEW, and the review follows the COLLECTION —
    // never the panel config (`ro-1tu`). Since `ro-478` the runner files a
    // review for every asset whose weekly DataForSEO collection lands, panel
    // or no panel, so gating on config/serp-panel.json left three assets
    // holding open, due-dated reviews no Tower surface rendered.
    //
    // The staleness the old gate existed for still has an answer, and it is a
    // better one: a landing inside `PANEL_LANDING_WINDOW_DAYS` is what makes the
    // marker appear, so an asset whose collection STOPPED sheds its marker
    // instead of haunting the Wall with an obligation nobody can discharge.
    // An asset merely removed from the panel file keeps collecting its other
    // families, keeps landing, and keeps owing the read — which is the point.
    const latestPanelDate = panelLandingByAsset.get(a.id) ?? null;
    return {
      id: a.id,
      displayName: a.displayName,
      status: a.status,
      senseOnly,
      worstSeverity: f ? severityFromRank(toNum(f.worst) ?? 0) : null,
      openError: f ? (toNum(f.err) ?? 0) : 0,
      openWarn: f ? (toNum(f.warn) ?? 0) : 0,
      // The very rows the headline above these cards is made of, split by the
      // same rule — so the cards add up to it.
      booked: assetFigure(a.id, "reconciled"),
      forecast: assetFigure(a.id, "estimated"),
      netPeriod: period,
      pulseReceivedAt: latestPulse.get(a.id) ?? null,
      noNightlyReport: declaredNoReport.has(a.id),
      firstReportAt: firstPulse.get(a.id) ?? null,
      reportDays: reportDays.get(a.id) ?? 0,
      counters: resolveWallCounters(counters?.assets[a.id], counterReadings.get(a.id),
        nightlyTotals.get(a.id) ?? { metrics: {}, receivedAt: null }, counterCadence),
      dataSources: integrationEvidence.cards(a.id, {
        latestReportAt: latestPulse.get(a.id) ?? null,
        pull: pullConfig.find((entry) => entry.asset === a.id) ?? null,
        declaredNoReport: declaredNoReport.has(a.id),
      }),
      activeUsers: signalTrends.activeUsers,
      dailyRevenue: yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, revenueByAsset.get(a.id) ?? []),
      // Holidays for the year the projected month is in, on the same clock.
      revenueProjection: projectRevenue(now, MEDIAVINE_REPORTING_CLOCK, revenueByAsset.get(a.id) ?? [], revenueTraffic.get(a.id)?.sessions ?? emptySignalTrendSet().sessions,
        revenueHolidays(integrations.assets[a.id]?.['ad-network']?.revenueHolidayCalendar, Number(revenueToday.slice(0, 4)))),
      // Two providers, one measurement, one column (bead `ro-78qo.35`). The
      // merge is `shared/wall.ts`'s so the worker and the asset page run the
      // same rule rather than two copies of it.
      searchClicks: mergeSignalTrends([
        signalTrends.webSearchClicks.google,
        signalTrends.webSearchClicks.bing,
      ]),
      // The asset's own month axis, holes and all (bead `ro-78qo.37`): a month
      // it booked nothing in is `null`, so the line breaks there instead of
      // joining two months that are not neighbours.
      netByMonthCurrency: moneyCurrency((ledgerMonthsByAsset.get(a.id)?.months ?? [])
        .flatMap(month => month.figure === null ? [] : [month.figure])),
      netByMonth: (() => {
        const months = ledgerMonthsByAsset.get(a.id)?.months ?? [];
        const currency = moneyCurrency(months.flatMap(month => month.figure === null ? [] : [month.figure]));
        return months.map(month => ({ t: month.period,
          v: currency === null || month.figure?.currency !== currency ? null : month.figure.net }));
      })(),
      netByMonthProvisionalFrom: openLedgerPeriod,
      work: workByAsset.get(a.id) ?? null,
      // The payload boundary is where the snapshot's three-valued answer
      // collapses to two. "The poller did not look" and "it looked and found no
      // review bead" are different measurements, and `SnapshotProject` keeps
      // them apart — but the CARD's answer to both is the same nothing, and a
      // fifth visual state for an absence nobody can act on would be noise on
      // every surface it appeared.
      panelReview: latestPanelDate ? (panelReviewByAsset.get(a.id) ?? null) : null,
      latestPanelDate,
    };
  });

  // --- ATTENTION: open error/warn flags, severity then recency ---------------
  // The row ships FACTS, not the sentence: rule_id + rule_inputs travel with it
  // so the client's one translator (shared/alert-language) renders the same
  // headline the asset page renders. The store is never asked for prose.
  // Recent changes that might explain those alerts. One bounded query for the
  // whole band — the correlation window is the same for every row, so the
  // earliest alert's window start bounds the read, and the per-row pairing
  // happens in JS. Skipped entirely when nothing is open.
  const changesByAsset = await readChangesForAlerts(
    store,
    attentionConditions.flatMap((condition) => condition.firings.map((r) => r.firedAt)),
  );

  // ONE ROW PER CONDITION, not per firing (ro-kukv.1). Only rules declared in
  // RECURRING_CONDITION_RULES collapse; everything else keeps a row each,
  // because merging two firings that ask for two decisions hides one of them.
  //
  // The grouping itself lives in `shared/wall` because the ASSET PAGE has to
  // reach the identical answer over the identical store (ro-kukv.5). Two copies
  // of this loop is exactly how one surface came to render one asset's condition
  // as a single row reading "16x in 26d" while the other rendered sixteen.
  //
  // Grouped in JS rather than SQL: the rows are already ordered severity-then-
  // recency, so the first member of each group IS its representative — the
  // CURRENT reading, the numbers an operator would act on — while the oldest
  // dates the onset. The correlation read above is one bounded query for the
  // whole band either way.
  //
  // Each row's stored readings ride with it (db/0040, bead `ro-ujb9.220`), so
  // its Evidence lists the nights behind a refreshed summary. Empty on a store
  // without the table.
  const attentionReadings = await readFlagReadings(store, attentionConditions.map(({ latest }) => latest.id));
  const attention: AttentionItem[] = attentionConditions.map(
      ({ latest: newest, firings, occurrences, firstFiredAt, verification }) => ({
        id: newest.id,
        asset: newest.asset,
        assetDisplayName: newest.assetDisplayName,
        severity: newest.severity as Severity,
        kind: newest.kind as FlagKind,
        message: newest.message ?? "",
        firedAt: newest.firedAt,
        metric: newest.metric ?? null,
        ruleId: newest.ruleId,
        ruleInputs: newest.ruleInputs ? safeParse(newest.ruleInputs) : null,
        correlatedChanges: correlateChanges(
          changesByAsset.get(newest.asset) ?? [],
          firstFiredAt,
        ),
        occurrences,
        firstFiredAt,
        handoffBeads: alertHandoffsOf(beadsSnapshot, newest.asset, firings.map((flag) => flag.id)),
        verification,
        ...readingsOf(attentionReadings, newest.id),
      }),
    );

  // --- SNOOZED: the same conditions, parked until a date (`ro-c7qq`) ---------
  //
  // A snooze that produced no visible row would be a mute with a nicer name, so
  // `/alerts` renders these under their own heading with an Unsnooze on each.
  // Ordered by WHEN THEY COME BACK rather than by severity: the question this
  // list answers is "what have I put off, and for how long", and the row about
  // to return is the one worth seeing first.
  //
  // WIDER than the band above, deliberately (`ro-w13s`). The open attention
  // table is error/warn, because that is what the portfolio owes the operator
  // an answer about. But Snooze is offered on EVERY open row of the asset
  // page's state hero, info and milestone included, and a parked row nobody can
  // find is exactly the silent hide this section exists to prevent — the only
  // other place it showed was that one asset's alert history, which is the page
  // an operator would have to already suspect. So the ledger lists every parked
  // row. It stays short by construction: it holds only what somebody chose to
  // park, and it is a ledger, not a queue — no count above it changes.
  //
  // Same grouping as the band, so a condition that reads "16x in 26d" open
  // reads as one parked row rather than sixteen.
  const snoozedRows = (
    await store.read((tx) =>
      tx.query<SnoozedRow>(
        `SELECT ${ATTENTION_COLUMNS}, f.snooze_until AS "snoozeUntil"
           FROM noticeos.current_flags f
           JOIN noticeos.assets a ON a.workspace_id = f.workspace_id AND a.asset_id = f.asset_id
          WHERE ${snoozedFlagsSql("f", "$1::timestamptz")}
          ORDER BY f.snooze_until ASC, f.fired_at DESC, f.flag_id DESC`,
        [nowIso],
      ),
    )
  ).map(flagDbRow).filter((row) => !releasedFreshnessFlag(row, declaredNoReport)).map(namedFlagRow);

  const snoozedConditions = await reviewAlertConditions(store, snoozedRows, nowMs);
  const snoozedReadings = await readFlagReadings(store, snoozedConditions.map(({ latest }) => latest.id));
  const snoozed: SnoozedItem[] = snoozedConditions.map(
    ({ latest: newest, firings, occurrences, firstFiredAt, verification }) => ({
      id: newest.id,
      asset: newest.asset,
      assetDisplayName: newest.assetDisplayName,
      severity: newest.severity as Severity,
      kind: newest.kind as FlagKind,
      message: newest.message ?? "",
      firedAt: newest.firedAt,
      metric: newest.metric ?? null,
      ruleId: newest.ruleId,
      ruleInputs: newest.ruleInputs ? safeParse(newest.ruleInputs) : null,
      // No correlated changes: what landed before a condition STARTED is the
      // drill-down's question, and this list is about when it comes back.
      correlatedChanges: [],
      occurrences,
      firstFiredAt,
      verification,
      ...readingsOf(snoozedReadings, newest.id),
      snoozeUntil: firings.reduce(
        (latestEnd, row) => (row.snoozeUntil > latestEnd ? row.snoozeUntil : latestEnd),
        newest.snoozeUntil,
      ),
    }),
  ).sort((left, right) => left.snoozeUntil.localeCompare(right.snoozeUntil)
    || right.firedAt.localeCompare(left.firedAt));

  // Over current entries only, matching every money query above: a superseded
  // estimate is not part of the portfolio's ledger and cannot set its age.
  const [ledger] = await store.read((tx) =>
    tx.query<{ ts: string | null }>(`SELECT MAX(recorded_at) AS ts FROM noticeos.financial_ledger`),
  );

  return {
    generatedAt: now.toISOString(),
    portfolio,
    system,
    dashboard,
    assets,
    attention,
    snoozed,
    operator,
    ledgerRecordedAt: ledger?.ts ? javascriptInstant(ledger.ts) : null,
  };
}
