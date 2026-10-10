import { moneyFigure } from '@noticeos/contract/money';
// Integration evidence: stored observations, scope, and their current meaning.
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { cents } from './ledger-history';
import { dataForSeoReportsFor, mediavineSyncOn } from '@noticeos/contract';
import { showsNightlyReport } from '@noticeos/contract/reporting';
import type { PullConfigEntry } from './asset-config';
import { isAmber } from '../shared/freshness';
import { AMBER_MULTIPLIER, CADENCE_HOURS, type CardDataSource } from '../shared/wall';
import {
  type AssetIntegrations, type AssetIntegrationLane, type DerivedLaneRow,
  type IntegrationCatalogRow, type IntegrationCell, type IntegrationCellBase,
  type IntegrationEvidence, type IntegrationState, type IntegrationsConfig,
  type IntegrationsConfigCatalogRow, type IntegrationsConfigCell, type IntegrationAssetRef,
  type LaneMappingSource, type LaneMappingValue, type LaneMappingList,
  NIGHTLY_REPORT_LANE_ID, PROPERTY_DATA_SOURCE_IDS, UPTIME_LANE_ID,
  collectionCadenceHours, registerCell, summarize, unusedWithoutConnectPath,
} from '../shared/integrations';
import { LANE_MAPPING } from '../shared/config-registers';
import { everyLabel, type LaneFailureMode, type LaneUsage } from '../shared/lane-facts';

/** Each catalog lane's cost, event trigger, provider limit and failure
 * posture, as facts (`shared/lane-facts`). A scheduled lane's cadence is
 * `collectionCadenceHours`, so it is not repeated here. */
const LANE_FACTS: Record<string, { usage: LaneUsage; onFailure: LaneFailureMode }> = {
  gsc: { usage: { cost: "free", limit: "1,200 queries/min" }, onFailure: "keeps-last-data" },
  ga4: { usage: { cost: "free", limit: "200k tokens/day" }, onFailure: "keeps-last-data" },
  "bing-webmaster": { usage: { cost: "free" }, onFailure: "keeps-last-data" },
  clarity: { usage: { cost: "free", limit: "10 calls/day" }, onFailure: "keeps-last-data" },
  posthog: { usage: { cost: "free", limit: "3 queries at once" }, onFailure: "keeps-last-data" },
  dataforseo: { usage: { cost: "metered", limit: "Monthly data cap" }, onFailure: "keeps-last-data" },
  uptime: { usage: { cost: "free" }, onFailure: "raises-alert" },
  "ad-network": { usage: { cost: "free" }, onFailure: "keeps-last-data" },
  "affiliate-cj": { usage: { cost: "free" }, onFailure: "books-on-payment" },
  "affiliate-amazon": { usage: { cost: "free" }, onFailure: "books-on-payment" },
  "deploy-annotations": { usage: { cost: "free", trigger: "deploy" }, onFailure: "pauses-deploy-marks" },
  "github-app": { usage: { cost: "free", trigger: "request", limit: "5k requests/hour" }, onFailure: "pauses-changes" },
  "discord-webhooks": { usage: { cost: "free", trigger: "alert" }, onFailure: "falls-back-to-email" },
};

/** A lane the file adds before this table knows it claims nothing. */
const UNKNOWN_LANE_FACTS: { usage: LaneUsage; onFailure: LaneFailureMode | null } = {
  usage: {},
  onFailure: null,
};

// ---------------------------------------------------------------------------
// The derived nightly-report lane. It has no cell in config/integrations.json
// on purpose: a lane the OS already runs must not claim a state the store
// contradicts, so this row is recomputed from the store and config/pull.json
// on every read. Same shape as a catalog row so the register renders it alike.
// ---------------------------------------------------------------------------
const NIGHTLY_REPORT_LANE: IntegrationCatalogRow = {
  id: NIGHTLY_REPORT_LANE_ID,
  layer: "property",
  label: "Nightly report",
  docRef: "docs/02-signal-contract.md",
  // Asset #0 self-reports nightly too, so the scope rule may not blank this on the OS row.
  scope: "both",
  usage: { cost: "free" },
  onFailure: "raises-alert",
  credential: "per-property",
  derived: true,
};

// The trailing window (in whole months) that counts as "recent" for delivering-
// revenue evidence. now − 2 months → a 3-month inclusive window.
const RECENT_MONTHS_BACK = 2;

// ---------------------------------------------------------------------------
// Store evidence inputs
// ---------------------------------------------------------------------------
export interface RevenueRow {
  currency: string;
  family: string;
  source: string | null;
  note: string | null;
  /** Integer cents (`amount_minor`): added exactly and formatted once. */
  amountMinor: number;
  period: string;
}

export interface LatestSignalRun {
  asset: string;
  integration: "ga4" | "gsc" | "bing-webmaster" | "dataforseo" | "posthog" | "clarity";
  status: "success" | "error";
  finishedAt: string;
  windowStart: string;
  windowEnd: string;
  dataState: "final" | "includes-provisional";
  provisionalFrom: string | null;
  providerRows: number;
  observationCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** The nightly archive lane's latest attempt for one asset + provider, rolled
 * up over that provider's report families. A second observation of an
 * integration the 15-minute collector already observes, so it rides as an
 * extra evidence line on that lane and never becomes a lane of its own. */
export interface ArchiveLaneRun {
  asset: string;
  integration: "ga4" | "gsc" | "bing-webmaster";
  /** Newest report_date across the families with a current attempt. */
  reportDate: string;
  /** Newest finished_at across those families. */
  finishedAt: string;
  status: "success" | "error";
  /** Report families with a current attempt, and how many of them failed. */
  reports: number;
  failedReports: number;
  /** The families whose newest manifest is dated earlier than `reportDate`,
   * with that date. Under a per-family cadence (Bing's weekly `queries` and
   * `pages`) a family trailing the lane by days is what working looks like, so
   * these are reported, never counted as failures. */
  lagging: { report: string; reportDate: string }[];
  errorCode: string | null;
  errorMessage: string | null;
}

/** A site's newest home-page reading (`hygiene_checks`, check `html-depth`):
 * the OS's own check of whether the site is up, written nightly with the
 * served-layer sweep and hourly by `runUptimeChecks`. */
export interface HomeCheck {
  observedAt: string;
  status: "ok" | "warn" | "error" | "unreachable";
  /** The HTTP status the home page answered with, or null for no answer. */
  httpStatus: number | null;
  /** The OS could not reach the network, so the site was not checked. */
  egressDown: boolean;
  /** GETs that failed in this check: 1 when the page answered only the
   * confirming retry, 2 when the retry failed too. */
  failedTries?: number;
}

export interface LaneEvidence {
  /** Undefined means this caller did not read the home-page checks; null means
   * it did and the site has none yet. */
  homeCheck?: HomeCheck | null;
  mediavineRun?: MediavineRun | null;
  /** Recent CURRENT (non-superseded) revenue ledger rows for the asset. */
  revenueRows: RevenueRow[];
  /** Undefined means this pure caller did not load the signal tables. An empty
   * array means it did load them and there is no run on record. */
  signalRuns?: LatestSignalRun[];
  /** Same convention for the nightly archive manifests (the report runs). */
  archiveRuns?: ArchiveLaneRun[];
  nowMs?: number;
}

/** Effective state for one lane. Collector-backed lanes are observations:
 * fresh success = live, error/stale = degraded, no run = needs-setup. Explicit
 * skipped/not-applicable cells remain operator scope decisions. Other lanes
 * fall back to their file-backed setup posture; a lane's health is only ever
 * its own observations, never another lane's alerts. */
export function effectiveLaneState(
  declared: IntegrationState,
  laneId: string,
  signalRun?: LatestSignalRun | null,
  nowMs: number = Date.now(),
): IntegrationState {
  if (
    isCollectedSignalLane(laneId) &&
    signalRun !== undefined &&
    declared !== "skipped" &&
    declared !== "not-applicable"
  ) {
    if (!signalRun) return "needs-setup";
    if (
      signalRun.status === "error" ||
      isAmber(
        nowMs,
        signalRun.finishedAt,
        signalCadenceHours(laneId),
        AMBER_MULTIPLIER,
      )
    ) {
      return "degraded";
    }
    return "live";
  }
  return declared;
}

// ---------------------------------------------------------------------------
// The merge, pure: collector-backed health from the latest run, scope decisions
// and evidence-free lanes from the file. Every observed state carries its why.
// ---------------------------------------------------------------------------
export function mergeLane(
  declared: IntegrationState,
  laneId: string,
  ev: LaneEvidence,
): { effective: IntegrationState; evidence: IntegrationEvidence[] } {
  // Uptime reads the OS's own home-page check, never another lane's alerts.
  if (laneId === UPTIME_LANE_ID && ev.homeCheck !== undefined) return uptimeState(declared, ev.homeCheck);
  const signalRun =
    ev.signalRuns === undefined
      ? undefined
      : (ev.signalRuns.find((run) => run.integration === laneId) ?? null);
  const effective = effectiveLaneState(declared, laneId, signalRun, ev.nowMs);
  if (isCollectedSignalLane(laneId) && signalRun !== undefined) {
    const nowMs = ev.nowMs ?? Date.now();
    return {
      effective,
      evidence: [
        signalRunEvidence(laneId, signalRun, nowMs),
        // The nightly archive explains the lane; it does not get a vote on its
        // state, because the 15-minute run is the fresher observation.
        ...archiveEvidence(laneId, declared, signalRun, ev.archiveRuns, nowMs),
      ],
    };
  }
  if (declared === "needs-setup") {
    const supporting = supportingRevenueEvidence(laneId, ev.revenueRows);
    if (supporting) return { effective: "needs-setup", evidence: [supporting] };
  }
  return { effective: declared, evidence: [] };
}

/**
 * Is the site up — read from the OS's own hourly check of the home page.
 *   • it answered (including a page too big or too binary to word-count) →
 *     live: Up, dated, with proof, so a check that stops running ages into
 *     Not checked rather than a stale Up; a page that answered only the
 *     confirming retry adds "1 failed try";
 *   • it did not answer twice in a row, and the OS could reach the network →
 *     degraded: Down, with the HTTP status or "No response";
 *   • the OS could not reach the network → Not checked (live without proof);
 *   • never checked yet → the declared state.
 * The operator's own decisions — Not using, Doesn't apply — stand.
 */
export function uptimeState(
  declared: IntegrationState,
  check: HomeCheck | null,
): { effective: IntegrationState; evidence: IntegrationEvidence[] } {
  if (declared === "skipped" || declared === "not-applicable" || check === null) {
    return { effective: declared, evidence: [] };
  }
  if (check.egressDown) {
    return {
      effective: "live",
      evidence: [{ polarity: "supporting", source: "Not checked while offline", detail: "", at: check.observedAt }],
    };
  }
  if (check.httpStatus === 200 || check.status === "ok" || check.status === "warn") {
    // The ingest files nothing on one failed try; the row still says it happened.
    const failed = check.failedTries ?? 0;
    return {
      effective: "live",
      evidence: [{
        polarity: "supporting", source: "Home page answered",
        detail: failed > 0 ? `${failed} failed ${failed === 1 ? "try" : "tries"}` : "", at: check.observedAt,
        verification: { kind: "collection-success", laneId: UPTIME_LANE_ID },
      }],
    };
  }
  return {
    effective: "degraded",
    evidence: [{
      polarity: "against", source: "Home page did not answer",
      detail: check.httpStatus === null ? "No response" : `HTTP ${check.httpStatus}`,
      at: check.observedAt,
    }],
  };
}

/** The compact asset source strip shows catalog-ordered direct evidence inputs,
 * preceded by nightly report when observed or explicitly declined. With neither
 * evidence nor a declaration, the nightly slot is absent. Needs-setup inputs
 * with neither a connection path nor evidence are omitted by unusedWithoutConnectPath;
 * Act, output, and revenue lanes remain in the full register. */
export function buildCardDataSources({
  assetId,
  integrations,
  latestReportAt,
  pull,
  now,
  signalRuns,
  homeCheck,
  isOs = false,
  declaredNoReport = false,
}: {
  assetId: string;
  integrations: IntegrationsConfig;
  latestReportAt: string | null;
  pull: PullConfigEntry | null;
  now: Date;
  signalRuns?: LatestSignalRun[];
  /** The site's newest home-page check, when the caller read it (uptime). */
  homeCheck?: HomeCheck | null;
  isOs?: boolean;
  /** The operator declared this asset sends no nightly report. */
  declaredNoReport?: boolean;
}): CardDataSource[] {
  const sources: CardDataSource[] = [];
  const nightly = nightlyReportState(now.getTime(), latestReportAt, pull, declaredNoReport);
  // A declared asset's slot stays in the strip as Not using, like every other
  // declined source. A site that has never sent a report has no slot.
  if (nightly.effective !== "not-applicable") {
    sources.push({
      id: NIGHTLY_REPORT_LANE_ID,
      label: NIGHTLY_REPORT_LANE.label,
      state: nightly.effective,
      detail: nightly.evidence[0]?.detail,
      observedAt: latestReportAt,
      verification: nightly.evidence[0]?.verification,
    });
  }

  const configured = integrations.assets[assetId] ?? {};
  for (const lane of integrations.catalog) {
    if (!PROPERTY_DATA_SOURCE_IDS.has(lane.id)) continue;
    // The strip reads a cell through the same resolver the matrix does, so a
    // lane the scope rule answers reads Doesn't apply with nothing appended.
    const cell = registerCell(
      configured[lane.id],
      lane.scope ?? "property",
      isOs,
    );
    const declared = cell.status;
    // Uptime's slot reads the same check its Data sources row reads.
    if (lane.id === UPTIME_LANE_ID && homeCheck !== undefined) {
      const { effective, evidence } = uptimeState(declared, homeCheck);
      if (unusedWithoutConnectPath({ laneId: lane.id, effective, evidence })) continue;
      const proof = evidence[0];
      sources.push({
        id: lane.id,
        label: lane.label,
        state: effective,
        detail: proof ? proof.detail || undefined : cell.note ?? undefined,
        observedAt: proof?.at ?? null,
        verification: proof?.verification,
      });
      continue;
    }
    const signalRun =
      signalRuns === undefined
        ? undefined
        : (signalRuns.find((run) => run.integration === lane.id) ?? null);
    const effective = effectiveLaneState(declared, lane.id, signalRun, now.getTime());
    // Not set up, and nothing on Integrations connects it: no slot to fill.
    if (unusedWithoutConnectPath({ laneId: lane.id, effective })) continue;
    const evidence =
      isCollectedSignalLane(lane.id)
        ? signalRunEvidence(lane.id, signalRun ?? null, now.getTime())
        : null;
    sources.push({
      id: lane.id,
      label: lane.label,
      state: effective,
      detail: evidence?.detail ?? cell.note ?? undefined,
      observedAt: evidence?.at ?? null,
      verification: evidence?.verification,
    });
  }
  return sources;
}

/** Provider phrases that mean a part of the call worked — "Ok." is what
 * DataForSEO says about every level that succeeded. On an error row such a
 * message is not the reason for anything. Old rows may still carry them, so
 * the read side refuses them too. */
const PROVIDER_SUCCESS_PHRASES = new Set([
  "ok",
  "success",
  "successful",
  "task created",
  "task handed",
]);

/** The stored message, or — when it reads as a success phrase and so cannot be
 * why the run failed — the run's own error code, stated plainly. */
function storedFailureDetail(message: string | null, fallback: string): string {
  if (message === null) return fallback;
  const normalized = message.trim().replace(/[.!]+$/, "").toLowerCase();
  return PROVIDER_SUCCESS_PHRASES.has(normalized) ? fallback : message;
}

function signalRunEvidence(
  laneId: string,
  run: LatestSignalRun | null,
  nowMs: number,
): IntegrationEvidence {
  const label =
    laneId === "ga4"
      ? "GA4 collector"
      : laneId === "gsc"
        ? "Search Console collector"
        : laneId === "dataforseo"
          ? "DataForSEO collector"
          : laneId === "posthog"
            ? "PostHog collector"
            : laneId === "clarity"
              ? "Clarity collector"
              : "Bing Webmaster collector";
  const provider =
    laneId === "bing-webmaster"
      ? "Bing"
      : laneId === "dataforseo"
        ? "DataForSEO"
        : laneId === "posthog"
          ? "PostHog"
          : laneId === "clarity"
            ? "Clarity"
            : "Google";
  if (!run) {
    // Two facts share this line: a lane that has never collected, and a lane
    // whose last attempt is older than `SIGNAL_EVIDENCE_FLOOR_DAYS`. The
    // sentence states the span it looked over instead of claiming nothing
    // ever happened.
    return {
      polarity: "against",
      source: `${label} has no recent run`,
      detail: noRunsDetail(),
      at: null,
    };
  }
  if (run.status === "error") {
    // The cap is a decision the OS made, not a provider failure; the date it
    // resumes is the fact.
    if (run.errorCode === "budget_exhausted") {
      return {
        polarity: "against",
        source: `${label} stopped at the monthly data cap`,
        detail: `Resumes ${nextMonthStart(nowMs)}`,
        at: run.finishedAt,
      };
    }
    return {
      polarity: "against",
      source: `${label} failed`,
      detail: storedFailureDetail(
        run.errorMessage,
        `${provider} returned ${run.errorCode ?? "an unknown error"}.`,
      ),
      at: run.finishedAt,
    };
  }
  const cadence = signalCadenceHours(laneId);
  const stale = isAmber(nowMs, run.finishedAt, cadence, AMBER_MULTIPLIER);
  // Facts, not sentences: what came back, for which dates, and, while stale,
  // the cadence the row's age is judged against.
  const provisional = run.provisionalFrom === null ? [] : [`provisional from ${run.provisionalFrom}`];
  const returned =
    laneId === "dataforseo"
      ? [`${run.observationCount} report families`, `${formatCount(run.providerRows)} rows`, `${run.windowEnd} snapshot`]
      : laneId === "posthog"
        ? [`${run.observationCount} report families`, `${formatCount(run.providerRows)} rows`, `to ${run.windowEnd}`]
        : laneId === "clarity"
          ? // Clarity only ever answers for the trailing 72 hours, so the date
            // the export ran on is the end of the window it read.
            [`${formatCount(run.providerRows)} behavior rows`, `3 days to ${run.windowEnd}`]
          : [`${formatCount(run.providerRows)} daily rows`, `${run.windowStart} → ${run.windowEnd}`, ...provisional];
  return {
    polarity: stale ? "against" : "supporting",
    source: stale ? `${label} is stale` : `${label} succeeded`,
    detail: facts(stale ? [dueEvery(cadence)] : returned),
    at: run.finishedAt,
    verification: { kind: "collection-success", laneId },
  };
}

/** Facts on one line, the way every evidence row states them. */
function facts(items: readonly string[]): string {
  return items.join(" · ");
}

/** "Due every 15 min", "Due daily": what a stale row's age is measured against. */
function dueEvery(hours: number): string {
  return `Due ${everyLabel(hours).toLowerCase()}`;
}

/** The evidence floor, as the count it looked over. */
function noRunsDetail(): string {
  return `0 runs in ${SIGNAL_EVIDENCE_FLOOR_DAYS} days`;
}

/** The first day of the month after `nowMs`, when the monthly data cap resets. */
function nextMonthStart(nowMs: number): string {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Which lanes the nightly 12:15 UTC archive cron writes manifests for. */
function isArchivedSignalLane(
  laneId: string,
): laneId is ArchiveLaneRun["integration"] {
  return laneId === "ga4" || laneId === "gsc" || laneId === "bing-webmaster";
}

const ARCHIVE_PROVIDER: Record<ArchiveLaneRun["integration"], string> = {
  ga4: "GA4",
  gsc: "Search Console",
  "bing-webmaster": "Bing Webmaster",
};

/**
 * The nightly archive's half of a lane's story. Deliberately quiet: no line
 * for a lane the operator has scoped out, and no "never archived" line for a
 * lane that has no fast-collector run either.
 */
function archiveEvidence(
  laneId: string,
  declared: IntegrationState,
  signalRun: LatestSignalRun | null,
  archiveRuns: ArchiveLaneRun[] | undefined,
  nowMs: number,
): IntegrationEvidence[] {
  if (!isArchivedSignalLane(laneId) || archiveRuns === undefined) return [];
  if (declared === "skipped" || declared === "not-applicable") return [];
  const provider = ARCHIVE_PROVIDER[laneId];
  const run = archiveRuns.find((item) => item.integration === laneId) ?? null;
  if (!run) {
    // The collector's own row already says it is running; this adds only that
    // the archive is not.
    return signalRun
      ? [
          {
            polarity: "against",
            source: "Nightly archive has no recent run",
            detail: noRunsDetail(),
            at: null,
          },
        ]
      : [];
  }
  if (run.status === "error") {
    return [
      {
        polarity: "against",
        source: "Nightly archive failed",
        detail: facts([
          `${run.failedReports} of ${run.reports} report families failed`,
          storedFailureDetail(run.errorMessage, `${provider} returned ${run.errorCode ?? "an unknown error"}`),
        ]),
        at: run.finishedAt,
      },
    ];
  }
  const stale = isAmber(nowMs, run.finishedAt, CADENCE_HOURS.pulse, AMBER_MULTIPLIER);
  return [
    {
      polarity: stale ? "against" : "supporting",
      source: stale ? "Nightly archive is stale" : "Nightly archive succeeded",
      detail: stale
        ? facts([`Newest report ${run.reportDate}`, dueEvery(CADENCE_HOURS.pulse).toLowerCase()])
        : archiveSuccessDetail(run),
      at: run.finishedAt,
    },
  ];
}

/**
 * The success line counts only what the date it names covers. A lane with
 * per-family cadences (Bing, whose `queries` and `pages` are weekly) would
 * otherwise claim every family for today, so the lagging families are
 * subtracted from the count and named with their own date. Lagging is not a
 * fault, so the sentence stays `supporting` and the lane stays green; the
 * DataForSEO roll-up's completeness test is deliberately not applied here.
 */
function archiveSuccessDetail(run: ArchiveLaneRun): string {
  if (run.lagging.length === 0) return facts([`${run.reports} report families`, run.reportDate]);
  // The lagging families, grouped by the date each last carried.
  const byDate = new Map<string, string[]>();
  for (const family of run.lagging) byDate.set(family.reportDate, [...(byDate.get(family.reportDate) ?? []), family.report]);
  return facts([
    `${run.reports - run.lagging.length} of ${run.reports} report families`,
    run.reportDate,
    ...[...byDate].map(([date, reports]) => `${andList(reports)} ${date}`),
  ]);
}

function isCollectedSignalLane(laneId: string): boolean {
  return (
    laneId === "ga4" ||
    laneId === "gsc" ||
    laneId === "bing-webmaster" ||
    laneId === "dataforseo" ||
    laneId === "posthog" ||
    laneId === "clarity"
  );
}

function signalCadenceHours(laneId: string): number {
  return collectionCadenceHours(laneId) ?? CADENCE_HOURS.signals;
}

/** Which register lane a revenue row supports, or null (subs/licensing have
 * no per-asset lane). Affiliate rows disambiguate CJ vs Amazon by source/note;
 * an unknown affiliate defaults to CJ. */
export function laneForRevenueRow(
  family: string,
  source: string | null,
  note: string | null,
): string | null {
  if (family === "ads") return "ad-network";
  if (family === "affiliate") {
    const hay = `${source ?? ""} ${note ?? ""}`.toLowerCase();
    return hay.includes("amazon") ? "affiliate-amazon" : "affiliate-cj";
  }
  return null;
}

function supportingRevenueEvidence(laneId: string, rows: RevenueRow[]): IntegrationEvidence | null {
  const matched = rows.filter((r) => laneForRevenueRow(r.family, r.source, r.note) === laneId);
  if (matched.length === 0) return null;
  const total = moneyFigure(matched.map(row => ({ currency: row.currency, revenueMinor: row.amountMinor, costMinor: 0 })));
  const totalLabel = total.currency === null ? 'Currency unavailable'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: total.currency }).format(total.revenue);
  const latest = matched.reduce((a, b) => (b.period > a.period ? b : a));
  const family = matched[0]!.family;
  // What happened is the source line (the money arrives, but by hand, not by a
  // collector); how much and how recently are the facts.
  return {
    polarity: "supporting",
    source: `${capitalize(family)} revenue added by hand`,
    detail: facts([totalLabel, `latest ${latest.period}`]),
    at: null,
  };
}

// ---------------------------------------------------------------------------
// Cell assembly — one asset's lanes, in catalog order.
// ---------------------------------------------------------------------------
/**
 * One asset's lanes, in catalog order. The register is sparse: a cell the
 * scope rule already answers is not in the file, and `registerCell` generates
 * it here, so the matrix has no holes.
 */
export function buildCells(
  assetId: string,
  laneConfig: Record<string, IntegrationsConfigCell>,
  catalog: IntegrationCatalogRow[],
  ev: LaneEvidence,
  isOs: boolean,
): IntegrationCell[] {
  return catalog.map((lane) => {
    const { status: declared, note, ref, since } = registerCell(
      laneConfig[lane.id],
      lane.scope,
      isOs,
    );
    if (lane.id === 'ad-network' && laneConfig[lane.id]?.mediavineSiteId) {
      // The one rule the sync itself runs.
      const on = mediavineSyncOn({ mediavineSiteId: laneConfig[lane.id]?.mediavineSiteId, status: declared });
      const run = ev.mediavineRun;
      const fresh = run?.outcome === 'success' && (ev.nowMs ?? Date.now()) - Date.parse(run.attempted_at) < 36 * 3_600_000;
      const effective: IntegrationState = !on ? 'skipped' : !run ? 'needs-setup' : fresh ? 'live' : 'degraded';
      const evidence: IntegrationEvidence[] = run ? [{
        polarity: fresh ? 'supporting' : 'against', source: 'Mediavine daily revenue',
        detail: run.message ?? `Estimates stored through ${run.reported_through ?? 'an unknown date'}`,
        at: run.attempted_at, ...(run.outcome === 'success' ? { verification: { kind: 'collection-success' as const, laneId: 'ad-network' } } : {}),
      }] : [];
      return { assetId, laneId: lane.id, declared, effective, evidence,
        note: on ? 'Automatic Mediavine revenue collection is enabled.' : 'Automatic Mediavine revenue collection is paused. Saved history is retained.',
        ref: 'Mediavine', since };
    }
    const { effective, evidence } = mergeLane(declared, lane.id, ev);
    return { assetId, laneId: lane.id, declared, effective, evidence, note, ref, since };
  });
}

export function buildCatalog(rows: IntegrationsConfigCatalogRow[]): IntegrationCatalogRow[] {
  return rows.map((r) => {
    const known = LANE_FACTS[r.id] ?? UNKNOWN_LANE_FACTS;
    return {
      id: r.id,
      label: r.label,
      docRef: r.docRef,
      usage: known.usage,
      onFailure: known.onFailure,
      // Conservative defaults: a lane missing a field claims nothing shared,
      // and is never blanked on an asset.
      scope: r.scope ?? "property",
      layer: r.layer ?? "property",
      credential: r.credential ?? "per-property",
      derived: false,
    };
  });
}

// ---------------------------------------------------------------------------
// The derived nightly-report lane, pure over one asset's store evidence:
//   • a report accepted inside 2× the nightly cadence  → live
//   • the last report is older than that               → degraded
//   • no report has ever been accepted                 → not-applicable
// Staleness uses the same isAmber/CADENCE_HOURS.pulse rule as the Wall's age
// badges. A site that has never sent a report expects none
// (`expectsNightlyReport`); a fetch that is set up and failing says so through
// its own `asset-pull-failed` alert. An asset declared as sending no nightly
// report owes none, so without a current report its lane is `skipped`, never
// degraded; a report it sends anyway still reads live while current
// (`showsNightlyReport`).
// ---------------------------------------------------------------------------
export function nightlyReportState(
  nowMs: number,
  lastReceivedAt: string | null,
  pull: PullConfigEntry | null,
  declaredNoReport = false,
): { effective: IntegrationState; evidence: IntegrationEvidence[] } {
  if (declaredNoReport && !showsNightlyReport(true, lastReceivedAt, nowMs)) {
    return {
      effective: "skipped",
      evidence: [
        {
          polarity: "supporting",
          source: "No nightly report",
          detail: "Off in this site's Settings",
          at: null,
        },
      ],
    };
  }
  // What is left without a report to show is a site that never sent one.
  if (!lastReceivedAt || !showsNightlyReport(declaredNoReport, lastReceivedAt, nowMs)) {
    return {
      effective: "not-applicable",
      evidence: [
        {
          polarity: "supporting",
          source: "No nightly report on record",
          detail: missingReportDetail(pull),
          at: null,
        },
      ],
    };
  }

  // A late report adds the one fact its age is judged against.
  const stale = isAmber(nowMs, lastReceivedAt, CADENCE_HOURS.pulse, AMBER_MULTIPLIER);
  return {
    effective: stale ? "degraded" : "live",
    evidence: [
      {
        polarity: stale ? "against" : "supporting",
        source: "Last nightly report accepted",
        detail: stale ? dueEvery(CADENCE_HOURS.pulse) : "",
        at: lastReceivedAt,
        verification: { kind: "collection-success", laneId: NIGHTLY_REPORT_LANE_ID },
      },
    ],
  };
}

/** How the OS was meant to get a report it never accepted: not fetched at all
 * (the asset would have to send it), fetching switched off, or fetched from an
 * address that has not answered with one — that address is what to check. */
function missingReportDetail(pull: PullConfigEntry | null): string {
  if (!pull) return "No nightly fetch set up";
  if (!pull.enabled) return facts(["Nightly fetch off", pull.url]);
  return facts(["Fetched nightly", pull.url]);
}

/** The derived register row: the nightly lane's state for every matrix column. */
export function buildNightlyReportLane(
  assets: IntegrationAssetRef[],
  lastReportByAsset: Map<string, string>,
  pullConfig: PullConfigEntry[],
  now: Date,
  declaredNoReport: ReadonlySet<string> = new Set(),
): DerivedLaneRow {
  const nowMs = now.getTime();
  const cells: Record<string, IntegrationCellBase> = {};
  for (const a of assets) {
    const pull = pullConfig.find((e) => e.asset === a.id) ?? null;
    const { effective, evidence } = nightlyReportState(
      nowMs,
      lastReportByAsset.get(a.id) ?? null,
      pull,
      declaredNoReport.has(a.id),
    );
    cells[a.id] = { assetId: a.id, laneId: NIGHTLY_REPORT_LANE_ID, effective, evidence };
  }
  return { catalog: NIGHTLY_REPORT_LANE, cells };
}

export function recentSincePeriod(now: Date, monthsBack: number = RECENT_MONTHS_BACK): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * One lane's per-asset mapping, read straight out of the register file.
 * `LANE_MAPPING` decides which fields a lane has; this only reads them. A lane
 * with no entry there gets an empty list and no card section.
 */
function laneMapping(
  laneId: string,
  declared: IntegrationsConfigCell | undefined,
): {
  mapping: LaneMappingValue[];
  mappingLists: LaneMappingList[];
  mappingSource: LaneMappingSource;
} {
  const spec = LANE_MAPPING[laneId];
  if (!spec) return { mapping: [], mappingLists: [], mappingSource: "fallback" };
  const held = (declared ?? {}) as Record<string, unknown>;
  const mapping = spec.fields.map((name) => {
    const value = held[name];
    return {
      name,
      value: typeof value === "string" || typeof value === "number" ? value : null,
    };
  });
  // Structured list fields (PostHog's funnels): carried whole for their own
  // editor, and never counted as "is this lane mapped".
  const mappingLists = (spec.lists ?? []).map((name) => {
    const value = held[name];
    return { name, value: Array.isArray(value) ? (value as unknown[]) : null };
  });
  // Which source answers for this asset, by the same rule the collectors'
  // resolver uses (`workers/ingest/src/lane-mapping.ts`). Any field set is
  // enough, because DataForSEO's two resolve independently.
  const mappingSource: LaneMappingSource = mapping.some(
    (field) => field.value !== null && field.value !== "",
  )
    ? "register"
    : "fallback";
  // The card draws the state and the lane's fallback from `LANE_MAPPING`.
  return { mapping, mappingLists, mappingSource };
}

export function buildAssetIntegrations(
  assetId: string,
  integrations: IntegrationsConfig,
  ev: LaneEvidence,
  sources: CardDataSource[] = [],
  isOs = false,
): AssetIntegrations {
  const catalog = buildCatalog(integrations.catalog);
  const declaredLanes = integrations.assets[assetId] ?? {};
  // A source nothing on Integrations connects is no row a site must answer
  // while it is only Not set up (`unusedWithoutConnectPath`).
  const built = buildCells(assetId, declaredLanes, catalog, ev, isOs);
  const shown = catalog
    .map((cat, i) => ({ cat, cell: built[i]! }))
    .filter(({ cell }) => !unusedWithoutConnectPath(cell));
  const cells = shown.map(({ cell }) => cell);
  const lanes: AssetIntegrationLane[] = shown.map(({ cat, cell }) => {
    // A lane the scope rule answers has no file entry, so it resolves to no
    // mapping and the System's card never grows a property-id field.
    const { mapping, mappingLists, mappingSource } = laneMapping(
      cat.id,
      declaredLanes[cat.id],
    );
    return {
      catalog: cat,
      cell,
      mapping,
      ...(mappingLists.length > 0 ? { mappingLists } : {}),
      mappingSource,
    };
  });
  return { sources, lanes, summary: summarize(cells) };
}

/**
 * How far back every latest-attempt read looks — the one floor the Tower's
 * evidence queries share. `signal_runs` is append-only and kept indefinitely,
 * and a query with no lower bound cannot state how much history it meant to
 * read. Four hundred days is far past every cadence in the system, so a lane
 * quiet for an annual cycle still reports its last-good run; past that it is
 * unwired, and `signalRunEvidence` says so in the floor's own words.
 */
export const SIGNAL_EVIDENCE_FLOOR_DAYS = 400;

/** The floor as an ISO instant, comparable to the stored `finished_at` text. */
export function signalEvidenceFloor(nowMs: number): string {
  return new Date(nowMs - SIGNAL_EVIDENCE_FLOOR_DAYS * 86_400_000).toISOString();
}

/**
 * Latest collector attempt per asset + provider, within the evidence floor.
 * Driven from the (asset, lane) pairs that can exist rather than from the run
 * log: one `LIMIT 1` seek per pair down `signal_runs_latest`, so the read
 * costs the same however long the log grows. Two runs finishing in the same
 * instant: the one written last wins. The lane vocabulary is spelled out so
 * each pair is one seek; DataForSEO is deliberately absent — that lane's
 * evidence is its report manifests, rolled up below.
 */
export async function loadLatestSignalRuns(
  store: WorkspaceStore,
  dataForSeo: DataForSeoLaneContext,
  assetId?: string,
): Promise<Map<string, LatestSignalRun[]>> {
  const floor = signalEvidenceFloor(dataForSeo.nowMs);
  type Run = Omit<LatestSignalRun, never>;
  const rows: LatestSignalRun[] = (
    await store.read((tx) =>
      tx.query<Run>(
        `SELECT r.asset_id AS asset, r.integration, r.status,
                r.finished_at AS "finishedAt",
                r.window_start AS "windowStart",
                r.window_end AS "windowEnd",
                r.data_state AS "dataState",
                r.provisional_from AS "provisionalFrom",
                r.provider_rows AS "providerRows",
                r.observation_count AS "observationCount",
                r.error_code AS "errorCode",
                r.error_message AS "errorMessage"
           FROM noticeos.assets a
          CROSS JOIN (VALUES (1, 'ga4'), (2, 'gsc'), (3, 'bing-webmaster')) AS providers(place, integration)
           JOIN LATERAL (
                SELECT latest.*
                  FROM noticeos.signal_runs latest
                 WHERE latest.workspace_id = a.workspace_id
                   AND latest.asset_id = a.asset_id
                   AND latest.integration = providers.integration
                   AND latest.finished_at >= $1::timestamptz
                 ORDER BY latest.finished_at DESC, latest.run_seq DESC
                 LIMIT 1
              ) r ON true
          ${assetId ? "WHERE a.asset_id = $2" : ""}
          ORDER BY a.asset_id COLLATE "C", providers.place`,
        assetId ? [floor, assetId] : [floor],
      ),
    )
  ).map((row) => ({ ...row, finishedAt: javascriptInstant(row.finishedAt) }));
  // One manifest read for every archive-backed lane, split by integration.
  const dumps = await loadLatestDumpRuns(store, ["dataforseo", "posthog", "clarity"], floor, assetId);
  rows.push(
    ...aggregateDataForSeoRuns(
      dumps.filter((row) => row.integration === "dataforseo"),
      dataForSeo,
    ),
    ...aggregateDailyArchiveRuns(dumps.filter((row) => row.integration === "posthog"), "posthog"),
    ...aggregateDailyArchiveRuns(dumps.filter((row) => row.integration === "clarity"), "clarity"),
  );
  const map = new Map<string, LatestSignalRun[]>();
  for (const row of rows) {
    const list = map.get(row.asset) ?? [];
    list.push(row);
    map.set(row.asset, list);
  }
  return map;
}

/** Latest archive attempt per asset + provider, for the lanes the nightly
 * archive cron covers. Same query as the DataForSEO read, so "latest manifest
 * per report family" means one thing across every archived lane. */
export async function loadLatestArchiveRuns(
  store: WorkspaceStore,
  nowMs: number,
  assetId?: string,
): Promise<Map<string, ArchiveLaneRun[]>> {
  const rows = aggregateArchiveRuns(
    await loadLatestDumpRuns(
      store,
      ARCHIVE_LANE_IDS,
      signalEvidenceFloor(nowMs),
      assetId,
    ),
  );
  const map = new Map<string, ArchiveLaneRun[]>();
  for (const row of rows) {
    const list = map.get(row.asset) ?? [];
    list.push(row);
    map.set(row.asset, list);
  }
  return map;
}

/** The lanes whose nightly archive is a second collector beside a faster one,
 * and so rides as an extra evidence line (`archiveEvidence`). Clarity is not
 * here: its export is the lane's only collector, so its manifests decide the
 * lane's state, and listing it here too would state one attempt twice. */
const ARCHIVE_LANE_IDS: ArchiveLaneRun["integration"][] = [
  "ga4",
  "gsc",
  "bing-webmaster",
];

type LatestDumpReport = {
  asset: string;
  integration: string;
  report: string;
  reportDate: string;
  finishedAt: string;
  status: "success" | "unchanged" | "error";
  providerRows: number;
  errorCode: string | null;
  errorMessage: string | null;
};

/** The one latest-manifest-per-(asset, integration, report) read
 * (`noticeos.archive_runs`). `integrations` is a code-owned constant list,
 * never operator input, so it is inlined. `$1` is the floor; `$2`, with
 * `oneAsset`, the site. The report families a lane writes change with
 * config, so this walks the site list and seeks each site's slice of
 * `archive_runs_finished`: it finds the families by skipping through the
 * index (`min(report) … report > $`) and takes each family's newest attempt
 * with one `LATERAL ... LIMIT 1`. Rows come back ordered by site, lane and
 * family, byte by byte, the order the aggregators rely on. */
export function latestDumpRunsSql(integrations: readonly string[], oneAsset: boolean): string {
  const lanes = integrations.map((id) => `('${id}')`).join(", ");
  return `WITH RECURSIVE lanes(integration) AS (VALUES ${lanes}),
         pairs(workspace_id, asset, integration) AS (
           SELECT a.workspace_id, a.asset_id, lanes.integration
             FROM noticeos.assets a CROSS JOIN lanes
            ${oneAsset ? "WHERE a.asset_id = $2" : ""}
         ),
         families(workspace_id, asset, integration, report) AS (
           SELECT p.workspace_id, p.asset, p.integration,
                  (SELECT min(f.report) FROM noticeos.archive_runs f
                    WHERE f.workspace_id = p.workspace_id AND f.asset_id = p.asset AND f.integration = p.integration)
             FROM pairs p
           UNION ALL
           SELECT r.workspace_id, r.asset, r.integration,
                  (SELECT min(f.report) FROM noticeos.archive_runs f
                    WHERE f.workspace_id = r.workspace_id AND f.asset_id = r.asset AND f.integration = r.integration
                      AND f.report > r.report)
             FROM families r
            WHERE r.report IS NOT NULL
         )
    SELECT d.asset_id AS asset, d.integration, d.report,
           d.report_date AS "reportDate",
           d.finished_at AS "finishedAt", d.status,
           d.provider_rows AS "providerRows",
           d.error_code AS "errorCode",
           d.error_message AS "errorMessage"
      FROM families r
      CROSS JOIN LATERAL (
           SELECT x.asset_id, x.integration, x.report, x.report_date, x.finished_at, x.status,
                  x.provider_rows, x.error_code, x.error_message
             FROM noticeos.archive_runs x
            WHERE x.workspace_id = r.workspace_id AND x.asset_id = r.asset AND x.integration = r.integration
              AND x.report = r.report AND x.finished_at >= $1::timestamptz
            ORDER BY x.finished_at DESC, x.run_seq DESC
            LIMIT 1
         ) d
     WHERE r.report IS NOT NULL
     ORDER BY d.asset_id COLLATE "C", d.integration COLLATE "C", d.report COLLATE "C"`;
}

async function loadLatestDumpRuns(
  store: WorkspaceStore,
  integrations: string[],
  floor: string,
  assetId?: string,
): Promise<LatestDumpReport[]> {
  const rows = await store.read((tx) =>
    tx.query<LatestDumpReport>(latestDumpRunsSql(integrations, Boolean(assetId)), assetId ? [floor, assetId] : [floor]),
  );
  return rows.map((row) => ({ ...row, finishedAt: javascriptInstant(row.finishedAt) }));
}

function aggregateArchiveRuns(rows: LatestDumpReport[]): ArchiveLaneRun[] {
  const byLane = new Map<string, LatestDumpReport[]>();
  for (const row of rows) {
    const key = `${row.asset}\u0000${row.integration}`;
    const reports = byLane.get(key) ?? [];
    reports.push(row);
    byLane.set(key, reports);
  }
  return [...byLane.values()].map((reports) => {
    const failures = reports.filter((report) => report.status === "error");
    const first = failures[0] ?? null;
    const reportDate = reports.map((report) => report.reportDate).sort().at(-1) ?? "";
    // Which families the newest date does not speak for. Recorded, not judged.
    const lagging = reports
      .filter((report) => report.reportDate !== reportDate)
      .map((report) => ({ report: report.report, reportDate: report.reportDate }))
      .sort((a, b) => a.report.localeCompare(b.report));
    return {
      asset: reports[0]!.asset,
      integration: reports[0]!.integration as ArchiveLaneRun["integration"],
      reportDate,
      finishedAt: reports.map((report) => report.finishedAt).sort().at(-1) ?? "",
      status: failures.length > 0 ? "error" : "success",
      reports: reports.length,
      failedReports: failures.length,
      lagging,
      errorCode: first?.errorCode ?? null,
      errorMessage: first?.errorMessage ?? null,
    };
  });
}

/**
 * How long after the newest family lands an older-dated family still reads as
 * "the sweep has not reached it yet" rather than "this week is torn". The
 * weekly sweep is sequential and the tracked SERP panel is one provider call
 * per query, so the panel legitimately carries last week's report_date for a
 * few minutes. Fifteen minutes is well above the sweep and well below the
 * weekly cadence.
 */
const DATAFORSEO_SWEEP_GRACE_MS = 15 * 60_000;

/** The one thing the completeness test needs from config/serp-panel.json: which
 * assets owe a tracked SERP panel. The queries are the weekly collector's
 * business and never cross into the Tower. */
export function serpPanelAssets(
  config: { assets?: Record<string, unknown> } | null | undefined,
): ReadonlySet<string> {
  return new Set(Object.keys(config?.assets ?? {}));
}

/** What the DataForSEO roll-up has to be told, because neither fact is in the
 * manifest rows: which assets owe a panel, and what time it is. */
export interface DataForSeoLaneContext {
  panelAssets: ReadonlySet<string>;
  nowMs: number;
}

function aggregateDataForSeoRuns(
  rows: LatestDumpReport[],
  { panelAssets, nowMs }: DataForSeoLaneContext,
): LatestSignalRun[] {
  const byAsset = new Map<string, LatestDumpReport[]>();
  for (const row of rows) {
    const reports = byAsset.get(row.asset) ?? [];
    reports.push(row);
    byAsset.set(row.asset, reports);
  }
  return [...byAsset.entries()].map(([asset, stored]) => {
    // The snapshot this asset is on, read from every stored row before any
    // family filtering, because it decides which families were due.
    const storedSnapshot = stored
      .map((row) => row.reportDate)
      .sort()
      .at(-1);
    // Judged against what was due on that date, not against today's family
    // list: a family registered last week was never owed by a collection
    // stored last month.
    const expected = dataForSeoReportsFor(asset, panelAssets, storedSnapshot);
    const due = expected.length;
    const reports = stored.filter((row) =>
      expected.includes(row.report as (typeof expected)[number]),
    );

    const sortedDates = reports.map((row) => row.reportDate).sort();
    const sortedFinished = reports.map((row) => row.finishedAt).sort();
    const snapshot = sortedDates.at(-1) ?? "";
    const finishedAt = sortedFinished.at(-1) ?? "";
    // A sweep still in progress is not a torn week. NaN fails the comparison,
    // so an unreadable timestamp is judged.
    const sweeping = nowMs - Date.parse(finishedAt) < DATAFORSEO_SWEEP_GRACE_MS;
    // Families whose newest attempt predates the snapshot the rest of the asset is on.
    const behind = reports
      .filter((row) => row.reportDate !== snapshot)
      .map((row) => row.report)
      .sort();
    const neverAttempted = Math.max(0, due - reports.length);
    const failures = reports
      .filter((row) => row.status === "error")
      .sort((a, b) => a.report.localeCompare(b.report));
    const failure = failures[0];
    const failureFinishedAt = failures
      .map((row) => row.finishedAt)
      .sort()
      .at(-1);
    const incomplete = !sweeping && (neverAttempted > 0 || behind.length > 0);
    // The success line names one snapshot date, so it may only count what belongs to it.
    const current = reports.filter((row) => row.reportDate === snapshot);
    return {
      asset,
      integration: "dataforseo",
      status: failure || incomplete ? "error" : "success",
      // The evidence clock belongs to the failure it names.
      finishedAt: failureFinishedAt ?? finishedAt,
      windowStart: snapshot,
      windowEnd: snapshot,
      dataState: "final",
      provisionalFrom: null,
      providerRows: current.reduce((sum, row) => sum + row.providerRows, 0),
      observationCount: current.filter((row) => row.status !== "error").length,
      errorCode: failure?.errorCode ?? (incomplete ? "dataforseo_incomplete" : null),
      errorMessage:
        (failures.length > 0 ? dataForSeoFailureReason(failures) : null) ??
        (incomplete
          ? incompleteReason(due - neverAttempted, due, behind, snapshot)
          : null),
    };
  });
}

/**
 * A daily archive whose manifests are the lane's collection, rolled up per
 * asset: the newest attempt of each report family. Any family whose newest
 * attempt failed makes the lane's run an error. PostHog's message names every
 * failed family; Clarity has only the one. A family with an older date is not
 * a failure: it may simply no longer be configured.
 */
function aggregateDailyArchiveRuns(
  rows: LatestDumpReport[],
  integration: "posthog" | "clarity",
): LatestSignalRun[] {
  const byAsset = new Map<string, LatestDumpReport[]>();
  for (const row of rows) {
    const reports = byAsset.get(row.asset) ?? [];
    reports.push(row);
    byAsset.set(row.asset, reports);
  }
  return [...byAsset.entries()].map(([asset, reports]) => {
    const windowEnd = reports.map((row) => row.reportDate).sort().at(-1) ?? "";
    const current = reports.filter((row) => row.reportDate === windowEnd);
    const failures = reports
      .filter((row) => row.status === "error")
      .sort((a, b) => a.report.localeCompare(b.report));
    const failureFinishedAt = failures.map((row) => row.finishedAt).sort().at(-1);
    const reason = (failure: LatestDumpReport) =>
      failure.errorMessage ?? failure.errorCode ?? "collection failed";
    return {
      asset,
      integration,
      status: failures.length > 0 ? "error" : "success",
      finishedAt: failureFinishedAt ?? reports.map((row) => row.finishedAt).sort().at(-1) ?? "",
      windowStart: windowEnd,
      windowEnd,
      dataState: "final",
      provisionalFrom: null,
      providerRows: current.reduce((sum, row) => sum + row.providerRows, 0),
      observationCount: current.filter((row) => row.status !== "error").length,
      errorCode: failures[0]?.errorCode ?? null,
      errorMessage:
        failures.length === 0
          ? null
          : integration === "posthog"
            ? failures.map((failure) => `${failure.report}: ${reason(failure)}`).join("; ")
            : failures.map(reason).join("; "),
    } satisfies LatestSignalRun;
  });
}

/** Keep metered failures actionable: the provider's message without the family
 * forces an operator to guess which paid endpoint to retry. Multiple failures
 * are all named so the first one cannot hide the rest. */
function dataForSeoFailureReason(failures: LatestDumpReport[]): string {
  return failures
    .map(
      (failure) =>
        `${failure.report}: ${failure.errorMessage ?? failure.errorCode ?? "collection failed"}`,
    )
    .join("; ");
}

/** Why the lane is short: a family never collected is a wiring question, and
 * a family missing from this snapshot is a collection question. */
function incompleteReason(
  attempted: number,
  due: number,
  behind: string[],
  snapshot: string,
): string {
  const reasons: string[] = [];
  if (attempted < due) reasons.push(`${attempted} of ${due} report families ever collected`);
  if (behind.length > 0) reasons.push(`${andList(behind)} missing from ${snapshot}`);
  return facts(reasons);
}

function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

async function loadRecentRevenue(store: WorkspaceStore, cutoffPeriod: string): Promise<Map<string, RevenueRow[]>> {
  // The ledger's current money entries (`./ledger-history`).
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; family: string; source: string | null; note: string | null; currency: string; amountMinor: bigint; period: string }>(
      `SELECT asset_id AS asset, family, source, note, currency, amount_minor AS "amountMinor", to_char(period_month, 'YYYY-MM') AS period
         FROM noticeos.financial_ledger
        WHERE kind = 'revenue' AND period_month >= $1::date`,
      [`${cutoffPeriod}-01`],
    ),
  );
  const map = new Map<string, RevenueRow[]>();
  for (const r of rows) {
    const list = map.get(r.asset) ?? [];
    list.push({ currency: r.currency, family: r.family, source: r.source, note: r.note, amountMinor: cents(r.amountMinor), period: r.period });
    map.set(r.asset, list);
  }
  return map;
}

type MediavineRun = { asset: string; attempted_at: string; outcome: string; message: string | null; reported_through: string | null };

/**
 * Each asset's latest Mediavine attempt and the last day its daily revenue
 * reaches. Driven from the site list, each part a seek: the latest attempt is
 * a LIMIT 1 down `mediavine_runs_asset`, the one written last winning a tie;
 * `reported_through` is the newest `report_date` in `mediavine_daily_latest`,
 * which holds every day the current-daily view does. A site with no attempt
 * has no row.
 */
export const MEDIAVINE_RUNS_SQL = `SELECT a.asset_id AS asset, r.attempted_at, r.outcome, r.message,
         (SELECT MAX(d.report_date) FROM noticeos.mediavine_daily d
           WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id) AS reported_through
    FROM noticeos.assets a
    JOIN LATERAL (
         SELECT x.attempted_at, x.outcome, x.message FROM noticeos.mediavine_runs x
          WHERE x.workspace_id = a.workspace_id AND x.asset_id = a.asset_id
          ORDER BY x.attempted_at DESC, x.run_seq DESC LIMIT 1) r ON true`;

export async function loadMediavineRuns(store: WorkspaceStore): Promise<Map<string, MediavineRun>> {
  const rows = await store.read((tx) => tx.query<MediavineRun>(MEDIAVINE_RUNS_SQL));
  return new Map(rows.map(row => [row.asset, { ...row, attempted_at: javascriptInstant(row.attempted_at) }]));
}

/** Each site's newest home-page check — its uptime. One LIMIT 1 seek per site
 * down the `(asset, check_id, observed_on)` unique index; the check writes one
 * row a site a day, and the day's row is its latest hour. */
export function homeChecksSql(oneAsset: boolean): string {
  return `SELECT a.asset_id AS asset, h.observed_at AS "observedAt", h.status, h.detail::text AS "detailJson"
    FROM noticeos.assets a
    JOIN LATERAL (
      SELECT x.observed_at, x.status, x.detail FROM noticeos.hygiene_checks x
       WHERE x.workspace_id = a.workspace_id AND x.asset_id = a.asset_id AND x.check_id = 'html-depth'
       ORDER BY x.observed_on DESC LIMIT 1) h ON true
   ${oneAsset ? "WHERE a.asset_id = $1" : ""}`;
}

const HOME_CHECK_STATUSES: ReadonlySet<string> = new Set(["ok", "warn", "error", "unreachable"]);

type HomeCheckRow = { asset: string; observedAt: string; status: string; detailJson: string };

export async function loadHomeChecks(store: WorkspaceStore, assetId?: string): Promise<Map<string, HomeCheck>> {
  const rows = await store.read((tx) =>
    tx.query<HomeCheckRow>(homeChecksSql(assetId !== undefined), assetId === undefined ? [] : [assetId]),
  );
  const checks = new Map<string, HomeCheck>();
  for (const row of rows) {
    // An undefined status means writer and reader diverged: no reading.
    if (!HOME_CHECK_STATUSES.has(row.status)) continue;
    let detail: { http_status?: unknown; egress_down?: unknown; failed_tries?: unknown } = {};
    try {
      detail = JSON.parse(row.detailJson) as typeof detail;
    } catch {
      detail = {};
    }
    checks.set(row.asset, {
      observedAt: javascriptInstant(row.observedAt),
      status: row.status as HomeCheck["status"],
      httpStatus: typeof detail.http_status === "number" ? detail.http_status : null,
      egressDown: detail.egress_down === true,
      failedTries: typeof detail.failed_tries === "number" ? detail.failed_tries : 0,
    });
  }
  return checks;
}

// --- tiny local helpers (server-side; the client has its own formatters) -----
function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

interface EvidenceRequest {
  now: Date;
  integrations: IntegrationsConfig;
  serpPanel: { assets?: Record<string, unknown> };
  assetId?: string;
}
interface CompactRequest extends EvidenceRequest {
  presentation: 'compact';
}
interface FullRequest extends EvidenceRequest {
  presentation: 'full';
  /** Asset detail already reads these rows for other sections. */
  reuse?: {
    revenueRows: ReadonlyMap<string, RevenueRow[]>;
  };
}
interface AssetEvidenceContext {
  latestReportAt: string | null;
  pull: PullConfigEntry | null;
  isOs?: boolean;
  /** The operator declared this asset sends no nightly report. */
  declaredNoReport?: boolean;
}
interface CompactEvidenceRead {
  cards(assetId: string, context: AssetEvidenceContext): CardDataSource[];
}
interface FullEvidenceRead extends CompactEvidenceRead {
  catalog: IntegrationCatalogRow[];
  cells(assetId: string, isOs: boolean): IntegrationCell[];
  asset(assetId: string, context: AssetEvidenceContext): AssetIntegrations;
}

/** Load the evidence needed by a presentation once. A completed query with no
 * rows supplies []; undefined stays reserved for evidence that was not loaded.
 * Compact reads deliberately omit archive, ledger, and revenue-provider reads. */
export function loadIntegrationEvidence(store: WorkspaceStore, request: CompactRequest): Promise<CompactEvidenceRead>;
export function loadIntegrationEvidence(store: WorkspaceStore, request: FullRequest): Promise<FullEvidenceRead>;
export async function loadIntegrationEvidence(store: WorkspaceStore, request: CompactRequest | FullRequest): Promise<CompactEvidenceRead | FullEvidenceRead> {
  const { now, integrations, serpPanel, assetId } = request;
  const assertScope = (id: string) => {
    if (assetId !== undefined && id !== assetId) {
      throw new Error(`Integration evidence was loaded for ${assetId}, not ${id}`);
    }
  };
  const [signalRuns, homeChecks] = await Promise.all([
    loadLatestSignalRuns(store, { panelAssets: serpPanelAssets(serpPanel), nowMs: now.getTime() }, assetId),
    loadHomeChecks(store, assetId),
  ]);
  const compact: CompactEvidenceRead = {
    cards: (id, context) => {
      assertScope(id);
      return buildCardDataSources({ assetId: id, integrations, now,
        ...context, signalRuns: signalRuns.get(id) ?? [],
        homeCheck: homeChecks.get(id) ?? null });
    },
  };
  if (request.presentation === 'compact') return compact;
  const [revenueRows, mediavineRuns, archiveRuns] = await Promise.all([
    request.reuse?.revenueRows ?? loadRecentRevenue(store, recentSincePeriod(now)),
    loadMediavineRuns(store), loadLatestArchiveRuns(store, now.getTime(), assetId),
  ]);
  const evidence = (id: string): LaneEvidence => {
    assertScope(id);
    return {
    revenueRows: revenueRows.get(id) ?? [],
    mediavineRun: mediavineRuns.get(id) ?? null, signalRuns: signalRuns.get(id) ?? [],
    archiveRuns: archiveRuns.get(id) ?? [], homeCheck: homeChecks.get(id) ?? null, nowMs: now.getTime(),
    };
  };
  const catalog = buildCatalog(integrations.catalog);
  return {
    ...compact, catalog,
    cells: (id, isOs) => buildCells(id, integrations.assets[id] ?? {}, catalog, evidence(id), isOs),
    asset: (id, context) => buildAssetIntegrations(id, integrations, evidence(id), compact.cards(id, context), context.isOs),
  };
}
