import { moneyFigure, minorToMajorUnits, type MinorMoneyFigure } from '@noticeos/contract/money';
import { assetDisplayName } from "@noticeos/contract/asset-name";
import { savedSearchMarket } from "@noticeos/contract/dataforseo";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { readSite, type SiteRecord } from "./asset-registry";
import { loadDailyRevenue } from "./daily-revenue";
import { SCHEDULED_JOBS, scheduleFor, type ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import { MEDIAVINE_REPORTING_CLOCK, yesterdayRevenue } from "../shared/daily-revenue";
import { shiftRevenueDate } from "../shared/revenue-projection";
// AssetDetail payload assembly — the one read behind GET /api/assets/:id. Pure
// over the call's Postgres store (isolated real copies in tests), so the exact
// SQL below runs against the migrated Postgres schema under Vitest. Every fact is paired
// with the file (or store table) that owns it — doc 14 principle 10.
//
// Config the builder needs is passed in (not read from disk): the flag defaults
// and the pull-mode registry, injected at build time in vite.config.ts and
// supplied by the tests directly.

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
  /** config/counters.json, verbatim. Read here for ONE thing the rest of this
   * builder does not need: whether the asset has an entry in that register, and
   * exactly what it is, so a Delete can name and remove it (bead `ro-z349.2`).
   * The totals themselves render on the asset card, off the wall payload. */
  counters: CountersConfig;
  /** config/serp-panel.json — which assets have a tracked SERP panel at
   * all, and therefore owe a weekly review. The same key set the Wall reads,
   * for the same reason: an asset absent from this file says nothing rather
   * than nothing-yet. Each entry travels VERBATIM since bead `ro-sk7q`, because
   * a Delete has to carry it as the `expect` that guards its removal. */
  serpPanel: SerpPanelConfig;
  /** config/signal-panels.json — the roster of assets whose local signal panel
   * is kept current. Read here for the one thing the rest of this builder does
   * not need: whether the asset has an entry, and exactly what it is, so a
   * Delete can name and remove it (bead `ro-sk7q`). */
  signalPanels: SignalPanelsConfig;
  /** config/value-events.json — which GA4 events this asset calls value events.
   * Read here so its Sources tab can EDIT them (bead `ro-x5gu.3`): the browser
   * cannot open a file, and `CollectionEditor` takes its rows from the payload
   * the page already fetches rather than opening a second read of one. */
  valueEvents: ValueEventsConfig;
  /** config/ga4-custom-dimensions.json — the event parameters the operator has
   * registered as custom dimensions on this asset's GA4 property. Same reason,
   * same tab, the other list. */
  ga4EventParams: Ga4EventParamsConfig;
  /** The operator's clock: config/constants.json `os_time_zone` as SAVED,
   * resolved store first (bead `ro-ujb9.88`). It decides where the daily
   * revenue window ends, and rides on the payload so the page's own date math
   * uses the same clock. */
  osTimeZone: string;
  /** config/constants.json `no_nightly_report` as SAVED (bead `ro-ujb9.96.8`):
   * whether THIS asset owes a nightly report, and the whole list the Settings
   * switch writes back as its guard. Absent or null declares none. */
  noNightlyReport?: readonly string[] | null;
  /** config/constants.json `schedules` as SAVED (bead `ro-ujb9.96.7.12`): the
   * nightly report's time is read from the same saved schedule the runner arms,
   * never typed here. Absent or null is every job on its default. */
  schedules?: ScheduleOverrides | null;
}

const HISTORY_LIMIT = 20;
const SERIES_DAYS = 30;

/**
 * How many timeline rows one read carries. Generous on purpose: the timeline is
 * an asset's whole change history and a year of weekly deploys fits well under
 * it, so in practice nothing is left out at all.
 *
 * It is a RENDERING bound, not a truth bound. Whatever it does leave out is
 * counted and named on the surface (`AnnotationTimeline.olderCount`); the old
 * 20-row cap dropped the rest in silence, which is how one asset's first
 * July change-point vanished from a page whose Watches strip still pointed at it
 * (ro-5e8.1).
 */
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

/** A suppressed card is three strings and nothing else — no evidence, no window.
 * A row carrying less than its identity is dropped rather than rendered as a
 * finding with a blank name. */
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

/** Absent, or an array of proof rows. Absent is every snapshot written before
 * the movers lanes stated their own exclusions, and it must parse: a producer
 * that has not caught up ran no check, which is exactly what `[]` means here.
 * A malformed `evidence` value is NOT absence and fails the whole trend, because
 * a lane whose proof cannot be read must not render as a lane that has none. */
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

/** Validates, then NORMALIZES the same way the DataForSEO block does: an absent
 * `evidence` key becomes an explicit `[]` so every consumer reads one value for
 * "this lane stated nothing" instead of having to know which vintage of producer
 * wrote the snapshot. */
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

/** Absent, null, or a boolean. Absent is what every snapshot written before the
 * tracked panel landed looks like, and it must parse — a producer that has not
 * caught up yet is missing evidence, not corrupt evidence. */
function isOptionalBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

/** Three producer vintages, all valid: no panel fields at all (before the panel
 * landed), the flat `aioPresent`/`aioCitesUs` pair (before `ro-14d.1` split the
 * devices), and today's `aioDevices` list. Anything else is a corrupt row. */
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
 * Validates, then NORMALIZES to today's per-device shape, so every consumer
 * reads one list rather than having to know which vintage of producer wrote the
 * row.
 *
 * A pre-`ro-14d.1` row's flat pair becomes ONE DESKTOP READING — desktop
 * because the collector had exactly one device literal in it until 2026-08-04,
 * so a row from then could not have been anything else (the same call
 * `serpPageDevice()` makes in scripts/signal-archive.mjs). A row carrying
 * neither the pair nor a list was written before the panel existed and becomes
 * an EMPTY list, which is unknown — never a desktop reading of nulls, because
 * that would claim a surface was checked.
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

/** The device a row was read on when the producer did not say. Desktop was
 * structurally true before 2026-08-04, not merely likely. */
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

/** Providers degrade INDEPENDENTLY: an absent or malformed google/bing/dataforseo
 * block becomes null and the surviving providers still render. The whole section
 * is null only when the value is not an object, or when no provider survives —
 * one bad producer must not erase evidence the other two collected. */
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

/** The exact keys scripts/signal-insights.mjs writes for each family. Validating
 * NAMES (not a value count) is what makes producer key drift visible here — a
 * renamed field drops the section instead of passing as "still 7 numbers". */
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

/** The listed keys as finite numbers and NOTHING ELSE, or null when any of them
 * is missing or unreadable.
 *
 * It returns the reviewed subset rather than a yes/no (bead `ro-a8y`): the old
 * shape checked the names and then handed the producer's own object on to the
 * browser, so validating names proved nothing about what was forwarded — a key
 * nobody listed rode through unreviewed. Picking is the only construction that
 * makes the key list the whole contract in both directions. */
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

/** The same contract as {@link pickFiniteNumbers}, for figures the producer may
 * state as unknown (bead `ro-8s5`): each listed key must be PRESENT and be a
 * finite number or an explicit null. Null is a reading ("the provider stated no
 * figure"); a missing key is still producer drift and drops the section. */
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
  // The four families added 2026-08-31 (ro-kukv.2) are OPTIONAL by construction:
  // a snapshot written before they existed, or for an asset that has not
  // collected them yet, carries none of them. Absent normalizes to empty rather
  // than dropping the whole section — the older families in the same snapshot
  // are still true, and losing them to a key that did not exist last week would
  // be the retroactive-incompleteness failure db/0026's siblings exist to avoid.
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

/** One panel row, or null when it cannot be trusted to be one.
 *
 * `query` is the only load-bearing string — without it the row names nothing.
 * The rest degrade to unknown rather than dropping the row: a rank that arrived
 * as something other than a finite number is a rank nobody measured, which is
 * the same fact `bestRank: null` already carries. `aioPresent`/`aioCitesUs` are
 * three-valued at the source and absent on the oldest blocks, so anything that
 * is not a literal boolean normalizes to null — never to `false`.
 *
 * `device` is the one field that degrades to a VALUE rather than to unknown
 * (bead `ro-14d.1`): a block written before the split names no device, and that
 * absence is a desktop-era row, not a mystery surface. The collector had
 * exactly one device literal in it until 2026-08-04, so no stored snapshot can
 * be anything else, and reading it as unknown would break every device
 * comparison across the cutover. */
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
    // The cluster label degrades the OPPOSITE way from the device (bead
    // ro-282.5): missing or blank becomes null, because a label was never sent
    // for an unlabelled panel and inventing one would invent a bet nobody
    // placed. Kept verbatim otherwise — it is the operator's own wording and
    // the grouping key, so case and spacing are theirs, not this file's.
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
    // Missing on every pre-ro-e46.3 snapshot and null on a provider-unread
    // page. Both render no neighborhood rather than a confident empty one.
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
 * The tracked-query panel block, or null (bead `ro-282.3`).
 *
 * ABSENT IS THE ANSWER FOR MOST ASSETS and it must stay cheap: an asset
 * with no `config/serp-panel.json` entry has no panel family in the archive, so
 * `scripts/signal-insights.mjs` publishes no block and this returns null — the
 * page then renders nothing at all rather than an empty scoreboard. Every
 * snapshot written before the block existed reaches the identical answer
 * through the identical branch, which is why "no panel" and "producer has not
 * caught up" are deliberately not told apart here: the operator's page looks
 * the same either way, and inventing a third state would put a "coming soon" on
 * five asset pages that are never getting one.
 *
 * A malformed block is absent too, never a thrown page. This is JSON out of a
 * snapshot row written by a separate process on the operator's Mac; the one
 * thing it must not be able to do is take the asset page down with it.
 *
 * `trackedDepth` rides through as `number | null` untouched (the producer reads
 * `tracked_depth` off the archive and leaves a legacy row's null alone) —
 * defaulting it to 20 here would be this file inventing a depth the pull never
 * recorded.
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
    // The market the site saved (bead ro-ujb9.230), read by the contract's own
    // rule for a saved market. Absent on an older snapshot, or unreadable: null,
    // and the caption names no market rather than a guessed one.
    market: savedSearchMarket(block.market),
    queries,
  };
}

/**
 * The page-grain decision evidence, or null (bead `ro-427`).
 *
 * Same degradation contract as `parseSerpPanel` above, for the same reasons.
 * ABSENT IS ORDINARY: every snapshot written before this block existed, and
 * every asset whose archive does not yet hold two complete seven-date weeks,
 * reaches null through this branch — the page table then renders nothing rather
 * than an empty comparison. A malformed block is absent too, never a thrown
 * page: this is JSON out of a snapshot row written by a separate process, and
 * the one thing it must not be able to do is take the asset page down.
 *
 * ROWS DEGRADE ONE AT A TIME, the way `items` does and unlike `serpPanel`'s
 * all-or-nothing queries: each page here is an independent decision row, so a
 * garbled one costs exactly itself. A block whose rows ALL fail is null — a
 * comparison nothing survived is not a comparison that found no movement.
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

/** Null for an absent, malformed, or unnamed leading query — the page keeps its
 * own numbers and says nothing about what it ranks for, which is the honest
 * answer for a page the page/query export does not cover. */
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
    // An unreadable list is an EMPTY list, which the whole panel contract reads
    // as "not tracked" — never as a reading, and never as "no overview".
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
    // A lane that states nothing and a lane whose statement was lost look the
    // same here, and both are `[]`: what must never happen is a fabricated row
    // claiming a check that did not run.
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

/** A nullable date field the producer may simply not have written. `undefined`
 * is the JSON shape of "absent" — `JSON.stringify` drops an undefined key — so
 * a snapshot missing its window arrives here without the key at all. */
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
      // An ABSENT window nulls ONE field; it never discards the analysis (bead
      // `ro-a8y`). The window is optional by type and a hard gate on it was a
      // whole snapshot — every card, every number — lost to one missing date.
      !isAbsentOrString(snapshot.windowStart) ||
      !isAbsentOrString(snapshot.windowEnd) ||
      typeof snapshot.sourceArchiveCount !== "number" ||
      !Number.isInteger(snapshot.sourceArchiveCount) ||
      !Array.isArray(snapshot.items) ||
      !Array.isArray(snapshot.methodology)
    ) {
      return null;
    }
    // Every field is named and copied ACROSS, never spread (bead `ro-a8y`): a
    // key this parser has not reviewed does not reach the browser, so a field a
    // future producer adds is invisible here until someone adds it on purpose.
    return {
      schemaVersion: 1,
      asset,
      generatedAt: snapshot.generatedAt,
      windowStart: snapshot.windowStart ?? null,
      windowEnd: snapshot.windowEnd ?? null,
      sourceArchiveCount: snapshot.sourceArchiveCount,
      // The top-level shape is a hard gate (a snapshot for another asset, or of
      // another schema version, is not this asset's evidence). Individual
      // rows are not: one malformed insight is dropped, never a whole analysis.
      items: snapshot.items.filter(isExecutiveInsight),
      // NOT a hard gate either, and absent on every snapshot written before the
      // producer emitted the list (2026-07-31): the cut's own record is the one
      // thing whose absence must not cost the operator the eight cards that
      // survived it.
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
  /** Integer cents (`amount_minor`, db/0018) — the exact column, and since
   * db/0020 the only one the ledger has. Every figure this page states is added
   * here and divided by 100 once, at the edge. */
  amountMinor: number;
  bookingState: string;
  source: string | null;
  ref: string | null;
  note: string | null;
  recordedAt: string;
}

/**
 * One per-asset string list out of a config register, keeping ABSENCE and
 * EMPTINESS apart (bead `ro-x5gu.3`).
 *
 * `null` is "this asset has no entry" — nothing declared, and the surface's
 * first Add has to file the asset's entry rather than append to a list that is
 * not there. `[]` is an entry that exists and declares nothing, which appends
 * normally. Both READ the same downstream (the value-event check stays silent,
 * the js-errors archive skips the asset), and collapsing them here would make
 * the Tower write the wrong op.
 *
 * A value that is not an array of strings reads as `null` rather than being
 * repaired: these files are hand-maintained claims, and a surface that quietly
 * normalizes one would hide the drift `scripts/config-registers.test.mjs` exists
 * to catch.
 */
function stringListEntry(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/**
 * The tracked terms inside an asset's `config/serp-panel.json` entry — `null`
 * when the asset has no entry at all (bead `ro-x5gu.4`).
 *
 * Same three-state rule as `stringListEntry` above and the same consequence for
 * the write, with one difference this file cannot flatten: a term is a bare
 * string OR `{query, label}`, in any mix, so the rows travel as they are stored
 * rather than as one shape. An entry whose `queries` is not an array at all
 * reads as `[]` — the entry EXISTS, which is the fact the write depends on, and
 * the panel it declares is the config error `serp-panel.README.md` is about.
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

  // Which job makes the nightly report — the OS's pull, or its own report —
  // and its schedule as SAVED, read the way the runner reads it
  // (`scheduleFor`). A pushing asset sends on its own clock.
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

/**
 * This asset's annotations in the correlation window before any of `firedAts`
 * — the raw material for each alert's "was anything changed just before this?"
 * chip. One bounded read for the whole page; empty (and free) when the asset
 * has no alerts at all.
 */
async function readAlertChanges(
  store: WorkspaceStore,
  asset: string,
  firedAts: string[],
): Promise<AnnotationItem[]> {
  const times = firedAts.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return [];
  const from = new Date(Math.min(...times) - CORRELATION_WINDOW_HOURS * 3_600_000).toISOString();
  const to = new Date(Math.max(...times)).toISOString();
  // On Postgres (bead ro-ujb9.76.5.7): a change is known by its workspace's
  // number; two at one instant newest-filed first, as D1's index gave them.
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
 * `readAnnotationTimeline`.
 *
 * On Postgres (bead ro-ujb9.76.5.7) a window anchors a change when its ref is
 * exactly the change's number written out: canonical digits, no sign, space,
 * leading zero or decimal, D1's `CAST(anchor.id AS TEXT) = w.ref`. Those refs
 * are picked out first (`anchors`, materialized so no other ref is ever cast),
 * and each is then a seek on the workspace's numbers, its own subquery
 * (`OFFSET 0`): joined in, Postgres would rather walk the site's changes and
 * filter them by number, the walk this read exists to avoid.
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
 * end.
 *
 * Two things bound the read, and the WIDER of them wins:
 *
 *  - `TIMELINE_LIMIT`, so one asset with years of deploys cannot make the
 *    page unbounded; and
 *  - every annotation a watch window on this asset points at. A registered
 *    window names a cause; a timeline that cannot show that cause leaves the
 *    operator a readable window with an unreadable reason, which is the exact
 *    failure docs/03 exists to prevent. So an anchored change pulls the floor
 *    down to itself however old it is, and every row back to it comes with it —
 *    the list stays contiguous, so one "N older" line still accounts for
 *    everything missing.
 *
 * `olderCount` is what the read did NOT carry. It is rendered, not swallowed.
 *
 * WHAT IT COSTS (bead `ro-ujb9.103`). The depth is decided inside the one
 * read: the newest rows back to the oldest anchored change are exactly the
 * rows dated at or after it, so the anchored count is a seek over rows the
 * read returns anyway. The anchor itself is found from this asset's watch
 * windows, not by walking every annotation. The asset's total is counted
 * only when the timeline is full, since a shorter one holds every row;
 * that count is the one part that still grows with the asset's history,
 * because "N older" is an exact number (`TIMELINE_TOTAL_SQL`). The anchor
 * join seeks each window's annotation by number and keeps it only when its
 * number reads back as exactly the stored `ref`, the old join's own test.
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

/** The funnel in order (db/0015). `skip` and `dead` are terminal exits from it,
 * counted but never rendered as stages. */
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

/** How many targets the strip lists. Enough to see what the current wave is
 * doing; the campaign itself is worked in the CSV/import lane, not here. */
const RECLAMATION_TARGET_LIMIT = 10;

/**
 * This asset's link-outreach pipeline, on Postgres (bead ro-ujb9.76.5.8).
 * READ-ONLY: status changes arrive through `scripts/reclamation-import.mjs`,
 * and a win is a human confirmation on the page — nothing in the Tower writes
 * here.
 *
 * Returns null when the asset has no rows at all, so the section renders
 * nothing rather than an empty state the operator could not act on.
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
    // `skip` rows are a do-not-pitch reference list rather than work in
    // progress, so they stay out of the list while still counting toward the
    // total. A target never touched has no `status_at`; it sorts last rather
    // than pretending to be the oldest movement. Ties as D1 broke them: the
    // domain byte by byte, then the order the targets were stored. A target is
    // known by its workspace number.
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
    // A stage with no rows is omitted: an unstarted stage is not a measurement,
    // and a row of zeroes reads as a result.
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
 * actually reports (bead `ro-5e8.2`).
 *
 * READ THE WAY THE EVALUATOR READS. `signal_observations` is append-only and a
 * provider revision appends a NEW row for the same (date, metric), so the query
 * mirrors `aggregateMetric`'s ordering exactly — date ascending, then run
 * finish, then row id — and the last write for a date wins. It does not filter
 * observation rows on run status either, because the evaluator does not: a
 * calibration measured over a series the evaluator would not have read is a
 * calibration of a different number.
 *
 * ONE PROVIDER RESOURCE PER SERIES (`ro-ujb9.70`). Each integration reads only
 * its CURRENT property: the `property_ref` of its latest successful run, the
 * same rule the charts and the ingest panel trend use. The evaluator refuses a
 * verdict whose baseline and post windows come from different properties
 * (`unmeasurable`), so a stretch that spans a switch is never a comparison it
 * makes. Here the old property's days read as gaps, which the calibration's
 * own coverage rule already skips, and the noise floor a new registration is
 * offered is the noise of the resource it will actually be judged on.
 * Rotating the credential keeps `property_ref`, so it keeps the whole history.
 *
 * A series with no rows in the window is ABSENT from the result rather than
 * present-and-empty, because "this asset does not report Bing clicks" and
 * "it reports them and they are all zero" must not arrive as the same fact.
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
    // On Postgres (bead ro-ujb9.76.5.3). MATERIALIZED: each provider's current
    // property is one seek, made once, not once per value. The providers are
    // the three the collectors write.
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
    // Full-horizon, untruncated annotation calendar. The visible timeline is
    // deliberately capped/anchored; reusing it here would turn every older row
    // beyond the cap into a silently "quiet" day (ro-5e8.9). On Postgres (bead
    // ro-ujb9.76.5.7): the UTC day of each change, bounded on the instant so
    // the (site, time) index seeks it; D1 cut the same ten characters from
    // its text.
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

  // WATCH_SERIES' order, not the store's: the composer walks the same list, so
  // the history it looks a series up in is indexed the way the chooser offers
  // them.
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
// Nightly site-health history (db/0014 hygiene_checks) — bead `ro-gct`
// ---------------------------------------------------------------------------

/** How far back the site-health section looks.
 *
 * Ninety days, the same horizon this page's provider trends use, so the two
 * halves of "how has this asset been doing" share one clock. It is also
 * comfortably longer than the depth rule's own 14-reading baseline window
 * (`DEPTH_BASELINE_WINDOW` in workers/ingest/src/hygiene.ts): the rule needs
 * enough history to decide TONIGHT, and this section exists for the decline the
 * rule's window is too short to show — a page that lost a third of its words
 * over two months trips no step-change test on any single night.
 */
const HYGIENE_WINDOW_DAYS = 90;

/**
 * Every check the store's vocabulary lists (`noticeos_ref.check_kinds`): the
 * four the `HygieneCheckId` type lists, sorted.
 *
 * The read names them so SQLite could seek the unique index (asset, check_id,
 * observed_on) on all three columns (bead `ro-ujb9.103`); Postgres applies the
 * date inside the index scan either way. The list is the whole vocabulary, not
 * only the three checks this section draws, so the rows read are exactly the
 * rows the unbounded read returned; `apps/tower/test/asset-page-bounded-reads.test.ts`
 * fails if a migration widens the vocabulary without this list.
 */
export const HYGIENE_CHECK_IDS: readonly HygieneCheckId[] = [
  "html-depth",
  "page-structure",
  "robots-ai-access",
  "sitemap",
];

/** The site-health rows since a date, in the order the section splits them.
 * On Postgres (bead ro-ujb9.76.5.8); `COLLATE "C"` is D1's byte order. */
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

/** One stored row as a reading, or null when the row is not one this surface can
 * honestly state. The status vocabulary is a CHECK constraint at rest, so an
 * unknown literal means the writer and this reader have diverged — the row is
 * dropped rather than rendered under a status nobody defined. */
function hygieneReadingOf(row: HygieneRow): HygieneReading | null {
  if (!HYGIENE_STATUSES.has(row.status)) return null;
  const value = row.valueNum;
  return {
    date: row.observedOn,
    observedAt: row.observedAt,
    status: row.status as HygieneStatus,
    // NULL is "not measured" and travels as null the whole way. Every
    // robots-ai-access row and every failed fetch is one.
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
 * run for it (bead `ro-gct`).
 *
 * ONE query over the (asset, check_id, observed_on) unique index the migration
 * calls out as "the only one the readers need" — three series come back
 * interleaved and are split here, rather than three round trips for one section.
 *
 * The per-bot map is read from the NEWEST robots row that actually carries one.
 * Walking back matters: a night the origin was unreachable stores no map, and
 * falling silent about crawler access because of one bad night would be the
 * section forgetting a fact it still knows.
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
 * this, and so does `GET /api/assets/:id` with no `?view=`. Every operational
 * table is read through the call's Postgres workspace store. */
export async function buildAssetDetailPayload(
  store: WorkspaceStore,
  id: string,
  deps: AssetDetailDeps,
): Promise<AssetDetailPayload | null> {
  return (await assembleAssetDetail(store, id, deps, null)) as AssetDetailPayload | null;
}

/**
 * One tab's view of the asset page (bead `ro-ujb9.64`): the core every tab
 * shows plus that tab's own sections, read once at one clock. This is what the
 * page polls each minute. `shared/asset-detail-views` says which tab draws
 * which section; a section a view does not carry is absent, never empty.
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

  // The clock every flag query below binds. `open` is time-dependent since
  // snooze arrived (`worker/flag-scope.ts`), and one instant for the whole
  // payload is what keeps the hero's count and its rows from disagreeing by a
  // millisecond.
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const panelAssetIds = serpPanelAssets(serpPanel);
  // The operator's declaration that this asset sends no nightly report — the
  // Wall's own set, so the card and this page cannot disagree (ro-ujb9.96.8).
  const declaredNoReport = new Set(noNightlyReport ?? []);
  const declared = declaredNoReport.has(id);
  // The last completed Mediavine reporting day (D42), independent of Settings.
  const yesterday = yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, []).date;

  // EVERY READ THAT NEEDS ONLY THE ASSET ROW, ISSUED TOGETHER (`ro-ujb9.64`).
  // They were awaited one after another, so each paid a full round trip to the
  // store before the next could start. None depends on another, so they now
  // overlap. A section the view does not draw is not read at all.
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
      // A freshness flag the declaration released is not open business here
      // either — the Wall leaves it out on the same rule until the next
      // freshness run resolves it.
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
    // arrival, not 28 days of reports. Count report dates, excluding today's
    // incomplete day. The Wall card's own statement, narrowed to this asset
    // (`./pulse-history`), so its work stays index seeks however many nights
    // the asset has kept.
    readPulseCoverage(store, nowIso, id).then((map) => map.get(id) ?? null),
    // The newest report always (wiring and freshness state when it arrived);
    // the 30 behind it only for the tabs that chart per-metric history. Each
    // day's newest revision, on Postgres (bead ro-ujb9.76.5.2).
    store
      .read((tx) =>
        tx.query<{ date: string; receivedAt: string; envelope: string }>(
          `SELECT pulse_date::text AS date, received_at AS "receivedAt", envelope::text AS envelope
             FROM noticeos.current_pulses WHERE asset_id = $1 ORDER BY pulse_date DESC LIMIT $2`,
          [id, wants("metrics") ? SERIES_DAYS : 1],
        ),
      )
      .then((rows) => rows.map((row) => ({ ...row, receivedAt: javascriptInstant(row.receivedAt) }))),
    // What is off the Open list, in its two states (bead `ro-ujb9.194`):
    // SETTLED — the audit trail, newest close first — and PARKED, grouped by
    // condition like the Open list above and like `/alerts`' Snoozed panel. A
    // snooze is not settled; it comes back on its date.
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
    // --- operator decisions (db/0013) ----------------------------------------
    // Deliberately unjoined: a decision's `key` is the query/finding identity
    // the client already renders, so the two sides match without this read
    // knowing anything about snapshot contents. A missing row means untouched.
    wants("decisions") ? loadDecisions(store, id) : null,
    // One photograph feeds every task-hub fact on this page — the operator
    // inbox, the handoff markers and the panel review — so a snapshot landing
    // between two reads cannot give them three subtly different presents. The
    // review marker is gated on the LANDING, exactly as the card is (`ro-1tu`).
    wants("tasks")
      ? Promise.all([loadLatestBeadsSnapshot(store), loadLatestPanelLandings(store, nowMs, panelAssetIds, id)])
      : null,
    // `asset` narrows the SAME query the Wall runs — one derivation, one
    // ordering, one set of window semantics (`ro-elf`). This page used to
    // compute every asset's ninety-seven-day trend and keep one of them, on a
    // sixty second poll (`ro-48p.2`).
    wants("performance")
      ? loadSignalTrends(store, PROPERTY_SIGNAL_CHART_DAYS, { includeSecondarySeries: true, asset: id, nowMs })
          .then((map) => map.get(id) ?? emptySignalTrendSet())
      : null,
    // The deeper provider archive stays in R2; only the analyzer's bounded,
    // evidence-bearing snapshot crosses into this read model: the site's
    // newest, by the order the store keeps two by
    // (`noticeos.insight_snapshot_is_kept`), read on Postgres (bead
    // ro-ujb9.76.5.4) as the text it was published as.
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
    // The composer's threshold prefill comes from this asset's own series, not
    // from the README's example (bead `ro-5e8.2`). It rides the watch slice
    // because it is only ever read to open a watch.
    wants("watchHistory") ? readWatchSeriesHistory(store, id, nowMs) : null,
    wants("reclamation") ? readReclamationTargets(store, id) : null,
    wants("hygiene") ? readHygieneHistory(store, id, now) : null,
    // The site's recent failed nightly-report fetches (db/0040, bead
    // `ro-ujb9.220`); null on a store without the table.
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
    // The site's all-time totals (bead `ro-trai.21`): read only when the
    // Overview draws them and the register configures any.
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

  // --- all-time totals (bead `ro-trai.21`) ------------------------------------
  // The rule the Wall's card used: each configured card from the freshest lane
  // that carries it, the counters lane or the latest report's own total.
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
    // Changes that might explain those alerts. Read against the flags' own
    // date range rather than off the (recency-capped) timeline — an alert from
    // three months ago must still find the deploy it sat next to.
    readAlertChanges(store, id, [...openFlagRows, ...snoozedFlagRows, ...historyFlagRows].map((f) => f.firedAt)),
    // Which of these the operator has already heard about on their
    // notification channel (bead `ro-vu8d.23`). A separate read rather than a
    // join, because db/0031 is operator-applied and a join would take the page
    // down on an install that has not applied it.
    loadNotifiedAt(store, [...openFlagRows, ...snoozedFlagRows, ...historyFlagRows].map((f) => f.id)),
    // --- integrations section (file-backed scope + observed effective health)
    // Reuses evidence already read above: the recent CURRENT revenue rows
    // (family/source drive the manual-lane evidence).
    loadIntegrationEvidence(store, {
      now, integrations, serpPanel, assetId: id, presentation: 'full',
      reuse: {
        revenueRows: new Map([[id, ledgerRead.recentRevenue]]),
      },
    }),
    // Each alert's stored readings, for its Evidence (db/0040, bead
    // `ro-ujb9.220`): the nights behind a refreshed summary. Empty on a store
    // without the table.
    readFlagReadings(store, [...openFlagRows, ...snoozedFlagRows, ...historyFlagRows].map((f) => f.id)),
  ]);
  const readingsFor = (flagId: number) => readingsOf(readings, flagId);
  const integrationsSection = integrationEvidence.asset(id, {
    latestReportAt: lastPulse?.receivedAt ?? null,
    pull: pullConfig.find((entry) => entry.asset === id) ?? null,
    isOs: asset.isOs === 1,
    declaredNoReport: declared,
  });

  // --- ONE ROW PER CONDITION, the Wall's grouping verbatim (`ro-kukv.5`) -----
  //
  // `flags.open` used to be one row per FIRING, so one asset's month-long
  // `asset-declared` condition was one row reading "16× in 26d" on the Wall and
  // sixteen identical rows here — two different portfolios depending on which
  // screen the operator was standing in front of. `groupConditionFirings` is the
  // Wall's own derivation, and it is the same (asset, rule_id, metric) scope
  // `applyFlagAction` re-derives in SQL, so Mark read / Resolve under a grouped
  // row disposition exactly the firings the row claims to stand for.
  //
  // Both payloads group all open severities before choosing their displayed
  // condition set. The Wall then shows error/warn only; the asset also carries
  // info and historical events. Occurrences therefore match the action scope.
  //
  // A condition's newest representative supplies its evidence; its complete
  // firing set supplies counts. Wall uses this identical reviewed selection.
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
    // Not current, but never deleted: a milestone belongs on the timeline and a
    // stale condition is worth being able to look at. They leave the heading
    // that claims they are live, and nothing else.
    notCurrent,
    // Parked, one row per condition, soonest back first — the same grouping
    // and order as `/alerts`' Snoozed panel (`wall-payload.ts`).
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
    // History is NOT grouped: it is ordered by when each row was closed, and
    // rows dispositioned on different days are not one event. Each stands for
    // itself and dates itself.
    history: historyFlagRows.map((r) => ({
      ...toFlagRecord(r, alertChanges, { occurrences: 1, firstFiredAt: r.firedAt }),
      notifiedAt: notifiedAt.get(r.id) ?? null,
      ...readingsFor(r.id),
      liveness: { state: "historical" as const },
      verification: deriveAlertEvidence({ ...r, asset: id, ruleInputs: parseRuleInputs(r.ruleInputs) }, nowMs).verification,
    })),
    // The same eligible condition counts the Wall card states. Repeated
    // firings stay on each condition's occurrences rather than inflating badges.
    openError: info.openError,
    openWarn: info.openWarn,
  };

  // --- serp-panel review obligation (bead ro-elf) ----------------------------
  // The card's two fields, from the card's own two readers. Nothing here is a
  // second opinion: `cardPanelReviewsOf` over the newest beads snapshot and
  // `loadLatestPanelLandings` over the report runs (both `./panel-review`)
  // are the exact functions wall-payload calls, so a page and the card that
  // linked to it cannot state different obligations for one asset. The state
  // RULE is shared too — `panelReviewState` in shared/wall, applied at render
  // on both surfaces.
  //
  // Gated on the LANDING, exactly as the card is (`ro-1tu`): the marker follows
  // the review, and the review follows the weekly DataForSEO collection, which
  // since `ro-478` every collecting asset owes a read of — panel or no panel.
  //
  // config/serp-panel.json still has one job here and it is not gating: it picks
  // the NOUN the marker uses (`ro-z0g`), so an asset that buys no panel reads
  // as a signal collection — the word its own review bead is titled with.
  const [beadsSnapshot, panelLandings] = tasksRead ?? [null, null];
  const latestPanelDate = panelLandings?.get(id) ?? null;

  // The payload's fields in one order whichever view is cut, so the whole page
  // reads exactly as it always has. A section the view does not draw leaves its
  // fields out entirely; `viewCovers` is how the page tells that from "empty".
  const payload: AssetDetailResponse = {
    ...(view === null ? {} : { view }),
    generatedAt: nowIso,
    asset: info,
    scheduledLanes,
    wiring,
    // The site's own entry in each register its Settings tab edits (beads
    // `ro-x5gu.4`, `ro-ujb9.76.4.5`). `undefined` — the asset is not in the
    // file — becomes `null`, which is the state each editor is designed
    // around.
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
          // The task source's inbox for this site (`./task-source`, D32).
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
      // Over CURRENT rows only, the same set the ledger renders: a superseded
      // estimate is no longer part of this asset's ledger, so it cannot set
      // how old the lane is.
      ledgerRecordedAt: ledgerRead.latestRecordedAt,
      flagFiredAt: flagTs?.ts ?? null,
      annotationAt: annTs?.ts ?? null,
    },
  };
  return payload;
}

/**
 * What the task hub holds for this asset's findings and queries, or null
 * when it could not be asked (bead `ro-248`).
 *
 * The Tower cannot reach the hub — it is a Worker and the hub speaks MySQL on
 * the operator's Mac — so this reads the same `beads_snapshots` photograph the
 * /work board and the asset card read: `scripts/os-up.mjs` shells `bd` once
 * a minute per spoke and POSTs what it saw. One poll cycle is therefore the
 * latency between filing a bead and its marker appearing, which is the cadence
 * the whole work surface already runs at.
 *
 * FOUR different things return null, and they are one answer on purpose:
 * no snapshot has ever been filed, this asset is not a spoke in
 * `config/beads.json`, `bd` failed for its repo, or the snapshot predates the
 * field. None of them is a measurement of what has been filed, and every one of
 * them must render as "we do not know" rather than as "nothing was filed" — the
 * card's untouched state is a claim, and it is only earned by an empty list.
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
 * This asset's ledger in ONE statement over ONE evaluation of the current-row
 * view (bead `ro-ujb9.64`).
 *
 * It used to read every current row for the asset and total them in
 * JavaScript, then read the view again for the lane's age. The totals are now
 * computed in SQL, so the page receives one row per (period, booking state,
 * kind, family) rather than every entry, plus only the 20 newest rows it
 * lists. The totals still cover every current row: they are SUMs over all of
 * them, never over the 20.
 *
 * The expensive part of each read is the view itself, `noticeos.financial_ledger`
 * on the call's store (bead ro-ujb9.76.6.1), which holds only current entries.
 * The CTE is MATERIALIZED so every part of the answer comes from one
 * evaluation. An entry is known by its workspace's number (a month of daily
 * estimates by minus its first day's), never the store's identity.
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
