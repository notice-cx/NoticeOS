import { moneyFigure, minorToMajorUnits, type MinorMoneyFigure } from '@noticeos/contract/money';
import { assetDisplayName } from "@noticeos/contract/asset-name";
import { savedSearchMarket } from "@noticeos/contract/dataforseo";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { readSite, type SiteRecord } from "./asset-registry";
import { loadDailyRevenue } from "./daily-revenue";
import { SCHEDULED_JOBS, scheduleFor, type ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import { MEDIAVINE_REPORTING_CLOCK, yesterdayRevenue } from "../shared/daily-revenue";
import { shiftRevenueDate } from "../shared/revenue-projection";
// AssetDetail payload assembly — the one read behind GET /api/assets/:id.
// Every fact is paired with the file or store table that owns it. Config the
// builder needs is passed in, never read from disk.

import { isAttentionEligible } from "../shared/signal-liveness";
import { deriveAlertEvidence } from "../shared/alert-evidence";
import { countAttentionConditions, reviewAlertConditions } from "./alert-evidence";
import type {
  Ga4EventParamsConfig,
  PullConfigEntry,
  SerpPanelConfig,
  SignalPanelsConfig,
  ValueEventsConfig,
} from "./asset-config";
import {
  countersCadenceHours,
  readCounterReadings,
  resolveCounterCards,
  type CounterReading,
  type CountersConfig,
} from "./counters";
import { FLAG_COLUMNS, type FlagDbRow, flagDbRow, flagInstant, parseRuleInputs, toFlagRecord } from "./flag-records";
import { readFlagReadings, readingsOf, readSiteFetchFailures } from "./flag-evidence";
import { loadNotifiedAt, openFlagsSql, settledAtSql, settledFlagsSql, snoozedFlagsSql } from "./flag-scope";
import { readWatchWindows } from "./watch-window-reader";
import { readPulseCoverage } from "./pulse-history";
import { cents } from "./ledger-history";
import {
  ALL_ASSET_DETAIL_SECTIONS,
  ASSET_VIEW_SECTIONS,
  type AssetDetailFor,
  type AssetDetailResponse,
  type AssetDetailSection,
  type AssetDetailView,
} from "../shared/asset-detail-views";
import { readLatestJobRuns } from "./job-runs";
import { buildPortfolio, buildRules } from "./portfolio-settings";
import { readRecommendationSources } from "./recommendation-evidence";
import type {
  AnnotationItem,
  AnnotationKind,
  AnnotationTimeline,
  AssetDetailPayload,
  AssetInfo,
  AssetStatus,
  BookingState,
  ClaritySnapshot,
  DataForSeoQueryVisibility,
  DataForSeoQueryVisibilityRow,
  ExecutiveEvidence,
  ExecutiveInsight,
  ExecutiveSnapshot,
  FlagRecord,
  FlagsSection,
  HandoffBead,
  HygieneBotAccess,
  HygieneCheckHistory,
  HygieneCheckId,
  HygieneHistory,
  HygieneReading,
  HygieneStatus,
  LedgerFamilyAmount,
  LedgerPeriod,
  LedgerRawRow,
  LedgerRollup,
  LedgerSlice,
  ProductUseMetric,
  ProductUseSnapshot,
  PulseMetric,
  ReclamationSlice,
  ReclamationStatus,
  ReclamationTarget,
  SearchPageLeadingQuery,
  SearchPageMover,
  SearchPageTrends,
  SearchQueryMover,
  SearchQueryProviderTrend,
  SearchQueryTrends,
  SenseMode,
  SerpPanelAioReading,
  SerpPanelQuery,
  SerpPanelSnapshot,
  SiteCounters,
  SuppressedInsight,
  Wiring,
  WiringFlag,
} from "../shared/asset-detail";
import { OWNER, SITE_TOKEN } from "../shared/asset-detail";
import type { JsonValue } from "../shared/changeset";
import type { WatchSeriesHistory } from "../shared/watch-windows";
import { WATCH_CALIBRATION_DAYS } from "../shared/watch-windows";
import { WATCH_SERIES, releasedFreshnessFlag } from "@noticeos/contract";
import { CORRELATION_WINDOW_HOURS } from "../shared/alert-language";
import { loadLatestBeadsSnapshot, type BeadsSnapshot } from "./beads-snapshot";
import { beadsInbox } from "./task-source";
import { type SeriesPoint, type Severity } from "../shared/wall";
import type { IntegrationsConfig } from "../shared/integrations";
import { loadDecisions } from "./decision-actions";
import { loadIntegrationEvidence, recentSincePeriod, serpPanelAssets } from './integration-evidence';
import { parseProductSnapshot } from '../shared/product-snapshot';
import { cardPanelReviewsOf, loadLatestPanelLandings } from "./panel-review";
import { emptySignalTrendSet, loadSignalTrends } from "./signal-trends";

const PROPERTY_SIGNAL_CHART_DAYS = 90;

export interface AssetDetailDeps {
  now: Date;
  /** config/constants.json `flag_defaults`, verbatim (snake_case keys). */
  flagDefaults: Record<string, number | string>;
  /** config/pull.json, verbatim. */
  pullConfig: PullConfigEntry[];
  /** config/constants.json `monthly_caps` (portfolio-wide spend caps). */
  monthlyCaps: { dataUsd: number };
  /** config/constants.json `operator_rate_usd_per_min`. */
  operatorRateUsdPerMin: number;
  /** config/integrations.json, verbatim (per-asset scope/setup posture). */
  integrations: IntegrationsConfig;
  /** config/counters.json, verbatim: whether the asset has an entry in that
   * register and exactly what it is, so a Delete can name and remove it. */
  counters: CountersConfig;
  /** config/serp-panel.json — which assets have a tracked SERP panel. Each
   * entry travels verbatim, because a Delete carries it as the `expect` that
   * guards its removal. */
  serpPanel: SerpPanelConfig;
  /** config/signal-panels.json — the roster of assets whose local signal panel
   * is kept current: whether the asset has an entry and exactly what it is, so
   * a Delete can name and remove it. */
  signalPanels: SignalPanelsConfig;
  /** config/value-events.json — which GA4 events this asset calls value
   * events, so its Sources tab can edit them. */
  valueEvents: ValueEventsConfig;
  /** config/ga4-custom-dimensions.json — the event parameters registered as
   * custom dimensions on this asset's GA4 property. */
  ga4EventParams: Ga4EventParamsConfig;
  /** The operator's clock: config/constants.json `os_time_zone` as saved. It
   * decides where the daily revenue window ends and rides on the payload so
   * the page's own date math uses the same clock. */
  osTimeZone: string;
  /** config/constants.json `no_nightly_report` as saved: whether this asset
   * owes a nightly report, and the whole list the Settings switch writes back
   * as its guard. Absent or null declares none. */
  noNightlyReport?: readonly string[] | null;
  /** config/constants.json `schedules` as saved: the nightly report's time is
   * read from the same schedule the runner arms. Absent or null is every job
   * on its default. */
  schedules?: ScheduleOverrides | null;
}

const HISTORY_LIMIT = 20;
const SERIES_DAYS = 30;

/** How many timeline rows one read carries. A rendering bound, not a truth
 * bound: whatever it leaves out is counted and named on the surface
 * (`AnnotationTimeline.olderCount`). */
const TIMELINE_LIMIT = 200;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExecutiveInsight(value: unknown): value is ExecutiveInsight {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<ExecutiveInsight>;
  return (
    typeof item.key === "string" &&
    ["warning", "recommendation", "discovery", "insight"].includes(item.kind ?? "") &&
    typeof item.title === "string" &&
    typeof item.summary === "string" &&
    typeof item.whyItMatters === "string" &&
    Boolean(item.primary) &&
    typeof item.primary?.value === "string" &&
    typeof item.primary?.label === "string" &&
    ["medium", "high"].includes(item.confidence ?? "") &&
    typeof item.windowStart === "string" &&
    typeof item.windowEnd === "string" &&
    Array.isArray(item.evidence) &&
    item.evidence.every(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.label === "string" &&
        typeof row.value === "string" &&
        (row.detail === undefined || typeof row.detail === "string"),
    ) &&
    isStringArray(item.sources) &&
    typeof item.caveat === "string"
  );
}

/** A suppressed card is three strings and nothing else. A row carrying less
 * than its identity is dropped. */
function isSuppressedInsight(value: unknown): value is SuppressedInsight {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SuppressedInsight>;
  return (
    typeof item.key === "string" &&
    item.key.length > 0 &&
    ["warning", "recommendation", "discovery", "insight"].includes(item.kind ?? "") &&
    typeof item.title === "string" &&
    item.title.length > 0
  );
}

function isSearchQueryMover(value: unknown): value is SearchQueryMover {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SearchQueryMover>;
  return (
    typeof item.query === "string" &&
    typeof item.currentImpressions === "number" &&
    Number.isFinite(item.currentImpressions) &&
    typeof item.previousImpressions === "number" &&
    Number.isFinite(item.previousImpressions) &&
    typeof item.impressionDelta === "number" &&
    Number.isFinite(item.impressionDelta) &&
    typeof item.impressionDeltaPercent === "number" &&
    Number.isFinite(item.impressionDeltaPercent) &&
    typeof item.currentPosition === "number" &&
    Number.isFinite(item.currentPosition) &&
    typeof item.previousPosition === "number" &&
    Number.isFinite(item.previousPosition) &&
    typeof item.positionImprovement === "number" &&
    Number.isFinite(item.positionImprovement)
  );
}

/** A `{label, value, detail}` proof row. `detail` is optional on the wire and
 * stays optional here — a row is allowed to be a bare fact. */
function isExecutiveEvidence(value: unknown): value is ExecutiveEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<ExecutiveEvidence>;
  return (
    typeof row.label === "string" &&
    row.label.length > 0 &&
    typeof row.value === "string" &&
    (row.detail === undefined || typeof row.detail === "string")
  );
}

/** Absent, or an array of proof rows. Absent must parse (an older producer ran
 * no check, which is what `[]` means); a malformed `evidence` value is not
 * absence and fails the whole trend. */
function isOptionalEvidenceList(
  value: unknown,
): value is ExecutiveEvidence[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isExecutiveEvidence))
  );
}

function isSearchQueryProviderTrend(
  value: unknown,
  provider: "google" | "bing",
): value is SearchQueryProviderTrend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trend = value as Partial<SearchQueryProviderTrend>;
  return (
    trend.provider === provider &&
    typeof trend.currentStart === "string" &&
    typeof trend.currentEnd === "string" &&
    typeof trend.previousStart === "string" &&
    typeof trend.previousEnd === "string" &&
    Number.isInteger(trend.daysPerWindow) &&
    (trend.daysPerWindow ?? 0) > 0 &&
    Array.isArray(trend.movers) &&
    trend.movers.every(isSearchQueryMover) &&
    isOptionalEvidenceList(trend.evidence) &&
    typeof trend.source === "string" &&
    typeof trend.caveat === "string"
  );
}

/** Validates, then normalizes: an absent `evidence` key becomes an explicit
 * `[]` so every consumer reads one value for "this lane stated nothing". */
function parseSearchQueryProviderTrend(
  value: unknown,
  provider: "google" | "bing",
): SearchQueryProviderTrend | null {
  if (!isSearchQueryProviderTrend(value, provider)) return null;
  return { ...value, evidence: value.evidence ?? [] };
}

function isDataForSeoQueryVisibilityRow(
  value: unknown,
): value is DataForSeoQueryVisibilityRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<DataForSeoQueryVisibilityRow>;
  return (
    typeof item.query === "string" &&
    typeof item.monthlySearches === "number" &&
    Number.isFinite(item.monthlySearches) &&
    isNullableFiniteNumber(item.organicPosition) &&
    isNullableFiniteNumber(item.previousOrganicPosition) &&
    isNullableFiniteNumber(item.positionImprovement) &&
    isNullableFiniteNumber(item.keywordDifficulty) &&
    isNullableFiniteNumber(item.estimatedVisits) &&
    typeof item.page === "string" &&
    (item.intent === null || typeof item.intent === "string") &&
    ["cited", "present", "none"].includes(item.aiOverview ?? "") &&
    isNullableFiniteNumber(item.aiCitationPosition) &&
    isOptionalPanelAio(item)
  );
}

/** Absent, null, or a boolean. Absent must parse: an older producer is missing
 * evidence, not corrupt evidence. */
function isOptionalBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

/** Three producer vintages, all valid: no panel fields at all, the flat
 * `aioPresent`/`aioCitesUs` pair, and today's `aioDevices` list. Anything else
 * is a corrupt row. */
function isOptionalPanelAio(item: Record<string, unknown>): boolean {
  if (item.aioDevices === undefined) {
    return isOptionalBoolean(item.aioPresent) && isOptionalBoolean(item.aioCitesUs);
  }
  return (
    Array.isArray(item.aioDevices) &&
    item.aioDevices.every(
      (reading) =>
        !!reading &&
        typeof reading === "object" &&
        !Array.isArray(reading) &&
        isOptionalBoolean((reading as SerpPanelAioReading).aioPresent) &&
        isOptionalBoolean((reading as SerpPanelAioReading).aioCitesUs),
    )
  );
}

/**
 * Validates, then normalizes to today's per-device shape. A flat pair becomes
 * one desktop reading, because the collector read only desktop before it read
 * devices (the same call `serpPageDevice()` makes in scripts/signal-archive.mjs).
 * A row carrying neither the pair nor a list becomes an empty list, which is
 * unknown — never a desktop reading of nulls, which would claim a surface was
 * checked.
 */
function parseDataForSeoQueryVisibility(
  value: unknown,
): DataForSeoQueryVisibility | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<DataForSeoQueryVisibility>;
  const valid =
    typeof snapshot.observedAt === "string" &&
    Array.isArray(snapshot.queries) &&
    snapshot.queries.every(isDataForSeoQueryVisibilityRow) &&
    typeof snapshot.source === "string" &&
    typeof snapshot.caveat === "string";
  if (!valid) return null;
  const parsed = snapshot as DataForSeoQueryVisibility;
  return {
    ...parsed,
    queries: parsed.queries.map((query) => {
      const { aioPresent, aioCitesUs } = query as Partial<SerpPanelAioReading>;
      return {
        ...query,
        aioDevices: Array.isArray(query.aioDevices)
          ? query.aioDevices.map(parsePanelAioReading)
          : typeof aioPresent === "boolean" || typeof aioCitesUs === "boolean"
            ? [
                parsePanelAioReading({
                  device: LEGACY_PANEL_DEVICE,
                  aioPresent,
                  aioCitesUs,
                }),
              ]
            : [],
      };
    }),
  };
}

/** The device a row was read on when the producer did not say: the collector
 * read only desktop before it recorded devices. */
const LEGACY_PANEL_DEVICE = "desktop";

function parsePanelAioReading(value: unknown): SerpPanelAioReading {
  const reading = (value ?? {}) as Partial<SerpPanelAioReading>;
  return {
    device:
      typeof reading.device === "string" && reading.device.trim() !== ""
        ? reading.device.trim().toLocaleLowerCase("en-US")
        : LEGACY_PANEL_DEVICE,
    aioPresent: typeof reading.aioPresent === "boolean" ? reading.aioPresent : null,
    aioCitesUs: typeof reading.aioCitesUs === "boolean" ? reading.aioCitesUs : null,
  };
}

/** Providers degrade independently: an absent or malformed
 * google/bing/dataforseo block becomes null and the surviving providers still
 * render. The whole section is null only when the value is not an object or no
 * provider survives. */
function parseSearchQueryTrends(value: unknown): SearchQueryTrends | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trends = value as Partial<SearchQueryTrends>;
  const google = parseSearchQueryProviderTrend(trends.google, "google");
  const bing = parseSearchQueryProviderTrend(trends.bing, "bing");
  const dataforseo = parseDataForSeoQueryVisibility(trends.dataforseo);
  if (google === null && bing === null && dataforseo === null) return null;
  return { google, bing, dataforseo };
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isProductUseMetric(value: unknown): value is ProductUseMetric {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metric = value as Partial<ProductUseMetric>;
  return (
    typeof metric.key === "string" &&
    typeof metric.eventName === "string" &&
    typeof metric.label === "string" &&
    isNullableFiniteNumber(metric.users) &&
    isNullableFiniteNumber(metric.events) &&
    (metric.compareTo === undefined || typeof metric.compareTo === "string") &&
    (metric.comparisonLabel === undefined || typeof metric.comparisonLabel === "string")
  );
}

function parseProductUse(value: unknown): ProductUseSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<ProductUseSnapshot>;
  return (
    typeof snapshot.windowStart === "string" &&
    typeof snapshot.windowEnd === "string" &&
    Number.isInteger(snapshot.days) &&
    (snapshot.days ?? 0) > 0 &&
    Array.isArray(snapshot.build) &&
    snapshot.build.every(isProductUseMetric) &&
    Array.isArray(snapshot.sharing) &&
    snapshot.sharing.every(isProductUseMetric) &&
    Array.isArray(snapshot.supporting) &&
    snapshot.supporting.every(isProductUseMetric) &&
    typeof snapshot.source === "string" &&
    typeof snapshot.caveat === "string"
  )
    ? (snapshot as ProductUseSnapshot)
    : null;
}

type SearchIntelligence = NonNullable<ExecutiveSnapshot["searchIntelligence"]>;

/** The exact keys scripts/signal-insights.mjs writes for each family.
 * Validating names, not a value count, is what makes producer key drift
 * visible. */
const RANKING_KEYS: ReadonlyArray<keyof SearchIntelligence["rankings"]> = [
  "keywords",
  "top3",
  "top10",
  "top20",
  "estimatedVisits",
  "estimatedPaidTrafficCost",
  "aiOverviewReferences",
];
const BACKLINK_KEYS: ReadonlyArray<
  keyof NonNullable<SearchIntelligence["backlinks"]>
> = ["rank", "backlinks", "referringDomains", "newReferringDomains", "lostReferringDomains"];
const AI_KEYS: ReadonlyArray<keyof SearchIntelligence["ai"]> = [
  "googleMentions",
  "googleSearchVolume",
  "chatgptMentions",
  "chatgptSearchVolume",
];

/** The listed keys as finite numbers and nothing else, or null when any of
 * them is missing or unreadable. Picking, rather than validating and
 * forwarding the producer's object, is what keeps an unlisted key from reaching
 * the browser. */
function pickFiniteNumbers<K extends string>(
  value: unknown,
  keys: ReadonlyArray<K>,
): Record<K, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const picked = {} as Record<K, number>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
    picked[key] = candidate;
  }
  return picked;
}

/** The same contract as {@link pickFiniteNumbers}, for figures the producer
 * may state as unknown: each listed key must be present and be a finite number
 * or an explicit null. Null is a reading; a missing key is producer drift and
 * drops the section. */
function pickReportedNumbers<K extends string>(
  value: unknown,
  keys: ReadonlyArray<K>,
): Record<K, number | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const picked = {} as Record<K, number | null>;
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) return null;
    const candidate = record[key];
    if (candidate === null) {
      picked[key] = null;
      continue;
    }
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
    picked[key] = candidate;
  }
  return picked;
}

/** `backlinks` is the one family an asset can genuinely lack (no link report
 * retained), so absent and explicit null both mean null. Every other family is
 * required: a missing or renamed key drops the whole section rather than
 * rendering a partial number set as a complete one. */
function parseSearchIntelligence(
  value: unknown,
): ExecutiveSnapshot["searchIntelligence"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<SearchIntelligence>;
  const observedAt = snapshot.observedAt;
  if (observedAt !== null && typeof observedAt !== "string") return null;
  const costUsd = snapshot.costUsd;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return null;
  const rankings = pickFiniteNumbers(snapshot.rankings, RANKING_KEYS);
  const ai = pickReportedNumbers(snapshot.ai, AI_KEYS);
  if (rankings === null || ai === null) return null;
  const rawBacklinks = snapshot.backlinks ?? null;
  const backlinks =
    rawBacklinks === null ? null : pickFiniteNumbers(rawBacklinks, BACKLINK_KEYS);
  if (rawBacklinks !== null && backlinks === null) return null;
  // The four list families are optional: an asset that has not collected them
  // carries none, and absent normalizes to empty rather than dropping the
  // section, because the other families in the same snapshot are still true.
  return {
    observedAt,
    costUsd,
    rankings,
    backlinks,
    ai,
    referringDomains: Array.isArray(snapshot.referringDomains)
      ? snapshot.referringDomains
      : [],
    anchors: snapshot.anchors ?? null,
    keywordIdeas: Array.isArray(snapshot.keywordIdeas) ? snapshot.keywordIdeas : [],
    competitors: Array.isArray(snapshot.competitors) ? snapshot.competitors : [],
  };
}

/** One panel row, or null when it cannot be trusted to be one. `query` is the
 * only load-bearing string. The rest degrade to unknown rather than dropping
 * the row: a rank that is not a finite number is a rank nobody measured, and
 * anything that is not a literal boolean normalizes to null — never `false`.
 * `device` alone degrades to a value: a block that names no device is a
 * desktop-era row, not a mystery surface. */
function parseSerpPanelComposition(
  value: unknown,
): SerpPanelQuery["composition"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  if (
    typeof block.organicResults !== "number" ||
    !Number.isInteger(block.organicResults) ||
    block.organicResults < 0 ||
    !isStringArray(block.top3Domains) ||
    !isStringArray(block.serpFeatures)
  ) {
    return null;
  }
  return {
    top3Domains: block.top3Domains
      .map((domain) => domain.trim())
      .filter(Boolean)
      .slice(0, 3),
    organicResults: block.organicResults,
    secondRank:
      typeof block.secondRank === "number" &&
      Number.isFinite(block.secondRank) &&
      block.secondRank > 0
        ? block.secondRank
        : null,
    secondUrl:
      typeof block.secondUrl === "string" && block.secondUrl.trim() !== ""
        ? block.secondUrl
        : null,
    serpFeatures: block.serpFeatures
      .map((feature) => feature.trim())
      .filter(Boolean),
  };
}

function parseSerpPanelQuery(value: unknown): SerpPanelQuery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SerpPanelQuery>;
  if (typeof row.query !== "string" || row.query.trim() === "") return null;
  const providerStatus =
    typeof row.providerStatus === "string" && row.providerStatus.trim() !== ""
      ? row.providerStatus.trim()
      : null;
  return {
    query: row.query,
    device:
      typeof row.device === "string" && row.device.trim() !== ""
        ? row.device.trim().toLocaleLowerCase("en-US")
        : LEGACY_PANEL_DEVICE,
    // Missing or blank becomes null; otherwise verbatim, because the label is
    // the operator's own wording and the grouping key.
    label:
      typeof row.label === "string" && row.label.trim() !== ""
        ? row.label.trim()
        : null,
    bestRank:
      typeof row.bestRank === "number" && Number.isFinite(row.bestRank)
        ? row.bestRank
        : null,
    bestUrl: typeof row.bestUrl === "string" && row.bestUrl !== "" ? row.bestUrl : null,
    aioPresent: typeof row.aioPresent === "boolean" ? row.aioPresent : null,
    aioCitesUs: typeof row.aioCitesUs === "boolean" ? row.aioCitesUs : null,
    // Missing on an older snapshot and null on a provider-unread page. Both
    // render no neighborhood rather than a confident empty one.
    composition: parseSerpPanelComposition(row.composition),
    ...(providerStatus
      ? {
          providerStatus,
          providerAttempts:
            typeof row.providerAttempts === "number" &&
            Number.isFinite(row.providerAttempts) &&
            row.providerAttempts >= 1
              ? Math.floor(row.providerAttempts)
              : 1,
        }
      : {}),
  };
}

/**
 * The tracked-query panel block, or null. Absent is the answer for most
 * assets: no `config/serp-panel.json` entry means no block published, and the
 * page renders nothing rather than an empty scoreboard. "No panel" and
 * "producer has not caught up" are deliberately not told apart. A malformed
 * block is absent too, never a thrown page: this is JSON written by a separate
 * process, and it must not be able to take the asset page down. `trackedDepth`
 * rides through as `number | null` untouched; defaulting it would invent a
 * depth the pull never recorded.
 */
function parseSerpPanel(value: unknown): SerpPanelSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Partial<SerpPanelSnapshot>;
  if (typeof block.reportDate !== "string" || block.reportDate === "") return null;
  if (!Array.isArray(block.queries)) return null;
  const queries = block.queries
    .map(parseSerpPanelQuery)
    .filter((row): row is SerpPanelQuery => row !== null);
  // A panel with no readable row is not a panel with a score of zero.
  if (queries.length === 0) return null;
  return {
    reportDate: block.reportDate,
    trackedDepth:
      typeof block.trackedDepth === "number" && Number.isFinite(block.trackedDepth)
        ? block.trackedDepth
        : null,
    // Absent on an older snapshot, or unreadable: null, and the caption names
    // no market rather than a guessed one.
    market: savedSearchMarket(block.market),
    queries,
  };
}

/**
 * The page-grain decision evidence, or null. Same degradation contract as
 * `parseSerpPanel`: absent is ordinary (an older snapshot, or an asset without
 * two complete weeks), and a malformed block is absent too, never a thrown
 * page. Rows degrade one at a time, unlike `serpPanel`'s all-or-nothing
 * queries: each page is an independent decision row. A block whose rows all
 * fail is null — a comparison nothing survived is not one that found no
 * movement.
 */
function parseSearchPageMover(value: unknown): SearchPageMover | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SearchPageMover>;
  if (typeof row.page !== "string" || row.page === "") return null;
  if (typeof row.path !== "string" || row.path === "") return null;
  const finite = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isFinite(candidate);
  if (
    !finite(row.currentClicks) ||
    !finite(row.previousClicks) ||
    !finite(row.clickDelta) ||
    !finite(row.currentImpressions) ||
    !finite(row.previousImpressions) ||
    !finite(row.impressionDelta) ||
    !finite(row.impressionDeltaPercent) ||
    !finite(row.currentCtr) ||
    !finite(row.previousCtr) ||
    !isNullableFiniteNumber(row.clickDeltaPercent) ||
    !isNullableFiniteNumber(row.currentPosition) ||
    !isNullableFiniteNumber(row.previousPosition) ||
    !isNullableFiniteNumber(row.positionImprovement)
  ) {
    return null;
  }
  return {
    page: row.page,
    path: row.path,
    currentClicks: row.currentClicks,
    previousClicks: row.previousClicks,
    clickDelta: row.clickDelta,
    clickDeltaPercent: row.clickDeltaPercent,
    currentImpressions: row.currentImpressions,
    previousImpressions: row.previousImpressions,
    impressionDelta: row.impressionDelta,
    impressionDeltaPercent: row.impressionDeltaPercent,
    currentPosition: row.currentPosition,
    previousPosition: row.previousPosition,
    positionImprovement: row.positionImprovement,
    currentCtr: row.currentCtr,
    previousCtr: row.previousCtr,
    leadingQuery: parseSearchPageLeadingQuery(row.leadingQuery),
  };
}

/** Null for an absent, malformed, or unnamed leading query — the page keeps
 * its own numbers and says nothing about what it ranks for. */
function parseSearchPageLeadingQuery(value: unknown): SearchPageLeadingQuery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const query = value as Partial<SearchPageLeadingQuery>;
  if (typeof query.query !== "string" || query.query.trim() === "") return null;
  if (
    typeof query.impressions !== "number" ||
    !Number.isFinite(query.impressions) ||
    typeof query.clicks !== "number" ||
    !Number.isFinite(query.clicks) ||
    !isNullableFiniteNumber(query.position)
  ) {
    return null;
  }
  return {
    query: query.query,
    impressions: query.impressions,
    clicks: query.clicks,
    position: query.position,
    // An unreadable list is an empty list: "not tracked", never a reading.
    aioDevices: Array.isArray(query.aioDevices)
      ? query.aioDevices.map(parsePanelAioReading)
      : [],
  };
}

function parseSearchPages(value: unknown): SearchPageTrends | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Partial<SearchPageTrends>;
  if (
    typeof block.currentStart !== "string" ||
    typeof block.currentEnd !== "string" ||
    typeof block.previousStart !== "string" ||
    typeof block.previousEnd !== "string" ||
    !Number.isInteger(block.daysPerWindow) ||
    (block.daysPerWindow ?? 0) <= 0 ||
    typeof block.source !== "string" ||
    typeof block.caveat !== "string" ||
    !Array.isArray(block.pages)
  ) {
    return null;
  }
  const pages = block.pages
    .map(parseSearchPageMover)
    .filter((row): row is SearchPageMover => row !== null);
  if (pages.length === 0) return null;
  return {
    provider: "google",
    currentStart: block.currentStart,
    currentEnd: block.currentEnd,
    previousStart: block.previousStart,
    previousEnd: block.previousEnd,
    daysPerWindow: block.daysPerWindow as number,
    pages,
    // A lane that states nothing and a lane whose statement was lost are both
    // `[]`; never a fabricated row claiming a check that did not run.
    evidence: Array.isArray(block.evidence)
      ? block.evidence.filter(
          (row): row is ExecutiveEvidence =>
            Boolean(row) &&
            typeof row === "object" &&
            typeof (row as ExecutiveEvidence).label === "string" &&
            typeof (row as ExecutiveEvidence).value === "string",
        )
      : [],
    source: block.source,
    caveat: block.caveat,
  };
}

/** A nullable date field the producer may not have written: `JSON.stringify`
 * drops an undefined key, so a missing window arrives without the key at all. */
function isAbsentOrString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function parseClaritySnapshot(value: unknown): ClaritySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Partial<ClaritySnapshot>;
  const count = (one: unknown): one is number | null => one === null || (typeof one === "number" && Number.isSafeInteger(one) && one >= 0);
  if (block.source !== "clarity" || block.windowHours !== 72 || typeof block.truncated !== "boolean"
    || typeof block.reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(block.reportDate)
    || !Number.isFinite(Date.parse(`${block.reportDate}T00:00:00.000Z`))
    || new Date(`${block.reportDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== block.reportDate
    || !(block.collectedAt === null || (typeof block.collectedAt === "string" && Number.isFinite(Date.parse(block.collectedAt))))
    || !count(block.unattributedSessions)) return null;
  let page: ClaritySnapshot["page"] = null;
  if (block.page !== null) {
    if (!block.page || typeof block.page !== "object" || Array.isArray(block.page)
      || typeof block.page.url !== "string" || !count(block.page.sessions) || !count(block.page.scriptErrors)) return null;
    try {
      const url = new URL(block.page.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".")) return null;
      page = { url: url.href, sessions: block.page.sessions, scriptErrors: block.page.scriptErrors };
    } catch { return null; }
  }
  return { source: "clarity", reportDate: block.reportDate, collectedAt: block.collectedAt,
    windowHours: 72, truncated: block.truncated, page, unattributedSessions: block.unattributedSessions };
}

function parseExecutiveSnapshot(json: string | null, asset: string): ExecutiveSnapshot | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const snapshot = value as Partial<ExecutiveSnapshot>;
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.asset !== asset ||
      typeof snapshot.generatedAt !== "string" ||
      // An absent window nulls one field; it never discards the analysis.
      !isAbsentOrString(snapshot.windowStart) ||
      !isAbsentOrString(snapshot.windowEnd) ||
      typeof snapshot.sourceArchiveCount !== "number" ||
      !Number.isInteger(snapshot.sourceArchiveCount) ||
      !Array.isArray(snapshot.items) ||
      !Array.isArray(snapshot.methodology)
    ) {
      return null;
    }
    // Every field is named and copied across, never spread: a key this parser
    // has not reviewed does not reach the browser.
    return {
      schemaVersion: 1,
      asset,
      generatedAt: snapshot.generatedAt,
      windowStart: snapshot.windowStart ?? null,
      windowEnd: snapshot.windowEnd ?? null,
      sourceArchiveCount: snapshot.sourceArchiveCount,
      // The top-level shape is a hard gate; individual rows are not: one
      // malformed insight is dropped, never a whole analysis.
      items: snapshot.items.filter(isExecutiveInsight),
      // Not a hard gate either, and absent on an older snapshot.
      suppressedItems: Array.isArray(
        (snapshot as { suppressedItems?: unknown }).suppressedItems,
      )
        ? (snapshot as { suppressedItems: unknown[] }).suppressedItems.filter(
            isSuppressedInsight,
          )
        : [],
      methodology: snapshot.methodology.filter(
        (line): line is string => typeof line === "string",
      ),
      searchQueries: parseSearchQueryTrends(
        (snapshot as { searchQueries?: unknown }).searchQueries,
      ),
      searchPages: parseSearchPages(
        (snapshot as { searchPages?: unknown }).searchPages,
      ),
      productUse: parseProductUse(
        (snapshot as { productUse?: unknown }).productUse,
      ),
      searchIntelligence: parseSearchIntelligence(
        (snapshot as { searchIntelligence?: unknown }).searchIntelligence,
      ),
      serpPanel: parseSerpPanel((snapshot as { serpPanel?: unknown }).serpPanel),
      product: parseProductSnapshot((snapshot as { product?: unknown }).product),
      clarity: parseClaritySnapshot((snapshot as { clarity?: unknown }).clarity),
    };
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
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

interface MetricEntry {
  last24h?: unknown;
  avg7d?: unknown;
  total?: unknown;
}

function parseMetrics(envelope: string): Record<string, MetricEntry> {
  try {
    const v = JSON.parse(envelope) as { metrics?: unknown };
    const m = v?.metrics;
    return m && typeof m === "object" ? (m as Record<string, MetricEntry>) : {};
  } catch {
    return {};
  }
}

interface LedgerDbRow {
  currency: string;
  id: number;
  kind: string;
  period: string;
  family: string;
  /** Integer cents (`amount_minor`). Every figure this page states is added
   * here and divided by 100 once, at the edge. */
  amountMinor: number;
  bookingState: string;
  source: string | null;
  ref: string | null;
  note: string | null;
  recordedAt: string;
}

/**
 * One per-asset string list out of a config register, keeping absence and
 * emptiness apart: `null` is "this asset has no entry" (the first Add files the
 * entry), `[]` is an entry that declares nothing (an Add appends). Collapsing
 * them would make the Tower write the wrong op. A value that is not an array
 * of strings reads as `null` rather than being repaired, so config drift stays
 * visible.
 */
function stringListEntry(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/**
 * The tracked terms inside an asset's `config/serp-panel.json` entry — `null`
 * when the asset has no entry at all. Same three-state rule as
 * `stringListEntry`, but a term is a bare string or `{query, label}`, in any
 * mix, so the rows travel as stored. An entry whose `queries` is not an array
 * reads as `[]`: the entry exists, which is the fact the write depends on.
 */
function trackedQueriesOf(entry: unknown): JsonValue[] | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const queries = (entry as { queries?: unknown }).queries;
  return Array.isArray(queries) ? (queries as JsonValue[]) : [];
}

function buildWiring(
  asset: SiteRecord,
  pullConfig: PullConfigEntry[],
  lastPulse: { date: string; receivedAt: string } | null,
  pullFailure: WiringFlag | null,
  ingestFreshness: WiringFlag | null,
  schedules: ScheduleOverrides | null,
): Wiring {
  const entryIndex = pullConfig.findIndex((e) => e.asset === asset.id);
  const entry = entryIndex >= 0 ? pullConfig[entryIndex] : null;
  const mode: SenseMode = entry ? "pull" : "push";

  // Which job makes the nightly report and its schedule as saved, read the way
  // the runner reads it (`scheduleFor`). A pushing asset sends on its own clock.
  const jobId = entry ? "pull" : asset.isOs === 1 ? "asset-zero" : null;
  const job = jobId === null ? undefined : SCHEDULED_JOBS.find((candidate) => candidate.id === jobId);
  const schedule = job === undefined ? null : { job: job.id, ...scheduleFor(job, schedules ?? {}) };

  return {
    mode,
    modeOwner: OWNER.pull,
    cadence: "nightly",
    schedule,
    cadenceOwner: OWNER.ingest,
    pull: entry
      ? {
          index: entryIndex,
          url: entry.url,
          enabled: entry.enabled,
          format: entry.format,
          metricMap: entry.metrics
            ? Object.entries(entry.metrics).map(([metric, def]) => ({
                metric,
                counter: def.counter,
              }))
            : null,
          auth: SITE_TOKEN,
          authOwner: OWNER.ingestSecrets,
        }
      : null,
    push: entry
      ? null
      : {
          endpoint: "POST /api/pulse",
          endpointOwner: OWNER.ingest,
          auth: SITE_TOKEN,
          authOwner: OWNER.ingestSecrets,
        },
    lastPulseReceivedAt: lastPulse?.receivedAt ?? null,
    lastPulseDate: lastPulse?.date ?? null,
    pullFailure,
    ingestFreshness,
  };
}

/** This asset's annotations in the correlation window before any of
 * `firedAts` — one bounded read for the whole page; empty when the asset has
 * no alerts. */
async function readAlertChanges(
  store: WorkspaceStore,
  asset: string,
  firedAts: string[],
): Promise<AnnotationItem[]> {
  const times = firedAts.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return [];
  const from = new Date(Math.min(...times) - CORRELATION_WINDOW_HOURS * 3_600_000).toISOString();
  const to = new Date(Math.max(...times)).toISOString();
  // Two changes at one instant come newest-filed first.
  return (
    await store.read((tx) =>
      tx.query<AnnotationStoreRow>(
        `SELECT annotation_number::int AS id, at, kind, ref, note
           FROM noticeos.annotations
          WHERE asset_id = $1 AND at >= $2::timestamptz AND at <= $3::timestamptz
          ORDER BY at DESC, annotation_number DESC`,
        [asset, from, to],
      ),
    )
  ).map(annotationItem);
}

/** An annotation as the store returns it. */
type AnnotationStoreRow = { id: number; at: string; kind: string; ref: string | null; note: string | null };

function annotationItem(row: AnnotationStoreRow): AnnotationItem {
  return {
    id: row.id,
    at: javascriptInstant(row.at),
    kind: row.kind as AnnotationKind,
    ref: row.ref,
    note: row.note,
  };
}

/**
 * The timeline rows, newest first, down to the wider of `TIMELINE_LIMIT` and
 * the oldest watch-anchored change ($1 the asset, $2 the limit). See
 * `readAnnotationTimeline`. A window anchors a change when its ref is exactly
 * the change's number written out in canonical digits. Those refs are picked
 * out first (`anchors`, materialized so no other ref is ever cast), and each
 * is then a seek in its own subquery (`OFFSET 0`): joined in, Postgres would
 * rather walk the site's changes and filter them by number.
 */
export const TIMELINE_ITEMS_SQL = `WITH anchors AS MATERIALIZED (
            SELECT w.ref::bigint AS number
              FROM noticeos.watch_windows w
             WHERE w.asset_id = $1 AND w.ref_kind = 'annotation' AND w.ref ~ '^[1-9][0-9]{0,17}$'
          )
          SELECT n.annotation_number::int AS id, n.at, n.kind, n.ref, n.note
            FROM noticeos.annotations n
           WHERE n.asset_id = $1
           ORDER BY n.at DESC, n.annotation_number DESC
           LIMIT GREATEST($2::int, (
             SELECT count(*)
               FROM noticeos.annotations a
              WHERE a.asset_id = $1
                AND a.at >= (
                  SELECT min(anchor.at)
                    FROM anchors
                    CROSS JOIN LATERAL (
                      SELECT x.at, x.asset_id
                        FROM noticeos.annotations x
                       WHERE x.annotation_number = anchors.number
                      OFFSET 0) anchor
                   WHERE anchor.asset_id = $1
                )
           ))`;

/** Every annotation this asset holds, counted on the (asset, at) index alone. */
export const TIMELINE_TOTAL_SQL = `SELECT count(*)::int AS total FROM noticeos.annotations WHERE asset_id = $1`;

/**
 * This asset's timeline: newest first, contiguous, and honest about its own
 * end. Two things bound the read, and the wider wins: `TIMELINE_LIMIT`, and
 * every annotation a watch window on this asset points at — a registered
 * window names a cause, and the timeline must be able to show it. An anchored
 * change pulls the floor down to itself however old it is, and the list stays
 * contiguous. `olderCount` is what the read did not carry; it is rendered,
 * not swallowed. The asset's total is counted only when the timeline is full,
 * since a shorter one holds every row.
 */
async function readAnnotationTimeline(
  store: WorkspaceStore,
  asset: string,
): Promise<AnnotationTimeline> {
  // With no anchored change the inner min is NULL, `at >= NULL` is NULL, the
  // count is 0 and the plain cap applies.
  const items = (
    await store.read((tx) => tx.query<AnnotationStoreRow>(TIMELINE_ITEMS_SQL, [asset, TIMELINE_LIMIT]))
  ).map(annotationItem);

  // A timeline shorter than the cap already holds every row this asset has.
  const total =
    items.length < TIMELINE_LIMIT
      ? items.length
      : ((await store.read((tx) => tx.query<{ total: number }>(TIMELINE_TOTAL_SQL, [asset])))[0]?.total ?? 0);
  return { items, olderCount: Math.max(0, total - items.length) };
}

/** The funnel in order. `skip` and `dead` are terminal exits from it, counted
 * but never rendered as stages. */
const RECLAMATION_FUNNEL: ReclamationStatus[] = [
  "queued",
  "sent",
  "opened",
  "clicked",
  "replied",
  "won",
  "skip",
  "dead",
];

/** How many targets the strip lists; the campaign itself is worked in the
 * import lane. */
const RECLAMATION_TARGET_LIMIT = 10;

/**
 * This asset's link-outreach pipeline, read-only: status changes arrive
 * through `scripts/reclamation-import.mjs`. Returns null when the asset has no
 * rows at all, so the section renders nothing.
 */
async function readReclamationTargets(
  store: WorkspaceStore,
  asset: string,
): Promise<ReclamationSlice | null> {
  const [counted, moved] = await store.read(async (tx) => [
    await tx.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count
         FROM noticeos.reclamation_targets
        WHERE asset_id = $1
        GROUP BY status`,
      [asset],
    ),
    // `skip` rows are a do-not-pitch reference list, so they stay out of the
    // list while still counting toward the total. A target never touched has
    // no `status_at` and sorts last.
    await tx.query<{ id: string; domain: string; status: string; statusAt: string | null }>(
      `SELECT target_number::text AS id, domain, status, status_at AS "statusAt"
         FROM noticeos.reclamation_targets
        WHERE asset_id = $1 AND status <> 'skip'
        ORDER BY status_at DESC NULLS LAST, domain COLLATE "C" ASC, target_id
        LIMIT $2`,
      [asset, RECLAMATION_TARGET_LIMIT],
    ),
  ] as const);
  if (counted.length === 0) return null;

  const byStatus = new Map(counted.map((row) => [row.status, row.count]));
  const counts = RECLAMATION_FUNNEL.flatMap((status) => {
    const count = byStatus.get(status) ?? 0;
    // A stage with no rows is omitted: an unstarted stage is not a measurement.
    return count > 0 ? [{ status, count }] : [];
  });

  const recent = moved.map(
    (row): ReclamationTarget => ({
      id: Number(row.id),
      domain: row.domain,
      status: row.status as ReclamationStatus,
      statusAt: row.statusAt === null ? null : javascriptInstant(row.statusAt),
    }),
  );

  return {
    counts,
    total: counted.reduce((sum, row) => sum + row.count, 0),
    recent,
  };
}

/**
 * This asset's own recent daily values for every measurable watch series it
 * reports, read the way the evaluator reads: `signal_observations` is
 * append-only and a provider revision appends a new row for the same (date,
 * metric), so the query mirrors `aggregateMetric`'s ordering — date, then run
 * finish, then row id — and the last write for a date wins. It does not
 * filter on run status either, because the evaluator does not.
 *
 * Each integration reads only its current property, the `property_ref` of its
 * latest successful run; the old property's days read as gaps, so the noise
 * floor offered is that of the resource the watch will be judged on.
 *
 * A series with no rows in the window is absent from the result rather than
 * present-and-empty: "does not report" and "reports zeros" are different facts.
 */
async function readWatchSeriesHistory(
  store: WorkspaceStore,
  asset: string,
  now: number,
): Promise<WatchSeriesHistory[]> {
  const lastDay = new Date(now).toISOString().slice(0, 10);
  const firstDay = new Date(now - (WATCH_CALIBRATION_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [observationRows, changeRead] = await Promise.all([
    // MATERIALIZED: each provider's current property is one seek, made once.
    store.read((tx) =>
      tx.query<{
        integration: string;
        metric: string;
        date: string;
        value: number | null;
      }>(
        `WITH current_property AS MATERIALIZED (
           SELECT providers.integration,
                  (SELECT latest.property_ref
                     FROM noticeos.signal_runs latest
                    WHERE latest.asset_id = $1
                      AND latest.integration = providers.integration
                      AND latest.status = 'success'
                    ORDER BY latest.finished_at DESC, latest.run_seq DESC
                    LIMIT 1) AS property_ref
             FROM (VALUES ('ga4'), ('gsc'), ('bing-webmaster')) AS providers(integration)
         )
         SELECT s.integration, s.metric, o.observed_date AS date, o.value
           FROM current_property current
           JOIN noticeos.measurement_series s
             ON s.asset_id = $1 AND s.integration = current.integration AND s.property_ref = current.property_ref
           JOIN noticeos.signal_observations o
             ON o.workspace_id = s.workspace_id AND o.series_id = s.series_id
            AND o.observed_date >= $2::date AND o.observed_date <= $3::date
           JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
          ORDER BY o.observed_date, r.finished_at, o.observation_id`,
        [asset, firstDay, lastDay],
      ),
    ),
    // Full-horizon annotation calendar: the visible timeline is capped, and
    // reusing it would turn every older row into a silently quiet day. Bounded
    // on the instant so the (site, time) index seeks it.
    store.read((tx) =>
      tx.query<{ day: string }>(
        `SELECT DISTINCT (at AT TIME ZONE 'UTC')::date AS day
           FROM noticeos.annotations
          WHERE asset_id = $1 AND at >= $2::date AND at < $3::date + 1
          ORDER BY day ASC`,
        [asset, firstDay, lastDay],
      ),
    ),
  ]);
  const rows = observationRows;
  const recordedChanges = {
    firstDay,
    lastDay,
    days: changeRead.map((row) => row.day),
    complete: true,
  } as const;

  const bySeries = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = `${row.integration}:${row.metric}`;
    const value = num(row.value);
    if (value === null) continue;
    const days = bySeries.get(key) ?? new Map<string, number>();
    days.set(row.date, value);
    bySeries.set(key, days);
  }

  // WATCH_SERIES' order, not the store's: the composer walks the same list.
  return WATCH_SERIES.flatMap((series) => {
    const days = bySeries.get(`${series.integration}:${series.metric}`);
    if (!days || days.size === 0) return [];
    const values: (number | null)[] = [];
    for (let offset = 0; offset < WATCH_CALIBRATION_DAYS; offset += 1) {
      const day = new Date(
        Date.parse(`${firstDay}T00:00:00.000Z`) + offset * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      values.push(days.get(day) ?? null);
    }
    return [
      {
        integration: series.integration,
        metric: series.metric,
        firstDay,
        values,
        recordedChanges,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Nightly site-health history (hygiene_checks)
// ---------------------------------------------------------------------------

/** How far back the site-health section looks: the same horizon as the
 * provider trends, and longer than the depth rule's own baseline window
 * (`DEPTH_BASELINE_WINDOW` in workers/ingest/src/hygiene.ts), because this
 * section exists for the slow decline the rule's window is too short to show. */
const HYGIENE_WINDOW_DAYS = 90;

/**
 * Every check the store's vocabulary lists (`noticeos_ref.check_kinds`),
 * sorted. The list is the whole vocabulary, not only the checks this section
 * draws, so the rows read are exactly the rows an unbounded read would return;
 * `apps/tower/test/asset-page-bounded-reads.test.ts` fails if a migration
 * widens the vocabulary without this list.
 */
export const HYGIENE_CHECK_IDS: readonly HygieneCheckId[] = [
  "html-depth",
  "page-structure",
  "robots-ai-access",
  "sitemap",
];

/** The site-health rows since a date, in the order the section splits them;
 * `COLLATE "C"` keeps byte order. */
export const HYGIENE_HISTORY_SQL = `SELECT check_id AS "checkId", observed_at AS "observedAt",
                observed_on AS "observedOn", status,
                value_num AS "valueNum", detail::text AS "detailJson"
           FROM noticeos.hygiene_checks
          WHERE asset_id = $1
            AND check_id IN (${HYGIENE_CHECK_IDS.map((id) => `'${id}'`).join(", ")})
            AND observed_on >= $2::date
          ORDER BY check_id COLLATE "C" ASC, observed_on ASC`;

/** The watched-bot map the robots check stores, and nothing else it stores. */
interface HygieneRobotsDetail {
  bots?: Record<string, unknown>;
}

type HygieneRow = {
  checkId: string;
  observedAt: string;
  observedOn: string;
  status: string;
  valueNum: number | null;
  detailJson: string;
};

const HYGIENE_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "warn",
  "error",
  "unreachable",
]);

/** One stored row as a reading, or null. An unknown status literal means the
 * writer and this reader have diverged, so the row is dropped. */
function hygieneReadingOf(row: HygieneRow): HygieneReading | null {
  if (!HYGIENE_STATUSES.has(row.status)) return null;
  const value = row.valueNum;
  return {
    date: row.observedOn,
    observedAt: row.observedAt,
    status: row.status as HygieneStatus,
    // NULL is "not measured" and travels as null the whole way.
    value: typeof value === "number" && Number.isFinite(value) ? value : null,
  };
}

function hygieneHistoryOf(
  check: HygieneCheckId,
  readings: HygieneReading[],
): HygieneCheckHistory {
  return { check, readings, latest: readings.at(-1) ?? null };
}

/**
 * This asset's nightly served-layer history, or null when the guard has never
 * run for it. One query; three series come back interleaved and are split
 * here. The per-bot map is read from the newest robots row that carries one:
 * a night the origin was unreachable stores no map.
 */
async function readHygieneHistory(
  store: WorkspaceStore,
  asset: string,
  now: Date,
): Promise<HygieneHistory | null> {
  const since = new Date(now.getTime() - HYGIENE_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = (
    await store.read((tx) => tx.query<HygieneRow>(HYGIENE_HISTORY_SQL, [asset, since]))
  ).map((row) => ({ ...row, observedAt: javascriptInstant(row.observedAt) }));
  if (rows.length === 0) return null;

  const byCheck = new Map<string, HygieneReading[]>();
  for (const row of rows) {
    const reading = hygieneReadingOf(row);
    if (!reading) continue;
    const list = byCheck.get(row.checkId) ?? [];
    list.push(reading);
    byCheck.set(row.checkId, list);
  }

  // Newest first, so the first row carrying a map is the freshest answer.
  const bots: HygieneBotAccess[] = [];
  for (const row of rows.filter((r) => r.checkId === "robots-ai-access").reverse()) {
    let detail: HygieneRobotsDetail = {};
    try {
      detail = JSON.parse(row.detailJson) as HygieneRobotsDetail;
    } catch {
      continue;
    }
    const map = detail.bots;
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const resolved = Object.entries(map).flatMap(([bot, allowed]) =>
      typeof allowed === "boolean" ? [{ bot, allowed }] : [],
    );
    if (resolved.length === 0) continue;
    bots.push(...resolved);
    break;
  }

  return {
    htmlDepth: hygieneHistoryOf("html-depth", byCheck.get("html-depth") ?? []),
    robots: hygieneHistoryOf(
      "robots-ai-access",
      byCheck.get("robots-ai-access") ?? [],
    ),
    sitemap: hygieneHistoryOf("sitemap", byCheck.get("sitemap") ?? []),
    bots,
    windowDays: HYGIENE_WINDOW_DAYS,
  };
}

/** The whole asset page: every section. The MCP `property_report` tool reads
 * this, and so does `GET /api/assets/:id` with no `?view=`. */
export async function buildAssetDetailPayload(
  store: WorkspaceStore,
  id: string,
  deps: AssetDetailDeps,
): Promise<AssetDetailPayload | null> {
  return (await assembleAssetDetail(store, id, deps, null)) as AssetDetailPayload | null;
}

/**
 * One tab's view of the asset page: the core every tab shows plus that tab's
 * own sections, read once at one clock. `shared/asset-detail-views` says which
 * tab draws which section; a section a view does not carry is absent, never
 * empty.
 */
export async function buildAssetDetailView<V extends AssetDetailView>(
  store: WorkspaceStore,
  id: string,
  deps: AssetDetailDeps,
  view: V,
): Promise<(AssetDetailFor<V> & { view: V }) | null> {
  return (await assembleAssetDetail(store, id, deps, view)) as (AssetDetailFor<V> & { view: V }) | null;
}

async function assembleAssetDetail(
  store: WorkspaceStore,
  id: string,
  {
    now,
    flagDefaults,
    pullConfig,
    monthlyCaps,
    operatorRateUsdPerMin,
    integrations,
    counters,
    serpPanel,
    signalPanels,
    valueEvents,
    ga4EventParams,
    osTimeZone,
    noNightlyReport,
    schedules,
  }: AssetDetailDeps,
  view: AssetDetailView | null,
): Promise<AssetDetailResponse | null> {
  const wanted = new Set<AssetDetailSection>(view === null ? ALL_ASSET_DETAIL_SECTIONS : ASSET_VIEW_SECTIONS[view]);
  const wants = (section: AssetDetailSection) => wanted.has(section);

  const asset = await readSite(store, id);
  if (!asset) return null;

  // The one clock every flag query below binds: `open` is time-dependent
  // (`worker/flag-scope.ts`), and one instant keeps the hero's count and its
  // rows from disagreeing.
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const panelAssetIds = serpPanelAssets(serpPanel);
  // The Wall's own set, so the card and this page cannot disagree.
  const declaredNoReport = new Set(noNightlyReport ?? []);
  const declared = declaredNoReport.has(id);
  // The last completed Mediavine reporting day, independent of Settings.
  const yesterday = yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, []).date;

  // Every read that needs only the asset row, issued together. A section the
  // view does not draw is not read at all.
  const [
    openRead,
    coverage,
    pulseRows,
    closedRead,
    ledgerRead,
    decisions,
    tasksRead,
    performance,
    executiveRead,
    annotations,
    watchList,
    watchHistory,
    reclamation,
    hygiene,
    fetchFailures,
    flagTs,
    annTs,
    scheduledLanes,
    dailyRevenue,
    counterReadings,
  ] = await Promise.all([
    // One read and evidence selection supplies both rows and condition counts.
    (async () => {
      // A freshness flag the no-report declaration released is not open
      // business here either; the Wall leaves it out on the same rule.
      const rows = (await store.read((tx) => tx.query<FlagDbRow>(
        `SELECT ${FLAG_COLUMNS} FROM noticeos.current_flags
          WHERE asset_id = $1 AND ${openFlagsSql("", "$2::timestamptz")}
          ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                   fired_at DESC, flag_id DESC`,
        [id, nowIso],
      ))).map(flagDbRow)
        .filter((row) => !releasedFreshnessFlag({ ruleId: row.ruleId, asset: id }, declaredNoReport));
      const reviewed = await reviewAlertConditions(store, rows.map((row) => ({ ...row, asset: id })), nowMs);
      return { rows, reviewed };
    })(),
    // Arrival and coverage are different facts: one old pulse proves an
    // arrival, not 28 days of reports. The Wall card's own statement, narrowed
    // to this asset (`./pulse-history`).
    readPulseCoverage(store, nowIso, id).then((map) => map.get(id) ?? null),
    // The newest report always; the 30 behind it only for the tabs that chart
    // per-metric history. Each day's newest revision.
    store
      .read((tx) =>
        tx.query<{ date: string; receivedAt: string; envelope: string }>(
          `SELECT pulse_date::text AS date, received_at AS "receivedAt", envelope::text AS envelope
             FROM noticeos.current_pulses WHERE asset_id = $1 ORDER BY pulse_date DESC LIMIT $2`,
          [id, wants("metrics") ? SERIES_DAYS : 1],
        ),
      )
      .then((rows) => rows.map((row) => ({ ...row, receivedAt: javascriptInstant(row.receivedAt) }))),
    // What is off the Open list, in its two states: settled (the audit trail,
    // newest close first) and parked (grouped by condition, like `/alerts`'
    // Snoozed panel). A snooze is not settled; it comes back on its date.
    (async () => {
      const { settled, parked } = await store.read(async (tx) => ({
        settled: await tx.query<FlagDbRow>(
          `SELECT ${FLAG_COLUMNS}
             FROM noticeos.current_flags
            WHERE asset_id = $1 AND ${settledFlagsSql()}
            ORDER BY ${settledAtSql()} DESC, flag_id DESC
            LIMIT $2`,
          [id, HISTORY_LIMIT],
        ),
        parked: await tx.query<FlagDbRow>(
          `SELECT ${FLAG_COLUMNS}
             FROM noticeos.current_flags
            WHERE asset_id = $1 AND ${snoozedFlagsSql("", "$2::timestamptz")}
            ORDER BY snooze_until ASC, fired_at DESC, flag_id DESC`,
          [id, nowIso],
        ),
      }));
      const parkedRows = parked.map(flagDbRow)
        .filter((row) => !releasedFreshnessFlag({ ruleId: row.ruleId, asset: id }, declaredNoReport));
      const parkedReviewed = await reviewAlertConditions(store, parkedRows.map((row) => ({ ...row, asset: id })), nowMs);
      return { historyRows: settled.map(flagDbRow), snoozedRows: parkedRows, snoozedReviewed: parkedReviewed };
    })(),
    // Read on every view: the data-source section in the header needs the
    // recent revenue rows, and the ledger's age rides with them.
    readLedger(store, id, recentSincePeriod(now), wants("ledger")),
    // Operator decisions, unjoined: a decision's `key` is the query/finding
    // identity the client already renders. A missing row means untouched.
    wants("decisions") ? loadDecisions(store, id) : null,
    // One snapshot feeds every task-hub fact on this page — the operator
    // inbox, the handoff markers and the panel review — so they cannot
    // describe three different presents. The review marker is gated on the
    // landing, exactly as the card is.
    wants("tasks")
      ? Promise.all([loadLatestBeadsSnapshot(store), loadLatestPanelLandings(store, nowMs, panelAssetIds, id)])
      : null,
    // `asset` narrows the same query the Wall runs — one derivation, one
    // ordering, one set of window semantics.
    wants("performance")
      ? loadSignalTrends(store, PROPERTY_SIGNAL_CHART_DAYS, { includeSecondarySeries: true, asset: id, nowMs })
          .then((map) => map.get(id) ?? emptySignalTrendSet())
      : null,
    // Only the analyzer's bounded snapshot crosses into this read model: the
    // site's newest, by the order the store keeps two by
    // (`noticeos.insight_snapshot_is_kept`), as the text it was published as.
    wants("executive")
      ? (async () => {
          const [row] = await store.read((tx) =>
            tx.query<{ payload: string }>(
              `SELECT payload
                 FROM noticeos.asset_insight_snapshots
                WHERE asset_id = $1
                ORDER BY generated_at DESC, created_at DESC, snapshot_id DESC
                LIMIT 1`,
              [id],
            ),
          );
          const executive = parseExecutiveSnapshot(row?.payload ?? null, id);
          return {
            executive,
            recommendationEvidence: executive ? await readRecommendationSources(store, id, nowMs) : null,
          };
        })()
      : null,
    wants("annotations") ? readAnnotationTimeline(store, id) : null,
    readWatchWindows(store, id),
    // The composer's threshold prefill, from this asset's own series. It rides
    // the watch slice because it is only ever read to open a watch.
    wants("watchHistory") ? readWatchSeriesHistory(store, id, nowMs) : null,
    wants("reclamation") ? readReclamationTargets(store, id) : null,
    wants("hygiene") ? readHygieneHistory(store, id, now) : null,
    // The site's recent failed nightly-report fetches; null on a store without
    // the table.
    wants("fetchFailures") ? readSiteFetchFailures(store, id) : undefined,
    store
      .read((tx) =>
        tx.query<{ ts: string | null }>(
          `SELECT max(fired_at) AS ts FROM noticeos.current_flags WHERE asset_id = $1`,
          [id],
        ),
      )
      .then(([row]) => ({ ts: flagInstant(row?.ts) })),
    store
      .read((tx) =>
        tx.query<{ ts: string | null }>(`SELECT max(at) AS ts FROM noticeos.annotations WHERE asset_id = $1`, [id]),
      )
      .then(([row]) => ({ ts: row?.ts == null ? null : javascriptInstant(row.ts) })),
    asset.isOs === 1 ? readLatestJobRuns(store) : null,
    wants("dailyRevenue") ? loadDailyRevenue(store, id, shiftRevenueDate(yesterday, -89), yesterday) : null,
    // The site's all-time totals: read only when the Overview draws them and
    // the register configures any.
    wants("counters") && (counters.assets[id]?.cards?.length ?? 0) > 0
      ? readCounterReadings(store, id).then((map) => map.get(id) ?? new Map<string, CounterReading>())
      : null,
  ]);

  const { rows: openFlagRows, reviewed } = openRead;
  const { historyRows: historyFlagRows, snoozedRows: snoozedFlagRows, snoozedReviewed } = closedRead;
  const agg = countAttentionConditions(reviewed).get(id);

  const info: AssetInfo = {
    id: asset.id,
    displayName: assetDisplayName(asset.isOs, asset.displayName),
    domain: asset.domain,
    status: asset.status as AssetStatus,
    senseOnly: asset.senseOnly === 1,
    isOs: asset.isOs === 1,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    firstReportAt: coverage?.first ?? null,
    reportDays: coverage?.reportDays ?? 0,
    noNightlyReport: declared,
    worstOpenSeverity: severityFromRank(num(agg?.worst) ?? 0),
    openError: num(agg?.err) ?? 0,
    openWarn: num(agg?.warn) ?? 0,
  };

  // --- pulse history (latest metrics + per-metric 30-day series) -------------
  const latest = pulseRows[0] ?? null;
  const ascPulses = [...pulseRows].reverse();
  const latestMetrics = latest ? parseMetrics(latest.envelope) : {};
  const metrics: PulseMetric[] = [];
  if (latest) {
    for (const name of Object.keys(latestMetrics)) {
      const entry = latestMetrics[name] ?? {};
      const series: SeriesPoint[] = [];
      for (const p of ascPulses) {
        const v = num(parseMetrics(p.envelope)[name]?.last24h);
        if (v !== null) series.push({ t: p.date, v });
      }
      metrics.push({
        name,
        last24h: num(entry.last24h),
        avg7d: num(entry.avg7d),
        total: num(entry.total),
        series,
      });
    }
  }
  const lastPulse = latest ? { date: latest.date, receivedAt: latest.receivedAt } : null;

  // --- all-time totals -------------------------------------------------------
  // Each configured card from the freshest lane that carries it, the counters
  // lane or the latest report's own total.
  const siteCounters: SiteCounters | null = counterReadings
    ? {
        heading: counters.assets[id]?.heading?.trim() || "All-time totals",
        cadenceHours: countersCadenceHours(schedules ?? null),
        cards: resolveCounterCards(counters.assets[id]?.cards, counterReadings, {
          metrics: latestMetrics as Record<string, { total?: unknown } | undefined>,
          receivedAt: latest?.receivedAt ?? null,
        }),
      }
    : null;

  // --- wiring-health flags (asset-pull-failed, ingest-freshness) -------------
  const wiringFlagRows = reviewed
    .filter((condition) => isAttentionEligible(condition.liveness))
    .flatMap((condition) => condition.firings)
    .filter((row) => ["asset-pull-failed", "ingest-freshness"].includes(row.ruleId));
  const pullFailure = wiringFlagRows.find((f) => f.ruleId === "asset-pull-failed") ?? null;
  const ingestFreshness = wiringFlagRows.find((f) => f.ruleId === "ingest-freshness") ?? null;

  const wiring = {
    ...buildWiring(asset, pullConfig, lastPulse, pullFailure, ingestFreshness, schedules ?? null),
    noReportDeclarations: noNightlyReport == null ? null : [...noNightlyReport],
  };
  const rules = buildRules(flagDefaults);
  const portfolio = buildPortfolio(monthlyCaps, operatorRateUsdPerMin);

  const [alertChanges, notifiedAt, integrationEvidence, readings] = await Promise.all([
    // Changes that might explain those alerts, read against the flags' own
    // date range rather than off the recency-capped timeline.
    readAlertChanges(store, id, [...openFlagRows, ...snoozedFlagRows, ...historyFlagRows].map((f) => f.firedAt)),
    // Which of these the operator has already heard about on their
    // notification channel. A separate read rather than a join, so an install
    // without the table keeps its page.
    loadNotifiedAt(store, [...openFlagRows, ...snoozedFlagRows, ...historyFlagRows].map((f) => f.id)),
    // Integrations section: reuses the recent current revenue rows read above
    // as the manual-lane evidence.
    loadIntegrationEvidence(store, {
      now, integrations, serpPanel, assetId: id, presentation: 'full',
      reuse: {
        revenueRows: new Map([[id, ledgerRead.recentRevenue]]),
      },
    }),
    // Each alert's stored readings, for its Evidence. Empty on a store without
    // the table.
    readFlagReadings(store, [...openFlagRows, ...snoozedFlagRows, ...historyFlagRows].map((f) => f.id)),
  ]);
  const readingsFor = (flagId: number) => readingsOf(readings, flagId);
  const integrationsSection = integrationEvidence.asset(id, {
    latestReportAt: lastPulse?.receivedAt ?? null,
    pull: pullConfig.find((entry) => entry.asset === id) ?? null,
    isOs: asset.isOs === 1,
    declaredNoReport: declared,
  });

  // --- one row per condition, the Wall's grouping verbatim --------------------
  // `groupConditionFirings` is the Wall's own derivation and the same
  // (asset, rule_id, metric) scope `applyFlagAction` re-derives in SQL. Both
  // payloads group all open severities before choosing their displayed set, so
  // occurrences match the action scope. A condition's newest representative
  // supplies its evidence; its complete firing set supplies counts.
  const liveOpen: FlagRecord[] = [];
  const notCurrent: FlagRecord[] = [];
  for (const condition of reviewed) {
    const record = {
      ...toFlagRecord(condition.latest, alertChanges, condition),
      notifiedAt: notifiedAt.get(condition.latest.id) ?? null,
      ...readingsFor(condition.latest.id),
    };
    const placed = { ...record, liveness: condition.liveness, verification: condition.verification };
    (isAttentionEligible(condition.liveness) ? liveOpen : notCurrent).push(placed);
  }

  const flags: FlagsSection = {
    open: liveOpen,
    // Not current, but kept: they only leave the heading that claims they are live.
    notCurrent,
    // Parked, one row per condition, soonest back first, as in `wall-payload.ts`.
    snoozed: snoozedReviewed
      .map((condition) => ({
        ...toFlagRecord(condition.latest, alertChanges, condition),
        notifiedAt: notifiedAt.get(condition.latest.id) ?? null,
        ...readingsFor(condition.latest.id),
        liveness: condition.liveness,
        verification: condition.verification,
      }))
      .sort((left, right) => (left.snoozeUntil ?? "").localeCompare(right.snoozeUntil ?? "")
        || right.firedAt.localeCompare(left.firedAt)),
    // History is not grouped: rows dispositioned on different days are not one event.
    history: historyFlagRows.map((r) => ({
      ...toFlagRecord(r, alertChanges, { occurrences: 1, firstFiredAt: r.firedAt }),
      notifiedAt: notifiedAt.get(r.id) ?? null,
      ...readingsFor(r.id),
      liveness: { state: "historical" as const },
      verification: deriveAlertEvidence({ ...r, asset: id, ruleInputs: parseRuleInputs(r.ruleInputs) }, nowMs).verification,
    })),
    // The same eligible condition counts the Wall card states.
    openError: info.openError,
    openWarn: info.openWarn,
  };

  // --- serp-panel review obligation -------------------------------------------
  // The card's two fields, from the card's own two readers (`./panel-review`),
  // so a page and the card that linked to it cannot state different
  // obligations. Gated on the landing, exactly as the card is; every
  // collecting asset owes the read, panel or no panel. config/serp-panel.json
  // only picks the noun the marker uses.
  const [beadsSnapshot, panelLandings] = tasksRead ?? [null, null];
  const latestPanelDate = panelLandings?.get(id) ?? null;

  // A section the view does not draw leaves its fields out entirely;
  // `viewCovers` is how the page tells that from "empty".
  const payload: AssetDetailResponse = {
    ...(view === null ? {} : { view }),
    generatedAt: nowIso,
    asset: info,
    scheduledLanes,
    wiring,
    // The site's own entry in each register its Settings tab edits.
    // `undefined` (not in the file) becomes `null`.
    countersConfig: (counters.assets[id] as JsonValue | undefined) ?? null,
    panelConfig: {
      trackedQueries: trackedQueriesOf(serpPanel.assets[id]),
      roster: (signalPanels.assets[id] as JsonValue | undefined) ?? null,
    },
    rules,
    portfolio,
    ...(performance ? { performance } : {}),
    ...(executiveRead ? executiveRead : {}),
    ...(wants("metrics") ? { metrics } : {}),
    ...(wants("counters") ? { counters: siteCounters } : {}),
    flags,
    ...(ledgerRead.slice ? { ledger: ledgerRead.slice } : {}),
    ...(dailyRevenue ? { dailyRevenue } : {}),
    osTimeZone,
    ...(decisions ? { decisions } : {}),
    ...(tasksRead
      ? {
          handoffBeads: handoffBeadsOf(beadsSnapshot, id),
          // The task source's inbox for this site (`./task-source`).
          operator: beadsInbox(beadsSnapshot, id),
        }
      : {}),
    ...(annotations ? { annotations } : {}),
    watches: watchHistory ? { ...watchList, history: watchHistory } : { open: watchList.open, closed: watchList.closed },
    ...(wants("reclamation") ? { reclamation } : {}),
    ...(wants("hygiene") ? { hygiene } : {}),
    ...(wants("fetchFailures") ? { fetchFailures } : {}),
    integrations: integrationsSection,
    ga4Config: {
      valueEvents: stringListEntry(valueEvents.assets[id]?.valueEvents),
      eventParams: stringListEntry(ga4EventParams.assets[id]?.eventParams),
      productUseStages: readProductUseStages(valueEvents.assets[id]?.productUseStages)?.map((stage) => ({ ...stage })) ?? null,
      valueEventsEntryExists: valueEvents.assets[id] !== undefined,
    },
    ...(tasksRead
      ? {
          panelReview: latestPanelDate
            ? (cardPanelReviewsOf(beadsSnapshot, panelAssetIds, id).get(id) ?? null)
            : null,
          latestPanelDate,
        }
      : {}),
    freshness: {
      pulseReceivedAt: lastPulse?.receivedAt ?? null,
      // Over current rows only: a superseded estimate cannot set how old the lane is.
      ledgerRecordedAt: ledgerRead.latestRecordedAt,
      flagFiredAt: flagTs?.ts ?? null,
      annotationAt: annTs?.ts ?? null,
    },
  };
  return payload;
}

/**
 * What the task hub holds for this asset's findings and queries, or null when
 * it could not be asked. The Tower cannot reach the hub, so this reads the
 * same `beads_snapshots` row the /work board and the asset card read. Four
 * things return null and they are one answer on purpose: no snapshot has ever
 * been filed, this asset is not a project in `config/beads.json`, `bd` failed
 * for its repo, or the snapshot predates the field. None is a measurement, and
 * "nothing was filed" is only earned by an empty list.
 */
function handoffBeadsOf(snapshot: BeadsSnapshot | null, asset: string): HandoffBead[] | null {
  const project = snapshot?.projects.find((entry) => entry.asset === asset);
  if (!project || !project.ok) return null;
  return project.handoffs ?? null;
}

/** One (period, booking state, kind, family) total over the current rows, in
 * integer cents, with the newest `recorded_at` among the rows it sums. */
interface LedgerTotalRow {
  currency: string;
  period: string;
  bookingState: string;
  kind: string;
  family: string;
  amountMinor: number;
  recordedAt: string;
}

interface LedgerRead {
  /** The period totals and the newest rows, when the view draws the ledger. */
  slice: LedgerSlice | null;
  /** Recent CURRENT revenue rows, newest first: the manual-lane evidence the
   * data-source section in the page header reads. */
  recentRevenue: { currency: string; family: string; source: string | null; note: string | null; amountMinor: number; period: string }[];
  /** How old the ledger lane is: the newest `recorded_at` among current rows. */
  latestRecordedAt: string | null;
}

/** Newest first, the order the rows have always been listed in. `id` breaks
 * a tie on the two dates, so the newer of two same-instant rows leads. */
function newestLedgerRowFirst(a: LedgerDbRow, b: LedgerDbRow): number {
  return b.period.localeCompare(a.period) || b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id;
}

/**
 * This asset's ledger in one statement over one evaluation of the current-row
 * view `noticeos.financial_ledger`. The totals are computed in SQL, one row
 * per (period, booking state, kind, family), plus only the 20 newest rows the
 * page lists; the totals cover every current row, never only the 20. The CTE
 * is MATERIALIZED so every part of the answer comes from one evaluation.
 */
async function readLedger(
  store: WorkspaceStore,
  asset: string,
  recentSince: string,
  withSlice: boolean,
): Promise<LedgerRead> {
  const stored = await store.read((tx) =>
    tx.query<{
      part: "latest" | "revenue" | "total" | "recent";
      currency: string;
      id: bigint | null;
      kind: string;
      period: string;
      family: string;
      amountMinor: bigint;
      bookingState: string;
      source: string | null;
      ref: string | null;
      note: string | null;
      recordedAt: string | null;
    }>(
      `WITH current_rows AS MATERIALIZED (
         SELECT entry_number AS id, kind, to_char(period_month, 'YYYY-MM') AS period, family, currency, amount_minor,
                booking_state, source, ref, note, recorded_at
           FROM noticeos.financial_ledger
          WHERE asset_id = $1
       )
       SELECT 'latest' AS part, NULL::bigint AS id, NULL::text AS kind, NULL::text AS period, NULL::text AS family, NULL::text AS currency,
              count(*)::bigint AS "amountMinor", NULL::text AS "bookingState", NULL::text AS source, NULL::text AS ref,
              NULL::text AS note, MAX(recorded_at) AS "recordedAt"
         FROM current_rows
       UNION ALL
       SELECT 'revenue', id, kind, period, family, currency, amount_minor, booking_state,
              source, ref, note, recorded_at
         FROM current_rows
        WHERE kind = 'revenue' AND period >= $2
       ${withSlice ? `UNION ALL
       SELECT 'total', NULL, kind, period, family, currency, SUM(amount_minor)::bigint, booking_state,
              NULL, NULL, NULL, MAX(recorded_at)
         FROM current_rows
        GROUP BY period, booking_state, kind, family, currency
       UNION ALL
       SELECT * FROM (
         SELECT 'recent', id, kind, period, family, currency, amount_minor, booking_state,
                source, ref, note, recorded_at
           FROM current_rows
          ORDER BY period DESC, recorded_at DESC, id DESC
          LIMIT $3
       ) recent` : ""}`,
      withSlice ? [asset, recentSince, HISTORY_LIMIT] : [asset, recentSince],
    ),
  );
  /** The listed entries of one part, each by its number, cents exact. */
  const listed = (part: "revenue" | "recent"): LedgerDbRow[] =>
    stored
      .filter((row) => row.part === part)
      .map((row) => ({
        id: Number(row.id),
        kind: row.kind,
        period: row.period,
        family: row.family,
        currency: row.currency,
        amountMinor: cents(row.amountMinor),
        bookingState: row.bookingState,
        source: row.source,
        ref: row.ref,
        note: row.note,
        recordedAt: javascriptInstant(row.recordedAt!),
      }));
  const totals: LedgerTotalRow[] = stored
    .filter((row) => row.part === "total")
    .map((row) => ({
      period: row.period,
      bookingState: row.bookingState,
      kind: row.kind,
      family: row.family,
      currency: row.currency,
      amountMinor: cents(row.amountMinor),
      recordedAt: javascriptInstant(row.recordedAt!),
    }));
  const latest = stored.find((row) => row.part === "latest");

  const recentRevenue = listed("revenue")
    .sort(newestLedgerRowFirst)
    .map((row) => ({
      currency: row.currency,
      family: row.family,
      source: row.source,
      note: row.note,
      amountMinor: row.amountMinor,
      period: row.period,
    }));
  return {
    slice: withSlice
      ? ledgerSliceOf(totals, listed("recent").sort(newestLedgerRowFirst), latest ? cents(latest.amountMinor) : 0)
      : null,
    recentRevenue,
    latestRecordedAt: latest?.recordedAt ? javascriptInstant(latest.recordedAt) : null,
  };
}

/** The SQL totals retain currency before any amount leaves integer units. */

function ledgerSliceOf(totals: LedgerTotalRow[], recent: LedgerDbRow[], rowCount: number): LedgerSlice {
  const rollup = (rows: LedgerTotalRow[]): LedgerRollup => {
    const groups: MinorMoneyFigure[] = rows.map(row => ({ currency: row.currency,
      revenueMinor: row.kind === 'revenue' ? row.amountMinor : 0,
      costMinor: row.kind === 'cost' ? row.amountMinor : 0 }));
    const families = (kind: string): LedgerFamilyAmount[] => rows.filter(row => row.kind === kind)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.family.localeCompare(b.family))
      .map(row => ({ family: row.family, currency: row.currency,
        amount: minorToMajorUnits(row.amountMinor, row.currency) }))
      .sort((a, b) => a.currency.localeCompare(b.currency) || b.amount - a.amount);
    return { figure: moneyFigure(groups), revenueByFamily: families('revenue'), costByFamily: families('cost') };
  };
  const periods: LedgerPeriod[] = [...new Set(totals.map(row => row.period))]
    .sort((a, b) => b.localeCompare(a)).map(period => {
      const rows = totals.filter(row => row.period === period);
      return { period,
        booked: rollup(rows.filter(row => row.bookingState === 'reconciled')),
        forecast: rollup(rows.filter(row => row.bookingState === 'estimated')) };
    });
  const recentRows: LedgerRawRow[] = recent.map(row => ({ id: row.id,
    kind: row.kind as 'revenue' | 'cost', period: row.period, family: row.family,
    currency: row.currency, amount: minorToMajorUnits(row.amountMinor, row.currency),
    bookingState: row.bookingState as BookingState, source: row.source,
    ref: row.ref, note: row.note, recordedAt: row.recordedAt }));
  const currencies = new Set(totals.map(row => row.currency));
  return { periods, recentRows, empty: rowCount === 0,
    currency: currencies.size === 0 ? 'USD' : currencies.size === 1 ? [...currencies][0]! : null };
}
import { readProductUseStages } from '@noticeos/contract/product-use';
