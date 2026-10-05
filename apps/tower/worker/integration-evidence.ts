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

/**
 * Each catalog lane's cost, event trigger, provider limit and failure posture,
 * as facts (`shared/lane-facts`, bead `ro-ujb9.96.6.2`). The reasoning behind
 * every figure — why a limit binds, how a failure degrades — is doc 11's
 * catalog table (docs/11-integrations.md), not screen copy. A scheduled lane's
 * cadence is `collectionCadenceHours`, so it is not repeated here.
 */
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
// The first DERIVED lane: the nightly self-report pipeline. It has no cell in
// config/integrations.json on purpose — a lane the OS already runs should never
// be able to claim a state the store contradicts, so this row is recomputed from
// the store (last accepted report per asset) + config/pull.json on every
// read. Same shape as a catalog row so the register renders it identically.
//
// Facts only (bead `ro-ujb9.96.6.2`): working means a report accepted inside
// the nightly cadence, which the grid's Runs fact and each cell already show,
// and the per-asset token behind it is doc 06's business, not screen copy.
// ---------------------------------------------------------------------------
const NIGHTLY_REPORT_LANE: IntegrationCatalogRow = {
  id: NIGHTLY_REPORT_LANE_ID,
  layer: "property",
  label: "Nightly report",
  docRef: "docs/02-signal-contract.md",
  // The System reports too: asset #0 self-pulses nightly (doc 06), so this lane
  // is not one the scope rule may blank on the OS row.
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
// Store evidence inputs — the two Phase-0 sources the merge is allowed to read.
// ---------------------------------------------------------------------------
export interface RevenueRow {
  currency: string;
  family: string;
  source: string | null;
  note: string | null;
  /** Integer cents (`amount_minor`, db/0018) — and since db/0020 the ledger's
   * only money column. The evidence line states a total over these rows, so it
   * is added exactly and formatted once. */
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

/** The nightly R2 archive lane's latest attempt for one asset + provider,
 * rolled up over that provider's report families. This is a SECOND observation
 * of an integration the 15-minute collector already observes, so it rides as an
 * extra evidence line on that lane and never becomes a lane of its own — doc 19
 * item 13: a lane derives health only from its own observations. */
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
  /** The families whose newest manifest is dated EARLIER than `reportDate`, with
   * that date, named so a sentence about `reportDate` can exclude them. Under a
   * per-family cadence — Bing's weekly `queries`/`pages` since ro-93u — a family
   * trailing the lane by up to six days is what working looks like, so these are
   * reported, never counted as failures and never a reason to redden the lane. */
  lagging: { report: string; reportDate: string }[];
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * A site's newest home-page reading (`hygiene_checks`, check `html-depth`):
 * the OS's own check of whether the site is up (bead `ro-ujb9.165`). The ingest
 * writes it nightly with the served-layer sweep and every hour on its own
 * (workers/ingest/src/hygiene.ts `runUptimeChecks`).
 */
export interface HomeCheck {
  observedAt: string;
  status: "ok" | "warn" | "error" | "unreachable";
  /** The HTTP status the home page answered with, or null for no answer. */
  httpStatus: number | null;
  /** The OS could not reach the network, so the site was not checked. */
  egressDown: boolean;
  /** GETs that failed in this check: 1 when the page answered only the
   * confirming retry, 2 when the retry failed too (bead `ro-ujb9.180`). */
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
 * still fall back to their file-backed setup posture until they gain an
 * automated source of health evidence — never another lane's alerts (doc 19
 * item 13; uptime reads its own check, `uptimeState`). Kept separate so cards
 * and the full register use exactly the same truth decision. */
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
// The merge — PURE. Collector-backed health comes from the latest run, while
// explicit scope decisions and evidence-free lanes retain their file-backed
// posture. Every observed state carries its WHY; rendering never edits config.
// ---------------------------------------------------------------------------
export function mergeLane(
  declared: IntegrationState,
  laneId: string,
  ev: LaneEvidence,
): { effective: IntegrationState; evidence: IntegrationEvidence[] } {
  // Uptime reads the OS's own home-page check (bead `ro-ujb9.165`), never
  // another lane's alerts: doc 19 item 13, a lane's health is its own
  // observations.
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
        // The nightly archive is the same lane's other collector. It explains
        // the lane; it does not get a vote on its state, because the 15-minute
        // run above is the fresher and more direct observation of the same feed.
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
 * IS THE SITE UP — the uptime source, read from the OS's own check of the
 * site's home page (bead `ro-ujb9.165`). No account and no connect step: the
 * ingest fetches `https://<domain>/` every hour (`runUptimeChecks`) and nightly
 * with the served-layer sweep, and this reads its newest reading.
 *
 *   • it answered (any reading whose fetch got the page, including one too big
 *     or too binary to word-count — the server said 200) → live: Up, dated,
 *     with proof, so the model ages it against the hourly cadence and a check
 *     that stops running reads Not checked rather than a stale Up; a page that
 *     answered only the ingest's confirming retry adds "1 failed try"
 *     (bead `ro-ujb9.180`);
 *   • it did not answer twice in a row, and the OS could reach the network →
 *     degraded: Down, with the HTTP status or "No response";
 *   • the OS could not reach the network → Not checked (live without proof):
 *     the gate's rule, never an accusation;
 *   • never checked yet → the declared state, so a new site's row appears with
 *     its first check (`unusedWithoutConnectPath` keeps an unchecked, undeclared
 *     source off the page, bead `ro-ujb9.133`).
 *
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
    // Up after a failed try (bead `ro-ujb9.180`): the ingest files nothing on
    // one failure, and the row still says it happened.
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
  /** The operator declared this asset sends no nightly report (ro-ujb9.96.8). */
  declaredNoReport?: boolean;
}): CardDataSource[] {
  const sources: CardDataSource[] = [];
  const nightly = nightlyReportState(now.getTime(), latestReportAt, pull, declaredNoReport);
  // A declared asset's slot stays in the strip as Not using — the operator's
  // decision, drawn like every other declined source rather than dropped. A
  // site that has never sent a report has no slot until its first one arrives.
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
    // The sparse register again (bead `ro-9mx`): the strip reads a cell through
    // the same resolver the matrix does, so a lane the scope rule answers reads
    // Doesn't apply on hover with nothing appended — never a description of
    // what live WOULD mean on a lane that can never be live here.
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
    // Not set up, and nothing on Integrations connects it: no slot to fill
    // (`unusedWithoutConnectPath`, bead `ro-ujb9.133`).
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

/** Provider phrases that mean a part of the call WORKED — "Ok." is what
 * DataForSEO says about every level that succeeded. On an error row such a
 * message is not the reason for anything, and repeating it is how a red lane
 * came to explain itself with "Ok." The collector no longer stores them, but
 * rows written before it stopped are permanent, so the read side refuses them
 * too rather than trusting the write side to have been honest. */
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
    // Two facts share this line, and the floor is what makes one sentence honest
    // about both: a lane that has never collected, and a lane whose last attempt
    // is older than `SIGNAL_EVIDENCE_FLOOR_DAYS` and so is no longer in the
    // evidence reads. The second used to be impossible and is now merely
    // improbable — but it must never render as silence, so the sentence states
    // the span it looked over instead of claiming nothing ever happened.
    return {
      polarity: "against",
      source: `${label} has no recent run`,
      detail: noRunsDetail(),
      at: null,
    };
  }
  if (run.status === "error") {
    // The cap is a decision the OS made, not a provider failure: it stopped
    // before spending, which is the guardrail working. Saying "DataForSEO
    // returned budget_exhausted" would blame the provider for our own limit.
    // The date it resumes is the fact; the cap itself is the Health page's
    // Data spend meter.
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
  // FACTS, NOT SENTENCES (bead `ro-ujb9.96.6.2`): what came back, for which
  // dates — the way a sync log states rows and window — and, while stale, the
  // cadence the row's age is judged against. The source line already says
  // whether it worked.
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
 * The nightly archive's half of a lane's story. Until now the largest collector
 * in the OS wrote manifests nothing in the Tower read, so a silently failing
 * archive looked exactly like a healthy one.
 *
 * Deliberately quiet: no line at all for a lane the operator has scoped out, and
 * no "never archived" line for a lane that has no fast-collector run either —
 * the run evidence above already says that lane is not collecting, and a second
 * sentence saying it again would be noise, not information.
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
    // The collector's own row above already says it is running; this row adds
    // only that the archive is not, over the span it looked.
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
 * The success line counts only what the date it names actually covers.
 *
 * A lane on one cadence reads exactly as before — every family carries the named
 * date, so the sentence is the plain count. A lane with per-family cadences
 * (Bing, whose `queries` and `pages` are weekly since ro-93u) would otherwise
 * claim six families for today on the six days of seven when two of them were
 * last collected up to a week ago, so those families are subtracted from the
 * count and named with their own date instead.
 *
 * They are NOT a fault: lagging is what a correctly-working weekly family does,
 * so this sentence stays `supporting` and the lane stays green — the DataForSEO
 * roll-up's completeness test, which reddens on exactly this shape, is
 * deliberately not imported here (ro-90a).
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
    // Since bead `ro-ghis.1`: its health is the daily archive's own attempts.
    laneId === "posthog" ||
    // Since bead `ro-at7t`: the 04:30 export's own manifests. Until then they
    // were written and read by nobody, so a rejected project token left this
    // slot on whatever the register declared.
    laneId === "clarity"
  );
}

function signalCadenceHours(laneId: string): number {
  return collectionCadenceHours(laneId) ?? CADENCE_HOURS.signals;
}

/** Which register lane a revenue row supports, or null (subs/licensing have no
 * per-asset lane). Affiliate rows disambiguate CJ vs Amazon by source/note;
 * unknown affiliate defaults to CJ (the portfolio-primary network; Amazon is
 * off portfolio-wide — doc 11). */
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
 * One asset's lanes, in catalog order.
 *
 * The register is SPARSE since bead `ro-9mx`: a cell the scope rule already
 * answers is not in the file, and `registerCell` generates it here. So this is
 * where "every asset carries every lane" stopped being a file invariant and
 * became a rendering one — the matrix still has no holes, the file no longer
 * has to restate one of two sentences fifteen times to keep it that way.
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
      // The one rule the sync itself runs (bead `ro-ujb9.96.7.6`).
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
      // Default to `asset`: most lanes are a content asset's own surface,
      // and defaulting the other way would silently blank a lane on every
      // asset the moment someone forgot the field.
      scope: r.scope ?? "property",
      // Same conservative default: a lane that fell through to this claims
      // nothing about a shared tier, only about itself. The register's own rows
      // all declare it, and a payload test holds the file to that.
      layer: r.layer ?? "property",
      // Default to per-property: never falsely claim a shared credential exists.
      credential: r.credential ?? "per-property",
      // Everything in the catalog is declared in the register file by definition.
      derived: false,
    };
  });
}

// ---------------------------------------------------------------------------
// The derived nightly-report lane — PURE over one asset's store evidence.
// Each state carries the timestamp it was decided from:
//   • a report accepted inside 2× the nightly cadence  → live
//   • the last report is older than that               → degraded
//   • no report has EVER been accepted                 → not-applicable
// Staleness uses the same isAmber/CADENCE_HOURS.pulse rule as the Wall's age
// badges, so "stale" means one thing across the whole Tower.
//
// A site that has never sent a report expects none (D29 amended 2026-09-23,
// `expectsNightlyReport`, bead `ro-ujb9.121`): nobody set up a sender for it,
// so its lane is not a to-do on Health and its slot leaves the source strip
// until the first report arrives. A fetch that is set up and failing says so
// through its own `asset-pull-failed` alert.
//
// THE OPERATOR'S DECLARATION (bead `ro-ujb9.96.8`): an asset declared as
// sending no nightly report owes none, so without a current report its lane is
// `skipped` — Not using, the operator's decision — never degraded. A report it
// sends anyway still reads live while it is current (`showsNightlyReport`, the
// contract's rule, which the Wall slot reads too).
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

  // The row's age says when; the cell's chip says Working or Overdue. A late
  // report adds the one fact its age is judged against.
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

/** Derive a single asset's integrations section from already-gathered evidence
 * (the asset-detail builder has both the wiring flags and the ledger rows). */
/**
 * One lane's per-asset mapping, read straight out of the register file.
 *
 * `LANE_MAPPING` (beside the `asset-lane` declaration) decides WHICH fields a
 * lane has; this only reads them. A lane with no entry in that table gets an
 * empty list and no card section, which is how most lanes read.
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
  // Structured list fields (PostHog's funnels, bead `ro-ghis.1`): carried whole
  // for their own editor, and never counted as "is this lane mapped".
  const mappingLists = (spec.lists ?? []).map((name) => {
    const value = held[name];
    return { name, value: Array.isArray(value) ? (value as unknown[]) : null };
  });
  // WHICH SOURCE ANSWERS FOR THIS ASSET (bead `ro-vu8d.16`), decided by the same
  // rule the collectors' resolver uses (`workers/ingest/src/lane-mapping.ts`):
  // a value here steers the run, and nothing here leaves the lane on its old
  // source. Any field set is enough, because DataForSEO's two resolve
  // independently — a market stated without a language is still this asset's
  // own answer.
  const mappingSource: LaneMappingSource = mapping.some(
    (field) => field.value !== null && field.value !== "",
  )
    ? "register"
    : "fallback";
  // The card draws the state, and the lane's fallback from `LANE_MAPPING`
  // (bead `ro-ujb9.96.6.4`) — no sentence travels in the payload.
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
  // while it is only Not set up (`unusedWithoutConnectPath`, bead `ro-ujb9.133`).
  const built = buildCells(assetId, declaredLanes, catalog, ev, isOs);
  const shown = catalog
    .map((cat, i) => ({ cat, cell: built[i]! }))
    .filter(({ cell }) => !unusedWithoutConnectPath(cell));
  const cells = shown.map(({ cell }) => cell);
  const lanes: AssetIntegrationLane[] = shown.map(({ cat, cell }) => {
    // A lane the scope rule answers (`not-applicable` derived, no file entry)
    // still resolves to no mapping, because `declaredLanes[id]` is undefined —
    // so the System's card never grows a property-id field to leave blank.
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
 * How far back every latest-attempt read looks — the ONE floor the Tower's
 * evidence queries share, so "the last run" means the same span on the wall, on
 * the integrations matrix, and on an asset page.
 *
 * `signal_runs` gains ~955 rows a day and nothing ever deletes from it (docs/06:
 * append-only, kept indefinitely — it is the calibration corpus). Ranking that
 * whole history to return at most eighteen rows is the growth bead `ro-48p.1`
 * measured, and a query with no lower bound cannot state how much history it
 * meant to read.
 *
 * Four hundred days is deliberately far past every cadence in the system — the
 * fastest lane runs every fifteen minutes and the slowest, DataForSEO, weekly —
 * so a lane that has gone quiet for an entire annual cycle still reports its
 * last-good run, which is what integration health depends on (db/README:235: a
 * new failure degrades the icon without erasing the last-good data). Past that
 * the lane is not stale, it is unwired, and `signalRunEvidence` says so in the
 * floor's own words rather than letting the lane quietly leave the matrix.
 */
export const SIGNAL_EVIDENCE_FLOOR_DAYS = 400;

/** The floor as an ISO instant, comparable to the stored `finished_at` text. */
export function signalEvidenceFloor(nowMs: number): string {
  return new Date(nowMs - SIGNAL_EVIDENCE_FLOOR_DAYS * 86_400_000).toISOString();
}

/**
 * Latest collector attempt per asset + provider, within the evidence floor.
 *
 * Driven from the (asset, lane) pairs that can exist rather than from the run
 * log: one `LIMIT 1` seek per pair down the runs' latest-first index
 * (`signal_runs_latest`: asset, integration, finished_at DESC), so the read
 * costs the same on the first day and the ten-thousandth. Ranking the whole
 * append-only log with ROW_NUMBER() to keep eighteen rows was the shape bead
 * `ro-48p.1` measured as a full index scan. The seek stays deterministic when
 * two runs finish in the same instant: the one written last wins, as on D1.
 *
 * The lane vocabulary is spelled out so each pair is one seek; it is the three
 * the collectors write, and DataForSEO is deliberately absent — that lane's
 * evidence is its report manifests, rolled up below. The runs and the
 * manifests are read on Postgres (`store`, beads ro-ujb9.76.5.3 and
 * ro-ujb9.76.5.4), a site's lanes in that order.
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
  // ONE manifest read for every archive-backed lane (DataForSEO; PostHog since
  // bead `ro-ghis.1`; Clarity since bead `ro-at7t`), split by integration, so a
  // card read still costs the same two queries it did.
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

/** Latest archive attempt per asset + provider, for the three lanes the
 * nightly R2 archive cron covers. Same query as the DataForSEO read above —
 * only the integration filter differs — so "latest manifest per report family"
 * means one thing across every archived lane. */
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

/** The lanes whose nightly archive is a SECOND collector beside a faster one,
 * and so rides as an extra evidence line on that lane (`archiveEvidence`).
 *
 * Clarity is deliberately not here (bead `ro-at7t`): its 04:30 export is the
 * lane's ONLY collector, so its manifests decide the lane's state the way
 * DataForSEO's and PostHog's do — `isCollectedSignalLane` and
 * `loadLatestSignalRuns` read them. Listing it here as well would state one
 * attempt twice on the same cell. */
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

/** The one latest-manifest-per-(asset, integration, report) read, on Postgres
 * (`noticeos.archive_runs`, bead ro-ujb9.76.5.4). `integrations` is a
 * code-owned constant list, never operator input, so it is inlined as the
 * lanes it walks. `$1` is the floor; `$2`, with `oneAsset`, the site.
 *
 * The report families a lane writes are the collector's business and change with
 * config, so this one cannot be driven by a spelled-out pair list the way
 * `loadLatestSignalRuns` is. Instead it walks the site list and seeks each
 * site's slice of the report runs' (site, lane, report, finish) index
 * (`archive_runs_finished`), which is what keeps the ranking off the whole
 * manifest table, and `floor` states how much of that slice it meant to read.
 *
 * HOW IT WALKS THAT SLICE (bead `ro-ujb9.104`). It finds the report families
 * by skipping through the index (`min(report) … report > $`, one seek per
 * family), and takes each family's newest attempt with one bounded seek down
 * that family's (finish) entries (`LIMIT 1`, a `LATERAL` per family), the one
 * written last of two that finished in the same instant. Rows come back
 * ordered by site, lane and family, byte by byte, the order the aggregators
 * rely on. */
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
    // Which families the newest date does NOT speak for. Recorded, not judged:
    // the lane's own health still comes from failures and from the newest
    // finished_at, both of which a slower-cadence family leaves alone.
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
 * "the sweep has not reached it yet" rather than "this week is torn".
 *
 * The weekly sweep is sequential, and the tracked SERP panel is one provider
 * call per tracked query — ~40 of them, 112 seconds on the 2026-07-31 run — so
 * the panel legitimately still carries LAST week's report_date while the five
 * domain families already carry this one. Judging that window as a torn snapshot
 * turned one asset's lane red every Monday for no reason, which is how an
 * operator learns to stop reading the colour.
 *
 * Fifteen minutes is an order of magnitude above the measured sweep and two
 * orders below the weekly cadence, so a week that genuinely lost a family is red
 * within the same hour rather than never.
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
    // The collector decides per asset — a family whose config does not cover
    // the asset is not one of its reports at all — so the completeness test
    // asks the same question. A portfolio constant of 5 meant an asset which
    // stores 6, was never short of anything and the test could not fire for it.
    // The snapshot this asset is ON, read from every stored row before any
    // family filtering, because it is what decides WHICH families were due.
    // Filtering first would make the two mutually dependent.
    const storedSnapshot = stored
      .map((row) => row.reportDate)
      .sort()
      .at(-1);
    // Judged against what was due on that date, not against today's family
    // list. A family registered last week was never owed by a collection
    // stored last month, and counting it as `neverAttempted` would turn every
    // asset's lane amber the day a family is added — accusing the collector
    // of dropping something nobody had asked it for.
    const expected = dataForSeoReportsFor(asset, panelAssets, storedSnapshot);
    const due = expected.length;
    const reports = stored.filter((row) =>
      expected.includes(row.report as (typeof expected)[number]),
    );

    const sortedDates = reports.map((row) => row.reportDate).sort();
    const sortedFinished = reports.map((row) => row.finishedAt).sort();
    const snapshot = sortedDates.at(-1) ?? "";
    const finishedAt = sortedFinished.at(-1) ?? "";
    // A sweep still in progress is not a torn week. An unparseable timestamp is
    // never in flight: NaN fails the comparison, so an unreadable row is judged.
    const sweeping = nowMs - Date.parse(finishedAt) < DATAFORSEO_SWEEP_GRACE_MS;
    // Families whose newest attempt predates the snapshot the rest of the
    // asset is on: either the sweep has not reached them yet, or it never
    // will again.
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
    // The success line names ONE snapshot date, so it may only count what
    // belongs to it — during the in-flight window that is the families that have
    // landed, not the one still carrying last week's date.
    const current = reports.filter((row) => row.reportDate === snapshot);
    return {
      asset,
      integration: "dataforseo",
      status: failure || incomplete ? "error" : "success",
      // The evidence clock belongs to the failure it names. A later successful
      // family must not make an old failure look as though it happened just now.
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
 * A daily archive whose manifests ARE the lane's collection, rolled up per
 * asset: the newest attempt of each report family. PostHog's six families
 * (bead `ro-ghis.1`) and Clarity's one (bead `ro-at7t`, `url-3d`, one call per
 * project per day at 04:30 UTC). Any family whose newest attempt failed makes
 * the lane's run an error — a budget refusal, a refused key or token, a spent
 * daily cap and a missing project are all things the operator acts on. PostHog's
 * message names every failed family; Clarity has only the one, so its message
 * is the stored reason alone. A family with an older date is not a failure: it
 * may simply be one that is no longer configured (a removed funnel list).
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

/** Why the lane is short, in the terms the operator can act on: a family that
 * has never been collected is a wiring question, and a family missing from THIS
 * snapshot is a collection question — so the fact names it rather than
 * reporting that the dates disagree. */
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
  // The ledger's current money entries (`./ledger-history`), on the call's store.
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
 * reaches (beads `ro-ujb9.104`, ro-ujb9.76.5.5).
 *
 * Driven from the site list, each part a seek on the call's store: a site's
 * latest attempt is a LIMIT 1 down `mediavine_runs_asset (workspace, asset,
 * attempted_at)`, the one written last winning a tie, as D1's rowid did; and
 * `reported_through` is the newest `report_date` its daily revenue holds,
 * from `mediavine_daily_latest`. It reads the table rather than
 * `mediavine_current_daily`, and that is the same answer: the view keeps the
 * newest row of every (asset, site, day), so it holds every day the table
 * holds. A site with no attempt has no row.
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

/**
 * Each site's newest home-page check — its uptime (bead `ro-ujb9.165`). One
 * LIMIT 1 seek per site down the `(asset, check_id, observed_on)` unique index
 * its readers need; the check writes one row a site a day, and the day's row
 * is its latest hour. On Postgres (bead ro-ujb9.76.5.8).
 */
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
    // A status the CHECK constraint does not define means writer and reader
    // diverged: no reading rather than a guessed one.
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
  /** The operator declared this asset sends no nightly report (ro-ujb9.96.8). */
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
 * Compact reads deliberately omit archive, ledger, and revenue-provider reads.
 * All of it is read from the call's store (epic ro-ujb9.76).
 */
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
