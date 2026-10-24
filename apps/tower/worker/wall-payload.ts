import { moneyFigure, minorToMajorUnits, moneyCurrency } from '@noticeos/contract/money';
import { loadIntegrationEvidence, serpPanelAssets } from './integration-evidence';
// Wall payload assembly — the one read the Tower makes over the central
// store. A ledger row is current when nothing supersedes it; net = revenue −
// cost over the current rows for a period.

import { assetDisplayName } from "@noticeos/contract/asset-name";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { readSites } from "./asset-registry";
import { openFlagsSql, snoozedFlagsSql } from "./flag-scope";
import { countAttentionConditions, reviewAlertConditions } from "./alert-evidence";
import { readFlagReadings, readingsOf } from "./flag-evidence";
import { isAttentionEligible } from "../shared/signal-liveness";
import type { PullConfigEntry, SerpPanelConfig } from "./asset-config";
import { loadDataForSeoSpend } from "./metered-spend";
import { TASK_BLOCKING_DEPENDENCIES } from "@noticeos/contract/task-gate";
import { alertHandoffsOf, type BeadsSnapshot, loadLatestBeadsSnapshot, type SnapshotProject } from "./beads-snapshot";
import { beadsReading } from "./task-source";
import { loadWorkWeeks } from "./work-payload";
import { readBackupLastGoodAt, readLatestJobRuns } from "./job-runs";
import { cardPanelReviewsOf, loadLatestPanelLandings } from "./panel-review";
import { cardIcons, loadSiteIcons } from "./site-icons";
import { loadCardCodebases, loadCardInsights } from "./card-readings";
import { readPortfolioWatches } from "./watch-window-reader";
import { siteIconAddresses } from "../shared/site-display";
import {
  WALL_SIGNAL_CHART_DAYS,
  emptySignalTrendSet,
  loadSignalTrends,
} from "./signal-trends";
import { cents, loadAssetMonths, monthDate } from "./ledger-history";
import { flagDbRow } from "./flag-records";
import { readPulseCoverage } from "./pulse-history";
import { countersCadenceHours, readCounterReadings, readLatestCounterTotals, resolveWallCounters, type CountersConfig } from "./counters";
import { SCHEDULED_JOBS, scheduleFor, type ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import { projectRevenue, REVENUE_HISTORY_DAYS } from '../shared/revenue-projection';
import { revenueHolidays } from './revenue-holidays';
import { operatorRevenueClock, revenueCalendarDate, yesterdayRevenue, type SiteRevenueHistory } from '../shared/daily-revenue';
import { emptyRevenueHistory, loadRevenueHistories } from './daily-revenue';
import {
  releasedFreshnessFlag,
  reportingState,
  summarizeReporting,
} from "@noticeos/contract";
import { CORRELATION_WINDOW_HOURS, correlateChanges } from "../shared/alert-language";
import type { AnnotationItem, AnnotationKind } from "../shared/annotations";
import type { IntegrationsConfig } from "../shared/integrations";
import { assetTypeOf } from "@noticeos/contract/configuration";
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
  type WallAgents,
  type WallAgentStanding,
  type WallDecision,
  type WallNextUp,
  type WallPayload,
  type WallWorking,
  type WallAttentionTasks,
  type WorkSummary,
  wallDecisionAsk,
} from "../shared/wall";
import type { WorkItem, WorkWeeks } from "../shared/work";

/** The tunables the SYSTEM band needs, sourced from config/constants.json. */
export interface WallConstants {
  /** monthly_caps.data_usd — the portfolio's only monthly ceiling. The strip's
   * "over the daily data pace" reads the day's share of it. */
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
  /** config/serp-panel.json — which assets have a tracked SERP panel. The
   * Tower reads only the key set. */
  serpPanel: SerpPanelConfig;
  /** The operator's clock: config/constants.json `os_time_zone` as saved. It
   * decides the open month, each card's "yesterday" and the projection's
   * month. */
  osTimeZone: string;
  /** config/constants.json `no_nightly_report` as saved: the assets declared
   * as sending no nightly report. None is owed, so each is outside the system
   * card's denominator and carries no freshness alert. Absent or null declares
   * none. */
  noNightlyReport?: readonly string[] | null;
  counters?: CountersConfig;
  schedules?: ScheduleOverrides | null;
}

const MS_PER_DAY = 86_400_000;

/** One (asset, booking state) money total for the shown period, in integer
 * cents — the single row shape both the portfolio headline and every asset
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
 * its site: the workspace's number, the day's report number, the newest
 * reading. */
const ATTENTION_COLUMNS = `f.flag_number::int AS id, f.pulse_day_number::int AS "pulseId", f.asset_id AS asset,
                a.display_name AS "assetDisplayName", (CASE WHEN a.is_os THEN 1 ELSE 0 END) AS "assetIsOs",
                f.severity, f.kind, f.message, f.fired_at AS "firedAt", f.metric,
                f.rule_id AS "ruleId", f.rule_inputs::text AS "ruleInputs"`;

/** A flag row with its asset named the way every surface names it: the OS's
 * own row by the product. */
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
 * The changes filed in a window, every site's, newest first: one bounded seek
 * per site down its (site, time) index (`OFFSET 0` keeps each site's read its
 * own, where Postgres would flatten it into one pass over every site's
 * changes). Two changes at one instant come newest-filed first.
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
 * Each asset's open work, keyed by asset id, from the same newest snapshot the
 * Tasks page reads (`./beads-snapshot`). A project the poller could not read
 * (`ok: false`) is absent, not zeroed, and an asset with no entry never lands
 * in the map; both become `work: null` on the card. There is no path here
 * that produces a zero the store did not observe. A count the poller did not
 * measure travels as null and is dropped one chip at a time rather than
 * costing the asset its whole widget.
 */
export function cardWorkOf(snapshot: BeadsSnapshot | null, weeks: ReadonlyMap<string, WorkWeeks> = new Map()): Map<string, WorkSummary> {
  const out = new Map<string, WorkSummary>();
  if (!snapshot) return out;
  for (const project of snapshot.projects) {
    if (!project.ok) continue;
    const { open, highPriority, inProgress, blocked, closedRecent } = project.counts;
    const week = weeks.get(project.asset);
    out.set(project.asset, {
      open,
      highPriority,
      inProgress,
      blocked,
      closedRecent,
      priorities: project.priorities,
      capturedAt: snapshot.capturedAt,
      ...(week ? { weeks: week } : {}),
    });
  }
  return out;
}

/** The Agents widget's standings from the newest snapshot: each agent and
 * model's closes and held work summed across the projects read. Null until a
 * worker has named a model. */
export function wallAgentsOf(snapshot: BeadsSnapshot | null): WallAgents | null {
  if (!snapshot) return null;
  const rows = snapshot.projects.filter((project) => project.ok).flatMap((project) => project.workers ?? []);
  const agents = new Set(rows.filter((row) => row.model !== null).map((row) => row.id));
  if (agents.size === 0) return null;
  const merged = new Map<string, WallAgentStanding>();
  for (const row of rows.filter((entry) => agents.has(entry.id))) {
    const key = `${row.id}\0${row.model ?? ""}`;
    const entry = merged.get(key) ?? { id: row.id, model: row.model, closed: 0, inProgress: 0 };
    merged.set(key, { ...entry, closed: entry.closed + row.closedRecent, inProgress: entry.inProgress + row.inProgress });
  }
  const standings = [...merged.values()].sort((a, b) => b.closed - a.closed || b.inProgress - a.inProgress || a.id.localeCompare(b.id));
  return {
    standings: standings.slice(0, WALL_AGENT_ROWS),
    closed: standings.reduce((sum, entry) => sum + entry.closed, 0),
    inProgress: standings.reduce((sum, entry) => sum + entry.inProgress, 0),
    capturedAt: snapshot.capturedAt,
  };
}
/** The most standings a Wall's Agents widget draws. */
export const WALL_AGENT_ROWS = 6;

/** The most decisions and held tasks Next up lists. */
export const WALL_NEXT_DECISIONS = 5;
export const WALL_NEXT_WORKING = 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Whole units since an instant, or null when there is no readable instant. */
function wholeSince(at: string | null | undefined, nowMs: number, unitMs: number): number | null {
  const parsed = Date.parse(at ?? "");
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((nowMs - parsed) / unitMs)) : null;
}

/** Which of two inbox rows blocks more: a gate, then the higher priority, then
 * the older filing; a row with no filing date ranks after one with a date. */
function blocksFirst(a: WorkItem, b: WorkItem): number {
  const gate = Number(b.issueType === "gate") - Number(a.issueType === "gate");
  if (gate !== 0) return gate;
  if (a.priority !== b.priority) return a.priority - b.priority;
  const filed = (item: WorkItem) => {
    const parsed = Date.parse(item.createdAt ?? "");
    return Number.isFinite(parsed) ? parsed : Infinity;
  };
  return filed(a) - filed(b);
}

/**
 * How many open, unparked tasks the project's lists hold that wait on the
 * decision: null when the decision's row records no links, as a snapshot an
 * older poller wrote does. The lists are the snapshot's first rows, so a task
 * waiting on it that the snapshot does not list is not counted.
 */
function holdsOf(project: SnapshotProject, decision: WorkItem): number | null {
  if (decision.dependencies === undefined) return null;
  const open = new Map([...project.waiting, ...project.ready, ...project.inProgress, ...(project.blocked ?? [])]
    .map((item) => [item.id, item]));
  return [...open.values()].filter((item) => item.id !== decision.id && item.issueType !== "gate"
    && item.status !== "closed" && item.status !== "deferred"
    && (item.dependencies ?? []).some((edge) => edge.id === decision.id && TASK_BLOCKING_DEPENDENCIES.includes(edge.type))).length;
}

/**
 * Next up from the newest snapshot: the operator's decisions across every
 * project read, and the work held now. Each project's `waiting` list is
 * already most-blocking first, so the projects are merged by their heads and
 * no project's own order is changed.
 */
export function wallNextUpOf(snapshot: BeadsSnapshot | null, now: Date): WallNextUp | null {
  if (!snapshot) return null;
  const nowMs = now.getTime();
  const read = snapshot.projects.filter((project) => project.ok);

  const queues = read.map((project) => ({ project, items: [...project.waiting] }));
  const decisions: WallDecision[] = [];
  while (decisions.length < WALL_NEXT_DECISIONS) {
    let next: (typeof queues)[number] | null = null;
    for (const queue of queues) {
      const head = queue.items[0];
      if (head && (next === null || blocksFirst(head, next.items[0]!) < 0)) next = queue;
    }
    const item = next?.items.shift();
    if (!next || !item) break;
    decisions.push({
      id: item.id,
      title: item.title,
      asset: next.project.asset,
      ask: wallDecisionAsk(item),
      ageDays: wholeSince(item.createdAt, nowMs, DAY_MS),
      releases: holdsOf(next.project, item),
    });
  }
  const ages = read.flatMap((project) => project.waiting)
    .map((item) => wholeSince(item.createdAt, nowMs, DAY_MS))
    .filter((age): age is number => age !== null);

  const working: WallWorking[] = read.flatMap((project) => project.inProgress.map((item) => {
    // The newest claim of this task the snapshot's recent work recorded.
    const claim = (project.recentWork ?? [])
      .filter((event) => event.kind === "claimed" && event.taskId === item.id)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return {
      id: item.id,
      title: item.title,
      asset: project.asset,
      who: item.assignee ?? claim?.by ?? null,
      sinceHours: wholeSince(claim?.at, nowMs, HOUR_MS),
      urgent: item.priority <= 1,
    };
  }));
  // Stable: rows that tie keep the snapshot's order.
  working.sort((a, b) =>
    Number(b.urgent) - Number(a.urgent) || (b.sinceHours ?? -1) - (a.sinceHours ?? -1));

  return {
    decisions,
    oldestAgeDays: ages.length > 0 ? Math.max(...ages) : null,
    working: working.slice(0, WALL_NEXT_WORKING),
    capturedAt: snapshot.capturedAt,
  };
}

/** Complete attention rows come from the snapshot's uncapped derivation.
 * Older snapshots retain their known rows without claiming full coverage. */
export function wallAttentionTasksOf(snapshot: BeadsSnapshot | null): WallAttentionTasks {
  const items: WallAttentionTasks['items'] = [];
  let measuredProjects = 0;
  const ids = new Set<string>();
  for (const project of snapshot?.projects ?? []) {
    if (!project.ok) continue;
    if (project.attentionTasks?.complete) measuredProjects++;
    const decisions = new Set(project.waiting.map(item => item.id));
    const rows = project.attentionTasks?.items ?? [...project.ready, ...project.inProgress, ...(project.blocked ?? []), ...project.waiting]
      .map(item => ({ ...item, decision: decisions.has(item.id) }));
    for (const item of rows) {
      if (ids.has(item.id) || item.status === 'closed' || item.status === 'deferred' || item.issueType === 'epic'
        || (!item.decision && item.priority > 1)) continue;
      ids.add(item.id);
      items.push({ id: item.id, title: item.title, asset: project.asset, priority: item.priority,
        ask: item.decision ? wallDecisionAsk(item) : null, updatedAt: item.updatedAt });
    }
  }
  return { items, capturedAt: snapshot?.capturedAt ?? null, measuredProjects, projectCount: snapshot?.projects.length ?? 0 };
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
  /** Who owes no nightly report — one set for the coverage, the alert list
   * and every card below. */
  const declaredNoReport = new Set(noNightlyReport ?? []);
  /** The one instant every flag query below binds: "open" depends on the clock
   * (`worker/flag-scope.ts`), and a payload that read it twice could count a
   * condition in the open list and in the snoozed one. */
  const nowIso = now.toISOString();
  /** The calendar month the operator is standing in, on the operator's clock,
   * not UTC's — what "still open" means anywhere below. The money blocks pick
   * their own period. Provider reports and their projection keep the
   * provider's separate clock. */
  const operatorToday = revenueCalendarDate(now, osTimeZone);
  const currentPeriod = operatorToday.slice(0, 7);

  // --- assets (by their place in the list; the System to SYSTEM, rest to cards) -
  const sites = await readSites(store);
  const assetRows = sites.map((row) => ({
    id: row.id,
    displayName: assetDisplayName(row.isOs, row.displayName),
    status: row.status,
    hasCollectedData: row.hasCollectedData,
    senseOnly: row.senseOnly,
    isOs: row.isOs,
  }));

  const osAsset = assetRows.find((a) => a.isOs === 1) ?? null;
  const cardAssets = assetRows.filter((a) => a.isOs !== 1);

  // --- portfolio + per-asset P&L: reconciled and estimated kept apart --------
  // One grouped read for both grains: the headline is the sum of exactly the
  // rows the cards state. Summed in `amount_minor` (integer cents) and divided
  // once, at the end, per figure. The period is the latest, not in the future,
  // that has any current row: the current month wins the moment it has one,
  // and with no rows at all the band hides itself. Booking state is not part
  // of the test, so a month holding only cost rows is money and still leads.
  // One choice, fed to both the band and the cards, with `periodIsCurrent`
  // beside it. Every money read below is of the view that holds only current
  // entries (`./ledger-history`).
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
   * The headline minus the cards, in cents. The headline spans every asset and
   * the cards exclude asset #0, so a ledger row recorded against the OS itself
   * sits inside the figure and on no card. Defined as the subtraction rather
   * than as "asset #0's rows", so any reason to omit an asset from the cards
   * is carried here automatically.
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

  // The booked trend: reconciled rows only, so the line under the headline
  // charts the same money the headline states. Kept in minor units; the delta
  // below subtracts before anything is divided.
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

  // The shape of the portfolio, every current row regardless of booking state,
  // drawn as the card's background and never as a figure.
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

  // The delta the band is allowed to state: the newest two months strictly
  // before the current period, the like-for-like pair this grain supports.
  // Fewer than two closed months is no delta. Read against `currentPeriod`,
  // never the chosen `period`: "closed" is a fact about the calendar.
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

  // First-run state: the portfolio stays in the empty state until a reconciled
  // row exists. Estimated rows do not book P&L; they show as forecast.
  const [reconciled] = await store.read((tx) =>
    tx.query<{ x: number }>(
      `SELECT 1 AS x FROM noticeos.financial_ledger WHERE booking_state = 'reconciled' LIMIT 1`,
    ),
  );
  const firstRun = !reconciled;

  // The earlier of the first money entry and the first site.
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
  // Index seeks per asset, not a pass over every stored night
  // (`./pulse-history`). The asset page reads the same statement for one asset.
  const pulseCoverage = await readPulseCoverage(store, nowIso);
  const latestPulse = new Map([...pulseCoverage].map(([asset, c]) => [asset, c.latest]));
  // Setup reads actual coverage as well as arrival time, from this same query.
  const firstPulse = new Map([...pulseCoverage].map(([asset, c]) => [asset, c.first]));
  const reportDays = new Map([...pulseCoverage].map(([asset, c]) => [asset, c.reportDays]));
  const [counterReadings, nightlyTotals] = await Promise.all([
    readCounterReadings(store), readLatestCounterTotals(store),
  ]);
  const counterCadence = countersCadenceHours(schedules ?? null);

  // Counted over the asset rows, never over the pulses map, by the rule the
  // ingest freshness cron counts with (`owesNightlyReport`): a site that has
  // never sent a report or was declared as sending none owes nothing and sits
  // outside the denominator.
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

  // One task-hub snapshot feeds every site's work, its panel review and the
  // task source's one reading (`./task-source`).
  const tasks = beadsReading(store, await loadLatestBeadsSnapshot(store), undefined, osTimeZone, sites);
  const beadsSnapshot = tasks.snapshot;
  const workByAsset = cardWorkOf(beadsSnapshot, await loadWorkWeeks(store, beadsSnapshot, now, osTimeZone));

  // --- system: what the strip's one state and Home's System tile read -------
  // The metered data cap alone.
  const dailyCapUsd = constants.dataUsd / daysInMonthUTC(now);

  // Today's metered data spend, counted from the report runs by
  // `loadDataForSeoSpend` — the same function the Health page's spend summary
  // and `/settings`' budget meter call, windowed to today. UTC days, matching
  // `daysInMonthUTC` above, so numerator and denominator share one calendar.
  const { spentUsd: spendTodayUsd } = await loadDataForSeoSpend(store, now, "day");

  const system: SystemBand = {
    assetId: osAsset?.id ?? null,
    // Has the OS's own row ever reported? The coverage read above already
    // holds every asset's latest arrival.
    hasPulse: osAsset ? latestPulse.has(osAsset.id) : false,
    spendTodayUsd,
    dailyCapUsd,
    ingest,
    scheduledLanes: await readLatestJobRuns(store),
    backupLastGoodAt: await readBackupLastGoodAt(store),
    backupSchedule: scheduleFor(SCHEDULED_JOBS.find((job) => job.id === "backup")!, schedules ?? {}),
  };

  // One evidence-reviewed selection owns both card counts and attention rows.
  // Read all severities before grouping so detail and Wall share condition grain.
  const openFlagRows = (
    await store.read((tx) =>
      tx.query<AttentionRow>(
        `SELECT ${ATTENTION_COLUMNS}
           FROM noticeos.current_flags f
           JOIN noticeos.assets a ON a.workspace_id = f.workspace_id AND a.asset_id = f.asset_id
          WHERE a.status <> 'retired' AND ${openFlagsSql("f", "$1::timestamptz")}
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

  // No report envelope is read here: what a report's arrival says — first,
  // latest, days covered — is the coverage read above.
  const panelAssetIds = serpPanelAssets(serpPanel);
  const integrationEvidence = await loadIntegrationEvidence(store, {
    now, integrations, serpPanel, presentation: 'compact',
  });
  // /assets reads this same payload and its comparison table asks each row
  // for search clicks beside its users, so the search lane is read and the
  // two providers merged into one card field. Secondary series stay off: no
  // desk table asks a row for them.
  const signalTrendsByAsset = await loadSignalTrends(store, WALL_SIGNAL_CHART_DAYS, {
    includeWebSearch: true,
    nowMs,
  });
  // Each site's saved daily revenue from every source, on its sources' own
  // reporting clock, back as far as the projection reads.
  const revenueClockFallback = operatorRevenueClock(osTimeZone);
  const revenueHistories = await loadRevenueHistories(store, { now, days: REVENUE_HISTORY_DAYS + 1, fallback: revenueClockFallback });
  const revenueOf = (asset: string): SiteRevenueHistory =>
    revenueHistories.get(asset) ?? emptyRevenueHistory(now, REVENUE_HISTORY_DAYS + 1, revenueClockFallback);
  /** The clock a site's revenue days are on: its sources', or the operator's. */
  const revenueClockOf = (asset: string) => revenueOf(asset).clock ?? revenueClockFallback;
  /** The days every source the site owed reported: a partial day is not yet
   * the day's revenue. */
  const completeRevenueDays = (history: SiteRevenueHistory) =>
    history.days.filter((day) => !history.partialDates.includes(day.date));
  // Skip the longer traffic read until a daily revenue source has supplied
  // history, and read it only for the assets that have: `projectRevenue`
  // answers "no revenue" before it looks at traffic.
  const revenueTraffic = revenueHistories.size ? await loadSignalTrends(store, REVENUE_HISTORY_DAYS, { includeWebSearch: false, includeSessions: true, assets: [...revenueHistories.keys()], nowMs }) : new Map<string, SignalTrendSet>();
  // The desk's per-asset ledger history, from the same grouping /financials'
  // by-asset table is built from (`./ledger-history`).
  const ledgerMonthsByAsset = await loadAssetMonths(store);
  /** The month the store is standing in, for `netByMonth`'s provisional tail:
   * the clock's month, not the ledger's newest. Null when no asset has a
   * ledger month at all. */
  const openLedgerPeriod = [...ledgerMonthsByAsset.values()].some(
    (entry) => entry.months.length > 0,
  )
    ? currentPeriod
    : null;
  // From the same snapshot as each site's work above. An unread hub produces
  // unknown counts, never an exact zero.
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
  const iconsByAsset = await loadSiteIcons(store);
  const [insightsByAsset, codebaseByAsset, watchesByAsset] = await Promise.all([
    loadCardInsights(store), loadCardCodebases(store), readPortfolioWatches(store),
  ]);

  const assets: AssetCard[] = cardAssets.map((a) => {
    const f = flagsByAsset.get(a.id);
    const senseOnly = a.senseOnly === 1;
    const signalTrends = signalTrendsByAsset.get(a.id) ?? emptySignalTrendSet();
    // The marker follows the review, and the review follows the collection —
    // never the panel config: the runner files a review for every asset whose
    // weekly DataForSEO collection lands, panel or no panel. A landing inside
    // `PANEL_LANDING_WINDOW_DAYS` is what makes the marker appear, so an asset
    // whose collection stopped sheds its marker.
    const latestPanelDate = panelLandingByAsset.get(a.id) ?? null;
    return {
      id: a.id,
      assetType: assetTypeOf(dashboard.sites?.[a.id]),
      displayName: a.displayName,
      status: a.status,
      hasCollectedData: a.hasCollectedData,
      senseOnly,
      worstSeverity: f ? severityFromRank(toNum(f.worst) ?? 0) : null,
      openError: f ? (toNum(f.err) ?? 0) : 0,
      openWarn: f ? (toNum(f.warn) ?? 0) : 0,
      // The very rows the headline above these cards is made of, so the cards add up to it.
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
      dailyRevenue: { ...yesterdayRevenue(now, revenueClockOf(a.id).timeZone, completeRevenueDays(revenueOf(a.id))),
        timeZoneLabel: revenueClockOf(a.id).label },
      // Holidays for the year the projected month is in, on the same clock.
      revenueProjection: projectRevenue(now, revenueClockOf(a.id), completeRevenueDays(revenueOf(a.id)), revenueTraffic.get(a.id)?.sessions ?? emptySignalTrendSet().sessions,
        revenueHolidays(integrations.assets[a.id]?.['ad-network']?.revenueHolidayCalendar,
          Number(revenueCalendarDate(now, revenueClockOf(a.id).timeZone).slice(0, 4)))),
      // Two providers, one measurement, one column; the merge is `shared/wall.ts`'s.
      searchClicks: mergeSignalTrends([
        signalTrends.webSearchClicks.google,
        signalTrends.webSearchClicks.bing,
      ]),
      // The asset's own month axis, holes and all: a month it booked nothing
      // in is `null`, so the line breaks there.
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
      // The snapshot's three-valued answer collapses to two here: the card's
      // answer to "did not look" and "looked and found no review" is the same
      // nothing.
      panelReview: latestPanelDate ? (panelReviewByAsset.get(a.id) ?? null) : null,
      latestPanelDate,
      icons: cardIcons(iconsByAsset.get(a.id), siteIconAddresses(dashboard.sites, a.id)),
      product: insightsByAsset.get(a.id)?.product ?? null,
      codebase: codebaseByAsset.get(a.id) ?? null,
      watches: watchesByAsset.get(a.id) ?? null,
      channels: insightsByAsset.get(a.id)?.channels ?? null,
      // Absent, not empty, until the site has a reading.
      ...(insightsByAsset.has(a.id) ? { findings: insightsByAsset.get(a.id)!.findings } : {}),
    };
  });

  // --- attention: open error/warn flags, severity then recency ---------------
  // The row ships facts, not the sentence: rule_id + rule_inputs travel with
  // it so the client's one translator (shared/alert-language) renders the same
  // headline the asset page renders. Recent changes that might explain those
  // alerts: one bounded query for the whole band, paired per row in JS.
  const changesByAsset = await readChangesForAlerts(
    store,
    attentionConditions.flatMap((condition) => condition.firings.map((r) => r.firedAt)),
  );

  // One row per condition, not per firing; the grouping lives in `shared/wall`
  // because the asset page has to reach the identical answer. Grouped in JS:
  // the rows are already ordered severity-then-recency, so the first member of
  // each group is its representative while the oldest dates the onset. Each
  // row's stored readings ride with it; empty on a store without the table.
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

  // --- snoozed: the same conditions, parked until a date --------------------
  // Ordered by when they come back rather than by severity. Wider than the
  // band above: Snooze is offered on every open row of the asset page, info
  // and milestone included, so this ledger lists every parked row. No count
  // above it changes. Same grouping as the band.
  const snoozedRows = (
    await store.read((tx) =>
      tx.query<SnoozedRow>(
        `SELECT ${ATTENTION_COLUMNS}, f.snooze_until AS "snoozeUntil"
           FROM noticeos.current_flags f
           JOIN noticeos.assets a ON a.workspace_id = f.workspace_id AND a.asset_id = f.asset_id
          WHERE a.status <> 'retired' AND ${snoozedFlagsSql("f", "$1::timestamptz")}
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
      // No correlated changes: this list is about when a condition comes back.
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

  // Over current entries only: a superseded estimate cannot set the ledger's age.
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
    agents: wallAgentsOf(beadsSnapshot),
    next: wallNextUpOf(beadsSnapshot, now),
    attentionTasks: wallAttentionTasksOf(beadsSnapshot),
    ledgerRecordedAt: ledger?.ts ? javascriptInstant(ledger.ts) : null,
  };
}
