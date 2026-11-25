import { beginCollection, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
import { signalObjectScope, type SignalObjectScope } from './signal-objects.js';
import { observeIntegration, tryHealthConnection, type HealthConnection } from './integration-health-context.js';
// DataForSEO search-intelligence collector. The weekly cron and
// `POST /api/signal-collect` share one function; a scope only narrows the sweep
// plan, so every run lands the same manifest row, archive and cost.

import {
  archiveCollectedDump,
  ARCHIVE_BYTE_LIMIT,
  LOCAL_STORE_FAILED,
  localStoreError,
  archiveDumpFailure,
  unmeasuredDumpOutcome,
  type DumpPage,
  type DumpTarget,
  type SignalDumpOutcome,
} from './signal-dumps.js';
import {
  EGRESS_DOWN_CODE,
  EgressGate,
  type EgressLaneRecord,
  type EgressRunOutcome,
  type TransportWatch,
  egressExplains,
  openEgressLaneRecord,
  watchTransport,
} from './egress.js';
import {
  boundedResponseJson,
  normalizeSignalError,
  reportDateOffset,
  SignalError,
} from './signal-store.js';
import {
  DATAFORSEO_MONTHLY_CADENCE_DAYS,
  DATAFORSEO_WEEKLY_CADENCE_DAYS,
  MAX_REPORT_COST_USD,
  SERP_PANEL_CALL_USD,
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT,
  dataForSeoReportsFor,
  meteredSpendSince,
  siteHost,
  type DataForSeoReport,
} from '@noticeos/contract';
import type { CredentialSource } from '@noticeos/contract';
import {
  credentialConnected,
  recordCredentialOutcome,
  resolveCredential,
  sourcedCredentialRef,
} from './credentials.js';
import { readDataForSeoAccount, recordDataForSeoBalance } from './dataforseo-balance.js';
import { canReserveDataForSeo, customerDataForSeoRequestKey, reserveDataForSeo, settleDataForSeo } from './dataforseo-budget.js';
import {
  type LaneMappingSource,
  type LaneRegister,
  laneDeclined,
  mappingSourceTally,
  resolveDataForSeoScope,
} from './lane-mapping.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import type { WorkspaceStore } from '@noticeos/postgres';
import { SITE_ORDER } from '@noticeos/contract';
import { DATAFORSEO_ORIGIN, DATAFORSEO_REPORT_PATHS, dataForSeoPaidTimeoutMs } from '../../../scripts/customer-dataforseo-egress.mjs';
import type { DataForSeoConnectionPin } from '../../../scripts/customer-collection-policy.mjs';
import constants from '../../../config/constants.json';
import serpPanelConfigJson from '../../../config/serp-panel.json';
import { isolateState } from './isolate-state.js';
import { arrayField, asRecord, sha256Hex, stringField, wholeUtcDaysBetween } from './shared.js';

const API_BASE = DATAFORSEO_ORIGIN + '/v3';
const CREDENTIAL_REF = 'DATAFORSEO_LOGIN+DATAFORSEO_PASSWORD';
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;
/** Not the paid calls' deadline: a courtesy read must never hold a finished sweep open. */
const ACCOUNT_TIMEOUT_MS = 10_000;
// The largest single page the provider accepts for ranked keywords.
const RANKED_KEYWORD_LIMIT = 1_000;
const HISTORY_DAYS = 90;
/** The head answers both questions these families ask, and 100 rows keeps a
 * call inside the per-family reserve. */
const BACKLINK_ROW_LIMIT = 100;
/** Ordered by search volume, so the cap holds the demand rather than the tail. */
const KEYWORD_IDEAS_LIMIT = 100;
/** Ordered by keyword intersection; past the first handful the overlap is noise. */
const SERP_COMPETITORS_LIMIT = 20;
/** `keyword_ideas` expands by category, not string: without a ceiling the
 * internet's biggest queries fill every slot. */
const KEYWORD_IDEAS_VOLUME_CEILING = 500_000;
/** A saved cap can be set independently of the other portfolio settings. */
export function dataForSeoMonthlyCap(settings: unknown, fallback = constants.monthly_caps.data_usd): number {
  const cap = asRecord(asRecord(settings)?.monthly_caps)?.data_usd;
  return typeof cap === 'number' ? cap : fallback;
}
/** Two pages. A property below this records no rank: "not inside the tracked
 * depth", never "not ranking". */
const SERP_PANEL_DEPTH = 20;
/** A label is a group name that becomes a CSV value and a readout heading. */
const SERP_PANEL_LABEL_LIMIT = 60;
/** Waits before each retry; the length is the retry budget, spent per FAMILY so
 * a 56-call panel cannot multiply it. */
const RETRY_BACKOFF_MS = [1_000, 3_000];
/** The longest wait a `Retry-After` may buy before the family fails instead,
 * bounded so a wholly rate-limited sweep still finishes inside `LANE_LEASE_MS`. */
const RETRY_AFTER_CAP_MS = 10_000;
/** How long the lane stays held after its holder last started a provider call:
 * several times the longest call, and the longest a dead run can lock the
 * operator out. */
const LANE_LEASE_MS = 15 * 60_000;

type LlmPlatform = 'google' | 'chat_gpt';

interface DataForSeoTarget extends DumpTarget {
  integration: 'dataforseo';
  /** The market every family for this property is asked in, resolved once per property. */
  locationCode: number;
  languageCode: string;
  /** Whether that scope came from the asset's own entry or the baseline. */
  mappingSource: LaneMappingSource;
}

interface PortfolioCandidate {
  asset: string;
  domain: string;
}

/** One provider call. `body` is posted verbatim, so it may carry only fields the
 * provider documents; everything else true of the call rides beside it in the
 * archived page envelope. */
interface PlannedRequest {
  body: Record<string, unknown>;
  /** The cluster this tracked query measures, archived with the observation and
   * never transmitted: a label read from today's config would silently relabel
   * history when a cluster is renamed. */
  label?: string;
}

/** One paid response, durable before the report is archived. These
 * objects are resumable working evidence, not complete family manifests; every
 * read model continues to trust only signal_dump_runs. */
interface DataForSeoRequestCheckpoint {
  schemaVersion: 1;
  asset: string;
  report: DataForSeoReport;
  reportDate: string;
  requestHash: string;
  page: DumpPage;
  providerRows: number;
  costUsd: number;
  taskError: { code: string; message: string } | null;
  costAccounted?: true;
  priceConfirmed?: true;
  rankedKeywordsTruncated?: true;
}

export const DATAFORSEO_CHECKPOINT_PREFIX = 'checkpoints/dataforseo';

interface ReportSpec {
  name: DataForSeoReport;
  path: string;
  /** Minimum whole UTC days between successful/unchanged provider snapshots. */
  cadenceDays: number;
  /** One provider POST per entry; all of a family's responses land in one
   * archive with one manifest row. */
  requests(
    target: DataForSeoTarget,
    reportDate: string,
    panel: SerpPanelConfig,
  ): PlannedRequest[];
  /** Whether this family applies to a property at all, without reading config
   * deeply enough to fail: absence of config is not a failed collection, and
   * malformed config is raised from `requests`. Takes the asset id because the
   * on-demand route asks before a target exists. */
  appliesTo?(asset: string, panel: SerpPanelConfig): boolean;
  /** Runs for minutes rather than seconds: the sweep collects every single-call
   * family before any long one, and each paid response is checkpointed. */
  longRunning?: boolean;
  /** Keep a provider-level task failure beside the family's other responses
   * instead of discarding the run. Transport failures still fail the whole
   * family, and a family whose every request failed is an error, not an empty
   * success. */
  independentRequests?: boolean;
}

export interface DataForSeoDumpOutcome extends SignalDumpOutcome {
  costUsd: number;
  /** Provider calls this family repeated before it landed; 0 on a clean collection. */
  retries: number;
  unconfirmedCost?: true;
}

export interface DataForSeoDumpsResult {
  monitoringAvailable?: boolean;
  attempted: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  costUsd: number;
  outcomes: DataForSeoDumpOutcome[];
  /** Absent on a run that asked DataForSEO nothing. */
  egress?: EgressRunOutcome;
  /** Set instead of a collection: another run held the lane, so every tally above is 0. */
  refused?: DataForSeoRunInFlight;
}

// The collector lane avoids redundant work within one isolate. The database
// reserves paid attempts across isolates. The local lane cannot wedge shut: the
// holder's `finally`, a restarted runtime and the lease each free it.

/** The run that already holds the lane, as the trigger it refused reports it. */
export interface DataForSeoRunInFlight {
  /** When the holding run started, on the clock its start line was written on. */
  startedAt: string;
  /** Whole seconds. */
  runningSeconds: number;
  /** The holder's scope, or null for a portfolio run. */
  scope: DataForSeoCollectScope | null;
  /** Set when the holder is re-collecting reports missed during an outage. */
  recovery?: true;
  /** When the lane frees itself if the holder starts no further provider call. */
  leaseExpiresAt: string;
}

interface CollectorLane {
  /** Rising within this isolate, and the release token: a run whose lease expired
   * and was taken over must not free the lane its successor now holds. */
  readonly token: number;
  readonly startedAtMs: number;
  /** The lease runs from here: the claim, then each provider call the holder
   * starts, so a sweep longer than the lease keeps the lane while it works. */
  activeAtMs: number;
  readonly scope: DataForSeoCollectScope | null;
  readonly recovery: boolean;
}

const lanes = new Map<string, CollectorLane>();
let laneTokens = 0;
// Forgetting frees the lane but keeps the tokens rising, so a run still going
// from before cannot free the lane of a run started after it.
isolateState('DataForSEO collector lane', { forget: () => lanes.clear(), held: () => lanes.size > 0 });

type LaneClaim =
  | { token: number; blockedBy: null }
  | { token: null; blockedBy: DataForSeoRunInFlight };

/** Take the lane, or report who has it. Synchronous so two triggers in one tick see each other. */
function claimLane(
  workspaceId: string,
  nowMs: number,
  scope: DataForSeoCollectScope | null,
  recovery: boolean,
  preserveRecoveryLock: boolean,
): LaneClaim {
  const held = lanes.get(workspaceId);
  if (held && (nowMs < held.activeAtMs + LANE_LEASE_MS || (preserveRecoveryLock && held.recovery))) {
    return { token: null, blockedBy: laneHolder(held, nowMs) };
  }
  const token = (laneTokens += 1);
  lanes.set(workspaceId, { token, startedAtMs: nowMs, activeAtMs: nowMs, scope, recovery });
  return { token, blockedBy: null };
}

function releaseLane(workspaceId: string, token: number): void {
  if (lanes.get(workspaceId)?.token === token) lanes.delete(workspaceId);
}

/** Restart the holder's lease. A run that lost the lane cannot renew its successor's. */
function keepLane(workspaceId: string, token: number, nowMs: number): void {
  const held = lanes.get(workspaceId);
  if (held?.token === token && nowMs > held.activeAtMs) held.activeAtMs = nowMs;
}

function laneHolder(held: CollectorLane, nowMs: number): DataForSeoRunInFlight {
  return {
    startedAt: new Date(held.startedAtMs).toISOString(),
    runningSeconds: Math.max(0, Math.round((nowMs - held.startedAtMs) / 1000)),
    scope: held.scope,
    ...(held.recovery ? { recovery: true } : {}),
    leaseExpiresAt: new Date(held.activeAtMs + LANE_LEASE_MS).toISOString(),
  };
}

/** Narrow a run to one property, and optionally to some of its families. The
 * route validates both fields; the scope is applied as the narrowing itself,
 * so nothing downstream needs to trust it. */
export interface DataForSeoCollectScope {
  /** Exactly one property id, matched against the collector's OWN membership
   * query — a scope can only reach a property the weekly lane would collect. */
  asset: string;
  /** A subset of `DATAFORSEO_REPORTS`. Omitted means every applicable family
   * for this property. A scope is an explicit baseline/repair, so it deliberately
   * bypasses the automated freshness filter. */
  families?: readonly string[];
}

export interface DataForSeoDumpsOptions {
  nowMs?: number;
  /** The purchasing clock can advance even when the report date stays fixed. */
  requestClock?: () => number;
  fetchImpl?: typeof fetch;
  login?: string;
  password?: string;
  monthlyCapUsd?: number;
  /** Override the built-in config/serp-panel.json (tests inject their own). */
  serpPanelConfig?: SerpPanelConfig;
  /** Override the retry waits (tests use zeroes, or `[]` for no retry at all). */
  retryBackoffMs?: number[];
  /** Override the compiled-in config/integrations.json mapping (tests state
   * their own register instead of editing the operator's file). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file; reported on the completion line. */
  configSources?: ConfigSourceMap;
  /** One property instead of the portfolio — see `DataForSeoCollectScope`. */
  scope?: DataForSeoCollectScope | null;
  /** Workspace properties explicitly approved for an automated paid schedule. */
  scheduledAssets?: ReadonlyMap<string, readonly string[]>;
  approvedCredential?: DataForSeoConnectionPin;
  authorizePurchase?: () => Promise<void>;
  signal?: AbortSignal;
  /** The customer schedule requires a saved cap and stops on an unconfirmed bill. */
  fenceUnsettled?: true;
  /** A scheduled sweep and its automatic retry must never take over outage recovery. */
  preserveRecoveryLock?: true;
  /** Override the run's egress gate (tests control the verdict TTL); every other
   * caller gets a real one over the same fetcher. */
  egress?: EgressGate;
}

/** The run's egress question, carried to every call that might owe it. */
interface EgressLane {
  gate: EgressGate;
  transport: TransportWatch;
}

const REPORTS: ReportSpec[] = [
  {
    name: 'ranked-keywords',
    path: DATAFORSEO_REPORT_PATHS.rankedKeywords,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          location_code: target.locationCode,
          language_code: target.languageCode,
          item_types: ['organic', 'featured_snippet', 'ai_overview_reference'],
          historical_serp_mode: 'live',
          include_clickstream_data: false,
          limit: RANKED_KEYWORD_LIMIT,
          filters: [
            ['keyword_data.keyword_info.search_volume', '>', 0],
            'and',
            ['ranked_serp_element.serp_item.rank_group', '<=', 100],
          ],
          order_by: ['keyword_data.keyword_info.search_volume,desc'],
          tag: `${target.asset}:ranked-keywords`,
        },
      },
    ],
  },
  {
    name: 'backlinks-summary',
    path: DATAFORSEO_REPORT_PATHS.backlinksSummary,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          include_subdomains: true,
          backlinks_status_type: 'live',
          internal_list_limit: 10,
          tag: `${target.asset}:backlinks-summary`,
        },
      },
    ],
  },
  {
    name: 'backlinks-new-lost',
    path: DATAFORSEO_REPORT_PATHS.backlinksNewLost,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target, reportDate) => {
      // This endpoint accepts completed days only: the archive says when we
      // observed, the request ends yesterday.
      const completedThrough = reportDateOffset(reportDate, -1);
      return [
        {
          body: {
            target: target.propertyRef,
            date_from: reportDateOffset(completedThrough, -(HISTORY_DAYS - 1)),
            date_to: completedThrough,
            group_range: 'week',
            tag: `${target.asset}:backlinks-new-lost`,
          },
        },
      ];
    },
  },
  {
    // The names behind the referring-domain count; what `reclamation_targets`
    // is pointed at.
    name: 'backlinks-referring-domains',
    path: DATAFORSEO_REPORT_PATHS.referringDomains,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          include_subdomains: true,
          backlinks_status_type: 'live',
          limit: BACKLINK_ROW_LIMIT,
          // Rank first, so a truncated response keeps the domains worth having.
          order_by: ['rank,desc'],
          tag: `${target.asset}:backlinks-referring-domains`,
        },
      },
    ],
  },
  {
    // The anchor profile as a distribution rather than a list.
    name: 'backlinks-anchors',
    path: DATAFORSEO_REPORT_PATHS.anchors,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          include_subdomains: true,
          backlinks_status_type: 'live',
          limit: BACKLINK_ROW_LIMIT,
          // The head carries the shape: the anchors used by the most distinct domains.
          order_by: ['referring_domains,desc'],
          tag: `${target.asset}:backlinks-anchors`,
        },
      },
    ],
  },
  {
    // Seeds come from the panel: the operator's own statement of which head
    // terms matter, already loaded here. A property with no panel gets no ideas
    // rather than ideas grown from a guess.
    name: 'keyword-ideas',
    path: DATAFORSEO_REPORT_PATHS.keywordIdeas,
    cadenceDays: DATAFORSEO_MONTHLY_CADENCE_DAYS,
    appliesTo: (asset, panel) => serpPanelEntry(panel, asset) !== undefined,
    requests: (target, _reportDate, panel) => [
      {
        body: {
          keywords: trackedQueries(panel, target.asset).map((q) => q.keyword),
          location_code: target.locationCode,
          language_code: target.languageCode,
          limit: KEYWORD_IDEAS_LIMIT,
          order_by: ['keyword_info.search_volume,desc'],
          // The upper bound is the load-bearing filter: `keyword_ideas` expands
          // by category, so without it the internet's largest queries fill
          // every slot.
          filters: [
            ['keyword_info.search_volume', '>', 0],
            'and',
            ['keyword_info.search_volume', '<', KEYWORD_IDEAS_VOLUME_CEILING],
          ],
          tag: `${target.asset}:keyword-ideas`,
        },
      },
    ],
  },
  {
    // Who else holds the SERPs this property competes on.
    name: 'serp-competitors',
    path: DATAFORSEO_REPORT_PATHS.competitors,
    cadenceDays: DATAFORSEO_MONTHLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          location_code: target.locationCode,
          language_code: target.languageCode,
          limit: SERP_COMPETITORS_LIMIT,
          // By how many of our keywords they also rank for, not by their size.
          order_by: ['intersections,desc'],
          // The property intersects itself on every keyword, so it is excluded.
          filters: [
            ['intersections', '>', 0],
            'and',
            ['domain', '<>', target.propertyRef],
          ],
          tag: `${target.asset}:serp-competitors`,
        },
      },
    ],
  },
  llmReport('google'),
  llmReport('chat_gpt'),
  {
    // The hand-picked panel: one call per (query, device), still one family,
    // one archive and one manifest row per property per run. The content hash
    // that decides `success` vs `unchanged` covers every page's body, `device`
    // included.
    name: 'serp-panel',
    path: DATAFORSEO_REPORT_PATHS.panel,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    appliesTo: (asset, panel) => serpPanelEntry(panel, asset) !== undefined,
    longRunning: true,
    independentRequests: true,
    requests: (target, _reportDate, panel) =>
      // Device-inner: a query's two result pages sit side by side in the
      // archive. `device` is a provider field and goes in the body; `label` is
      // our taxonomy and rides beside it. Both device pages carry the same label.
      panelWithinCostCeiling(
        trackedQueries(panel, target.asset),
        target.asset,
      ).flatMap(({ keyword, label }) =>
        SERP_PANEL_DEVICES.map((device) => ({
          body: {
            keyword,
            location_code: target.locationCode,
            language_code: target.languageCode,
            device,
            depth: SERP_PANEL_DEPTH,
            // Without this the AI Overview is often absent even when Google served one.
            load_async_ai_overview: true,
            // A live call otherwise returns Google's redirect links in place of
            // the ranked pages. Resolving them here is part of the call's price.
            resolve_goto_urls: true,
            tag: `${target.asset}:serp-panel`,
          },
          // Omitted, not empty, when the panel labels nothing: an unlabelled
          // collection archives byte-for-byte what it always did.
          ...(label === null ? {} : { label }),
        })),
      ),
  },
];

function llmReport(platform: LlmPlatform): ReportSpec {
  const name =
    platform === 'chat_gpt'
      ? 'llm-mentions-chatgpt'
      : 'llm-mentions-google';
  return {
    name,
    path: DATAFORSEO_REPORT_PATHS.llmMentions,
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          location_code: target.locationCode,
          language_code: target.languageCode,
          platform,
          target: [
            {
              domain: target.propertyRef,
              search_filter: 'include',
              search_scope: ['sources', 'search_results'],
              include_subdomains: true,
            },
          ],
          internal_list_limit: 10,
          tag: `${target.asset}:${name}`,
        },
      },
    ],
  };
}

/** One entry of a property's tracked panel: the bare string is the query; the
 * object form adds the cluster `label` this query measures. */
export type SerpPanelQuery = string | { query: string; label?: string };

export interface SerpPanelAssetConfig {
  queries: SerpPanelQuery[];
}

export interface SerpPanelConfig {
  assets: Record<string, SerpPanelAssetConfig>;
}

const SERP_PANEL_CONFIG = serpPanelConfigJson as SerpPanelConfig;

/** Lenient lookup, so an unconfigured property is skipped without a malformed
 * one aborting the sweep here. */
function serpPanelEntry(panel: SerpPanelConfig, asset: string): unknown {
  const assets = panel?.assets;
  return assets && typeof assets === 'object'
    ? (assets as Record<string, unknown>)[asset]
    : undefined;
}

/** A tracked query as the collector will ask it and store it: the keyword the
 * provider is sent, and the cluster the archive keeps beside the answer. */
interface TrackedQuery {
  keyword: string;
  label: string | null;
}

/** The panel's own cost rule: one metered call per (query, device), so the
 * biggest legal panel must fit the reserve the budget gate takes. Not applied
 * to `keyword-ideas`, which seeds one call from the same config. */
function panelWithinCostCeiling(
  queries: readonly TrackedQuery[],
  asset: string,
): readonly TrackedQuery[] {
  // Raising the cap means raising the per-report reserve it is derived from.
  if (queries.length > SERP_PANEL_QUERY_LIMIT) {
    throw new SignalError(
      'config_invalid',
      `${queries.length} tracked terms for ${asset} · the panel cap is ${SERP_PANEL_QUERY_LIMIT}`,
    );
  }
  return queries;
}

/** Validated for shape; every rule is a config error rather than a silent
 * repair, because a trimmed, deduplicated or emptied panel would bill for one
 * question and answer another. */
export function trackedQueries(panel: SerpPanelConfig, asset: string): TrackedQuery[] {
  const entry = serpPanelEntry(panel, asset);
  const queries = (entry as SerpPanelAssetConfig | undefined)?.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json entry for ${asset} has no tracked queries.`,
    );
  }
  const seen = new Set<string>();
  /** Normalized cluster label -> the spelling that claimed it first. */
  const claimedLabels = new Map<string, string>();
  const tracked: TrackedQuery[] = [];
  for (const item of queries) {
    if (typeof item !== 'string' && asRecord(item) === null) {
      throw new SignalError(
        'config_invalid',
        `config/serp-panel.json lists a tracked query for ${asset} that is neither a string nor a { query, label } object.`,
      );
    }
    const source: Record<string, unknown> =
      typeof item === 'string' ? { query: item } : asRecord(item)!;
    const raw = source.query;
    const keyword = typeof raw === 'string' ? raw.trim() : '';
    if (keyword.length === 0) {
      throw new SignalError(
        'config_invalid',
        `config/serp-panel.json lists a blank tracked query for ${asset}.`,
      );
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) {
      throw new SignalError(
        'config_invalid',
        `config/serp-panel.json repeats the tracked query "${keyword}" for ${asset}.`,
      );
    }
    seen.add(key);
    tracked.push({
      keyword,
      label: trackedLabel(source.label, keyword, asset, claimedLabels),
    });
  }
  return tracked;
}

/** The cluster this query measures, or null: labelling is optional. Grouping is
 * an exact-string match on the stored label, so two spellings of one label are
 * the same mistake as two spellings of one term. */
function trackedLabel(
  value: unknown,
  keyword: string,
  asset: string,
  claimed: Map<string, string>,
): string | null {
  if (value === undefined) return null;
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length === 0) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json gives the tracked query "${keyword}" a blank label for ${asset}; omit the field instead.`,
    );
  }
  if (label.length > SERP_PANEL_LABEL_LIMIT) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json labels the tracked query "${keyword}" with ${label.length} characters for ${asset}; the cluster-label cap is ${SERP_PANEL_LABEL_LIMIT}.`,
    );
  }
  const first = claimed.get(label.toLowerCase());
  if (first !== undefined && first !== label) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json spells one cluster two ways for ${asset}: "${first}" and "${label}".`,
    );
  }
  claimed.set(label.toLowerCase(), label);
  return label;
}

/** One collection, whichever door it came through, and never two at once. A
 * refused trigger returns a zeroed result carrying `refused` rather than
 * throwing: the cron must not record a platform failure, and the route turns
 * it into a 409. */
export async function runDataForSeoDumps(
  env: IngestEnv,
  options: DataForSeoDumpsOptions = {},
): Promise<DataForSeoDumpsResult> {
  return await runCollector(env, options, null);
}

/** Daily re-collection of the (property, family) pairs the open
 * `os-egress-down` flag names. A family that failed at the provider is never on
 * that list. Free when nothing is owed: the flag is read before the lane is
 * claimed or anything is logged. */
export async function runDataForSeoRecovery(
  env: IngestEnv,
  options: Omit<DataForSeoDumpsOptions, 'scope'> = {},
): Promise<DataForSeoDumpsResult> {
  const owed = await openEgressLaneRecord(env, 'dataforseo');
  const repairCheckpoints = options.fenceUnsettled === true && options.scheduledAssets !== undefined;
  if (owed === null && !repairCheckpoints) {
    return { attempted: 0, succeeded: 0, unchanged: 0, failed: 0, costUsd: 0, outcomes: [] };
  }
  return await runCollector(env, { ...options, scope: null }, owed, repairCheckpoints);
}

async function runCollector(
  env: IngestEnv,
  options: DataForSeoDumpsOptions,
  owed: EgressLaneRecord | null,
  repairCheckpoints = false,
): Promise<DataForSeoDumpsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const workspaceId = await env.STORE.workspaceId();
  const claim = claimLane(workspaceId, nowMs, options.scope ?? null, owed !== null || repairCheckpoints, options.preserveRecoveryLock === true);
  if (claim.blockedBy) {
    // Neither a start nor a complete line: "one start, no complete" keeps
    // meaning an interrupted run.
    console.log(
      JSON.stringify({
        event: 'dataforseo_dumps_refused',
        reason: 'run_in_flight',
        ...(options.scope
          ? {
              scope: {
                asset: options.scope.asset,
                families: options.scope.families ?? null,
              },
            }
          : {}),
        inFlight: claim.blockedBy,
      }),
    );
    return {
      attempted: 0,
      succeeded: 0,
      unchanged: 0,
      failed: 0,
      costUsd: 0,
      outcomes: [],
      refused: claim.blockedBy,
    };
  }
  // The clock the lane was claimed on: an injected `nowMs` never advances.
  const laneClock = options.nowMs === undefined ? Date.now : () => nowMs;
  const keep = () => keepLane(workspaceId, claim.token, laneClock());
  try {
    return await collectDueReports(env, options, nowMs, owed, repairCheckpoints, keep);
  } finally {
    releaseLane(workspaceId, claim.token);
  }
}

/** Is this (property, family) on the outage entry? A property named with no
 * family list went unmeasured whole, so every family of it is owed. */
function owedFamily(owed: EgressLaneRecord, asset: string, family: string): boolean {
  if (!owed.unmeasuredAssets.includes(asset)) return false;
  const families = owed.parts?.[asset];
  return families === undefined || families.includes(family);
}

async function collectDueReports(
  env: IngestEnv,
  options: DataForSeoDumpsOptions,
  nowMs: number,
  owed: EgressLaneRecord | null,
  repairCheckpoints: boolean,
  keepLane: () => void,
): Promise<DataForSeoDumpsResult> {
  const recovery = owed !== null || repairCheckpoints;
  const requestedAt = new Date(nowMs).toISOString();
  const reportDate = requestedAt.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  // A caller that handed us a login is a test, so the source is `env` by definition.
  const approval = options.approvedCredential;
  const resolved = await resolveCredential(env, 'dataforseo', approval ? 'store-only' : 'legacy-fallback');
  if (approval && (resolved.source !== 'store' || resolved.connectionId !== approval.connectionId || resolved.secretVersion !== approval.secretVersion)) {
    throw new SignalError('dataforseo_approval_changed', 'Review the stored DataForSEO connection and renew its paid scheduling approval.');
  }
  const health = await tryHealthConnection(env, 'dataforseo', resolved);
  const monitoring = beginCollection(env.STORE, health);
  const login = options.login ?? resolved.fields.DATAFORSEO_LOGIN;
  const password = options.password ?? resolved.fields.DATAFORSEO_PASSWORD;
  const credentialSource: CredentialSource =
    options.login === undefined && options.password === undefined
      ? resolved.source
      : 'env';
  // Not connected at all is no work, not a failure: nothing is planned, reserved
  // or logged. A stored login this Worker cannot open is still connected, and
  // still fails below.
  if (
    (!login || !password) &&
    options.login === undefined &&
    options.password === undefined &&
    !(await credentialConnected(env, 'dataforseo', resolved))
  ) {
    console.log(JSON.stringify({ event: 'dataforseo_dumps_not_connected', ...(recovery ? { recovery: true } : {}) }));
    return { attempted: 0, succeeded: 0, unchanged: 0, failed: 0, costUsd: 0, outcomes: [] };
  }
  const monthlyCapUsd = options.monthlyCapUsd ?? dataForSeoMonthlyCap(undefined);
  const panel = options.serpPanelConfig ?? SERP_PANEL_CONFIG;
  const retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const scope = options.scope ?? null;
  const approved = options.scheduledAssets;
  // A property its Data sources row declines is neither asked for nor billed:
  // filtered before the plan, so it reserves nothing and writes no attempt row.
  const candidates = (await dataForSeoCandidates(env.STORE, scope?.asset ?? null))
    .filter((candidate) => (!approved || approved.has(candidate.asset)) && !laneDeclined(candidate.asset, 'dataforseo', options.laneRegister));
  const targets = candidates.map((candidate) =>
    dataForSeoTarget(
      candidate,
      sourcedCredentialRef(CREDENTIAL_REF, credentialSource),
      options.laneRegister,
    ),
  );
  const familiesFor = (asset: string) => scope?.families ?? approved?.get(asset);
  const sweep = sweepPlan(targets, panel, familiesFor);
  const recovered = repairCheckpoints && sweep.length
    ? await recoverDataForSeoCheckpoints(env, sweep, panel, requestedAt, options.signal) : [];
  if (repairCheckpoints && owed === null) {
    return dumpResult(recovered);
  }
  // The daily re-collection narrows the sweep to what the outage skipped; the
  // due check below still applies, so a family collected since is not re-bought.
  const fullPlan =
    owed === null
      ? sweep
      : sweep.filter(({ target, report }) => owedFamily(owed, target.asset, report.name));
  // A named operator collection is an intentional baseline/repair and may force
  // exactly the requested families. Cron and startup catch-up are automation:
  // they must prove each family due from durable manifests before paying.
  const { due: plan, skippedFresh } =
    scope === null
      ? await dueDataForSeoPlan(env.STORE, fullPlan, reportDate)
      : { due: fullPlan, skippedFresh: [] };
  // Announce before the sweep can be interrupted: a start without a completion
  // line is interruption evidence, and the next repair resumes checkpoints.
  console.log(
    JSON.stringify({
      event: 'dataforseo_dumps_start',
      properties: targets.length,
      reports: plan.length,
      skippedFresh,
      reportDate,
      // On the start line because a scope is what this run is about to spend on.
      mappingSources: mappingSourceTally(
        targets.map((target) => target.mappingSource),
      ),
      // Present only on an on-demand run, so a weekly line reads as it always has.
      ...(scope ? { scope: { asset: scope.asset, families: scope.families ?? null } } : {}),
      // Present only on the daily outage re-collection.
      ...(recovery ? { recovery: true } : {}),
    }),
  );

  // Asked before a status-less failure is granted a retry: on a dead uplink the
  // ladder would burn every family's budget against a wall. Only the report
  // calls are watched; the gate's beacons and the free account read use the raw
  // fetcher.
  const egress: EgressLane = {
    gate: options.egress ?? new EgressGate(env, { lane: 'dataforseo', fetchImpl, at: requestedAt }),
    transport: watchTransport(fetchImpl),
  };
  // A scoped run answers only for the families it was asked for. Every family
  // the plan attempted leaves the entry whatever became of it, so the daily
  // re-collection never retries a failure it cannot fix.
  const egressCoverage = scope || approved ? {
    covers: (asset: string, family: string | null) => {
      const families = familiesFor(asset);
      return (scope === null || asset === scope.asset) && (!approved || approved.has(asset))
        && (!families || (family !== null && families.includes(family)));
    },
  } : {};

  if (!login || !password) {
    const error = new SignalError(
      'config_missing',
      'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not configured.',
    );
    const outcomes: DataForSeoDumpOutcome[] = [];
    for (const { target, report } of plan) {
      const outcome = await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: report.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error,
        knownZeroCost: true,
      });
      outcomes.push({ ...outcome, costUsd: 0, retries: 0 });
    }
    const egressOutcome = await egress.gate.finalize(egressCoverage);
    return { ...finish([...recovered, ...outcomes], scope, skippedFresh, options.configSources, false, egressOutcome, recovery), ...collectionMonitoring(monitoring) };
  }

  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) {
    throw new SignalError(
      'config_invalid',
      'DataForSEO monthly data cap must be greater than zero.',
    );
  }
  const authorization = basicAuthorization(login, password);
  const outcomes: DataForSeoDumpOutcome[] = [];
  const requestClock = options.requestClock ?? (options.nowMs === undefined ? Date.now : () => nowMs);
  for (const { target, report } of plan) {
    options.signal?.throwIfAborted();
    if (!options.fenceUnsettled && !await canReserveDataForSeo(env.STORE, requestClock(), MAX_REPORT_COST_USD, monthlyCapUsd)) {
      const outcome = await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: report.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error: dataForSeoBudgetExhausted(monthlyCapUsd),
        knownZeroCost: true,
      });
      outcomes.push({ ...outcome, costUsd: 0, retries: 0 });
      continue;
    }
    const budget: RetryBudget = { store: env.STORE, backoffMs: retryBackoffMs, monthlyCapUsd, requestClock,
      signal: options.signal, fenceUnsettled: options.fenceUnsettled === true, approvedCredential: approval,
      authorizePurchase: options.authorizePurchase, keepLane, used: 0, confirmedUsd: 0, costUnconfirmed: false };
    const outcome = await collectReport(
      env,
      target,
      report,
      reportDate,
      requestedAt,
      authorization,
      egress,
      panel,
      budget,
      monitoring,
    );
    outcomes.push(budget.costUnconfirmed ? { ...outcome, unconfirmedCost: true } : outcome);
  }
  options.signal?.throwIfAborted();
  // One `os-egress-down` fact for the sweep — or the retraction of one an
  // earlier run left open.
  const egressOutcome = await egress.gate.finalize(egressCoverage);
  // One stamp per sweep on the credential. A family the dead uplink swallowed
  // says nothing about the login, so a sweep made only of those stamps nothing.
  const sweepWorked = outcomes.some((outcome) => outcome.status !== 'error');
  const measured = outcomes.filter((outcome) => !outcome.egressDown && outcome.errorCode !== LOCAL_STORE_FAILED);
  if (credentialSource === 'store' && measured.length > 0) {
    await recordCredentialOutcome(env, 'dataforseo', {
      ok: sweepWorked,
      error: sweepWorked ? null : 'Every DataForSEO report in this sweep failed.',
    });
  }
  // One free read of the account, only on a sweep that worked and only with a
  // stored credential to stamp: the report endpoints never volunteer the credit.
  const creditRefreshed =
    credentialSource === 'store' && sweepWorked
      ? await refreshAccountCredit(env, authorization, fetchImpl, requestedAt, health, new Date(options.nowMs ?? Date.now()).toISOString())
      : { refreshed: false, monitoringAvailable: true };
  return { ...finish([...recovered, ...outcomes], scope, skippedFresh, options.configSources, creditRefreshed.refreshed, egressOutcome, recovery), ...collectionMonitoring(monitoring), ...(!creditRefreshed.monitoringAvailable ? { monitoringAvailable: false } : {}) };
}

/** The sweep's one free account read. Free and treated as free: never weighed
 * against the cap, never retried, and never the sweep's failure. Stamped with
 * `requestedAt` so a sweep's evidence is dated one way. */
async function refreshAccountCredit(
  env: IngestEnv, authorization: string, fetchImpl: typeof fetch, requestedAt: string,
  health: HealthConnection | null, observedAt: string,
): Promise<{ refreshed: boolean; monitoringAvailable: boolean }> {
  let read: Awaited<ReturnType<typeof readDataForSeoAccount>>;
  try { read = await readDataForSeoAccount(authorization, fetchImpl, ACCOUNT_TIMEOUT_MS); }
  catch {
    const monitoringAvailable = await observeIntegration(env, health, { capability: 'dataforseo-credit', observedAt, ok: false, code: 'network' });
    return { refreshed: false, monitoringAvailable };
  }
  const usable = read.ok && read.usd !== null;
  const monitoringAvailable = await observeIntegration(env, health, { capability: 'dataforseo-credit', observedAt, ok: usable, code: read.ok ? 'incomplete-report' : 'provider' });
  if (!read.ok || read.usd === null) return { refreshed: false, monitoringAvailable };
  try { await recordDataForSeoBalance(env, read.usd, requestedAt); }
  catch { return { refreshed: false, monitoringAvailable: false }; }
  return { refreshed: true, monitoringAvailable };
}

/** Every report family, in sweep order. The route validates requested
 * `families` against this array rather than a copy. */
export const DATAFORSEO_REPORTS: readonly string[] = REPORTS.map(
  (report) => report.name,
);

/** Public, machine-readable cadence policy for routes, tests and operators. */
export const DATAFORSEO_REPORT_CADENCE_DAYS: Readonly<Record<string, number>> =
  Object.freeze(
    Object.fromEntries(
      REPORTS.map((report) => [report.name, report.cadenceDays]),
    ),
  );

/** The families applicable to this property: what the weekly lane considers
 * before its freshness check, and what an unfiltered scoped run forces. The
 * route asks this first, so a family the property has no config for is a 422,
 * not a $0.00 success. */
export function dataForSeoFamiliesFor(
  asset: string,
  panel: SerpPanelConfig = SERP_PANEL_CONFIG,
): string[] {
  // From the REPORTS registry, not the contract's `dataForSeoReportsFor`: the
  // contract says what a week owes (excluding the 28-day families); this says
  // what may be requested.
  return REPORTS.filter(
    (report) => report.appliesTo?.(asset, panel) ?? true,
  ).map((report) => report.name);
}

interface PlannedReport {
  target: DataForSeoTarget;
  report: ReportSpec;
}

interface SkippedFreshReport {
  asset: string;
  report: string;
  latestReportDate: string;
  nextDueDate: string;
}

interface DueDataForSeoPlan {
  due: PlannedReport[];
  skippedFresh: SkippedFreshReport[];
}

/** Every (property, family) this run owes, breadth first: all single-call
 * families for every property, then the long ones, so cheap evidence never
 * queues behind expensive evidence. The one list both the credential-missing
 * and collecting paths use; `families` only narrows it. */
function sweepPlan(
  targets: DataForSeoTarget[],
  panel: SerpPanelConfig,
  familiesFor: (asset: string) => readonly string[] | undefined,
): PlannedReport[] {
  const plan: PlannedReport[] = [];
  for (const long of [false, true]) {
    for (const target of targets) {
      for (const report of reportsFor(target.asset, panel, familiesFor(target.asset))) {
        if ((report.longRunning === true) === long) plan.push({ target, report });
      }
    }
  }
  return plan;
}

/** Filter an automated plan against the manifests themselves. Only `success`
 * and `unchanged` count; errors stay due, never-archived families are due
 * immediately, and a skip writes no attempt row. */
async function dueDataForSeoPlan(
  store: WorkspaceStore,
  fullPlan: PlannedReport[],
  reportDate: string,
): Promise<DueDataForSeoPlan> {
  if (fullPlan.length === 0) return { due: [], skippedFresh: [] };

  const rows = await store.read((tx) =>
    tx.query<{ asset: string; report: string; latestReportDate: string | null }>(
      `SELECT asset_id AS asset, report, max(report_date) AS "latestReportDate"
         FROM noticeos.archive_runs
        WHERE integration = 'dataforseo'
          AND status IN ('success','unchanged')
        GROUP BY asset_id, report`,
    ),
  );
  const latestByFamily = new Map(
    rows
      .filter(
        (row): row is typeof row & { latestReportDate: string } =>
          row.latestReportDate !== null,
      )
      .map((row) => [planKey(row.asset, row.report), row.latestReportDate]),
  );
  const due: PlannedReport[] = [];
  const skippedFresh: SkippedFreshReport[] = [];

  for (const item of fullPlan) {
    const latest = latestByFamily.get(
      planKey(item.target.asset, item.report.name),
    );
    if (
      latest === undefined ||
      wholeUtcDaysBetween(latest, reportDate) >= item.report.cadenceDays
    ) {
      due.push(item);
      continue;
    }
    skippedFresh.push({
      asset: item.target.asset,
      report: item.report.name,
      latestReportDate: latest,
      nextDueDate: reportDateOffset(latest, item.report.cadenceDays),
    });
  }
  return { due, skippedFresh };
}

function planKey(asset: string, report: string): string {
  return `${asset}\u0000${report}`;
}

/** The families this property owns, in declaration order. A family whose config
 * does not cover the property is not one of its reports at all, so it never
 * reaches the budget gate and writes no attempt row. `families` can only remove
 * from this set, so no request can bill a family the property does not own. */
function reportsFor(
  asset: string,
  panel: SerpPanelConfig,
  families?: readonly string[],
): ReportSpec[] {
  return REPORTS.filter(
    (report) =>
      (families === undefined || families.includes(report.name)) &&
      (report.appliesTo?.(asset, panel) ?? true),
  );
}

/** The collector's membership rule, asked two ways: no roster, a launched
 * non-OS property with a domain is collected. A scoped run binds the id, so it
 * can only reach a property the weekly lane would collect. */
const CANDIDATE_WHERE = `SELECT asset_id AS asset, domain
     FROM noticeos.assets
    WHERE NOT is_os
      AND status NOT IN ('pre-launch','retired')
      AND domain IS NOT NULL`;
const CANDIDATES_ALL = `${CANDIDATE_WHERE} ORDER BY ${SITE_ORDER}`;
const CANDIDATE_ONE = `${CANDIDATE_WHERE} AND asset_id = $1`;

export async function dataForSeoCandidates(
  store: WorkspaceStore,
  asset: string | null = null,
): Promise<PortfolioCandidate[]> {
  return store.read((tx) =>
    asset === null ? tx.query<{ asset: string; domain: string }>(CANDIDATES_ALL) : tx.query<{ asset: string; domain: string }>(CANDIDATE_ONE, [asset]),
  );
}

export function dataForSeoTarget(
  candidate: PortfolioCandidate,
  credentialRef: string = CREDENTIAL_REF,
  laneRegister?: LaneRegister,
): DataForSeoTarget {
  const scope = resolveDataForSeoScope(candidate.asset, laneRegister);
  return {
    asset: candidate.asset,
    integration: 'dataforseo',
    credentialRef,
    propertyRef: siteHost(candidate.domain) ?? candidate.domain,
    locationCode: scope.locationCode,
    languageCode: scope.languageCode,
    mappingSource: scope.source,
  };
}

async function collectReport(
  env: IngestEnv,
  target: DataForSeoTarget,
  spec: ReportSpec,
  reportDate: string,
  requestedAt: string,
  authorization: string,
  egress: EgressLane,
  panel: SerpPanelConfig,
  budget: RetryBudget,
  monitoring?: CollectionMonitoring,
): Promise<DataForSeoDumpOutcome> {
  const pages: DumpPage[] = [];
  let providerRows = 0;
  let rankedKeywordsTruncated = false;
  let carriedCostUsd = 0;
  let carriedAccountedUsd = 0;
  let failedRequests = 0;
  let failedAttempts = 0;
  let resumedRequests = 0;
  let lastTaskError: SignalError | null = null;
  let priceConfirmed = budget.fenceUnsettled;
  const temporaryCheckpoints = budget.fenceUnsettled && spec.independentRequests !== true;
  const resumeCheckpoints = temporaryCheckpoints || spec.independentRequests === true;
  const temporaryKeys: string[] = [];
  let needsPanelAllowance = budget.fenceUnsettled && spec.name === 'serp-panel';
  try {
    const objects = await signalObjectScope(env);
    // Built inside the boundary so a malformed panel is archived as this
    // property's `config_invalid` attempt rather than aborting the sweep.
    const requests = spec.requests(target, reportDate, panel);
    const priorAttempt = resumeCheckpoints
      ? await latestDataForSeoAttempt(env.STORE, target.asset, spec.name, reportDate)
      : null;
    // One report date has one coherent panel. Re-firing it is always a repair,
    // never permission to rebuy its successful query/device pages. A new report
    // date naturally has different keys and starts fresh.
    // With no manifest, a killed request's spend has nowhere else to be counted;
    // a prior error manifest already recorded what that attempt paid.
    const checkpointCostsUnaccounted = priorAttempt === null;
    for (const { body, label } of requests) {
      const checkpointKey = resumeCheckpoints
        ? await dataForSeoCheckpointKey(env, target, spec, reportDate, body, label)
        : null;
      const checkpoint = checkpointKey
        ? await readDataForSeoCheckpoint(env.RAW_SIGNALS, checkpointKey, {
            asset: target.asset,
            report: spec.name,
            reportDate,
          }, objects)
        : null;
      if (checkpoint && checkpoint.taskError === null) {
        pages.push(checkpoint.page);
        providerRows += checkpoint.providerRows;
        rankedKeywordsTruncated ||= checkpoint.rankedKeywordsTruncated === true;
        priceConfirmed &&= checkpoint.priceConfirmed === true;
        if (temporaryCheckpoints && checkpointKey) temporaryKeys.push(checkpointKey);
        if (checkpointCostsUnaccounted) {
          carriedCostUsd += checkpoint.costUsd;
          if (checkpoint.costAccounted) carriedAccountedUsd += checkpoint.costUsd;
        }
        resumedRequests += 1;
        continue;
      }

      // A cached repair needs no headroom. The panel allowance only applies
      // when at least one remaining request would go to the provider.
      if (needsPanelAllowance) {
        needsPanelAllowance = false;
        if (!await canReserveDataForSeo(budget.store, budget.requestClock(), MAX_REPORT_COST_USD, budget.monthlyCapUsd, true)) {
          throw dataForSeoBudgetExhausted(budget.monthlyCapUsd);
        }
      }
      const call = await callProvider(
        spec,
        body,
        target.asset,
        await dataForSeoRequestIdentity(target.asset, spec.name, reportDate, body),
        authorization,
        egress,
        budget,
      );
      const parsed = call.parsed;
      const page: DumpPage = {
        request: {
          path: spec.path,
          body,
          attempts: call.attempts,
          ...(label === undefined ? {} : { label }),
        },
        response: call.body,
      };
      providerRows += parsed.providerRows;
      rankedKeywordsTruncated ||= parsed.rankedKeywordsTruncated === true;
      if (checkpointKey && (spec.independentRequests === true || parsed.taskError === null)) {
        await writeDataForSeoCheckpoint(env.RAW_SIGNALS, checkpointKey, {
          schemaVersion: 1,
          asset: target.asset,
          report: spec.name,
          reportDate,
          requestHash: checkpointKey.slice(checkpointKey.lastIndexOf('/') + 1, -5),
          page,
          providerRows: parsed.providerRows,
          costUsd: call.costUsd,
          costAccounted: true,
          ...(budget.fenceUnsettled ? { priceConfirmed: true } : {}),
          ...(parsed.rankedKeywordsTruncated ? { rankedKeywordsTruncated: true } : {}),
          taskError: parsed.taskError
            ? { code: parsed.taskError.code, message: parsed.taskError.message }
            : null,
        }, objects);
        if (temporaryCheckpoints) temporaryKeys.push(checkpointKey);
      }
      // Archived verbatim either way: a task the provider could not answer is
      // evidence too, and it was billed.
      pages.push(page);
      if (parsed.taskError) {
        failedRequests += 1;
        // The retry allowance belongs to the family: count the attempts endured
        // across the partial panel, not the largest per-call value.
        failedAttempts += call.attempts;
        lastTaskError = parsed.taskError;
      }
    }
    if (resumedRequests > 0) {
      console.log(
        JSON.stringify({
          event: 'dataforseo_checkpoint_resumed',
          asset: target.asset,
          report: spec.name,
          reportDate,
          resumedRequests,
          expectedRequests: requests.length,
        }),
      );
    }
    if (lastTaskError && failedRequests === pages.length) {
      // A panel with no answered page is not review evidence. Its checkpoints
      // still retain every paid response, but no archive is promoted.
      throw lastTaskError;
    }
    const outcome = await archiveCollectedDump(env, {
      monitoring,
      provider: 'dataforseo',
      target,
      report: spec.name,
      reportDate,
      requestedAt,
      dataState: 'provider-snapshot',
      collected: {
        pages,
        providerRows,
        providerTruncated: rankedKeywordsTruncated || spec.name === 'serp-panel',
      },
      providerCostUsd: carriedCostUsd + budget.confirmedUsd,
      dataForSeoCostAccountedUsd: carriedAccountedUsd + budget.confirmedUsd,
      knownZeroCost: priceConfirmed && !budget.costUnconfirmed && carriedCostUsd + budget.confirmedUsd === 0 ? true : undefined,
    });
    // The committed manifest now points to the durable raw object.
    if (temporaryKeys.length) {
      try { await env.RAW_SIGNALS.delete(temporaryKeys); }
      catch { console.warn('dataforseo_checkpoint_cleanup_failed'); }
    }
    if (lastTaskError && failedRequests > 0) {
      // Partial panels are useful and reviewable, but never silently healthy.
      // The success row keeps the archive/read path intact; a zero-cost error
      // marker written immediately after it keeps integration health degraded.
      // Spend belongs to the archive row only, so the marker cannot double it.
      const observed = pages.length - failedRequests;
      const exhausted = failedAttempts >= 3;
      const taskCode = lastTaskError.code.replace(/^dataforseo_task_/, '');
      const partial = new SignalError(
        `dataforseo_partial_${taskCode}`,
        `${failedRequests} of ${pages.length} calls unanswered${exhausted ? ' after 3 attempts' : ''} · ` +
          `${observed} answered · DataForSEO: ${lastTaskError.message}`,
      );
      await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: spec.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error: partial,
        providerCostUsd: 0,
        knownZeroCost: true,
      });
      console.warn(
        JSON.stringify({
          event: 'dataforseo_partial_panel',
          asset: target.asset,
          reportDate,
          observedRequests: observed,
          failedRequests,
          failedAttempts,
          reviewable: true,
        }),
      );
    }
    return { ...outcome, costUsd: carriedCostUsd + budget.confirmedUsd, retries: budget.used };
  } catch (error) {
    const spent = carriedCostUsd + budget.confirmedUsd;
    const dataForSeoCostAccountedUsd = carriedAccountedUsd + budget.confirmedUsd;
    // The uplink, not DataForSEO: `callProvider` already asked the gate, so this
    // is the cached verdict. The family is unmeasured and still due.
    if (await egressExplains(egress.gate, egress.transport, error)) {
      if (spent <= 0) {
        return {
          ...unmeasuredDumpOutcome(egress.gate, target, spec.name, reportDate),
          costUsd: 0,
          retries: budget.used,
        };
      }
      // Pages paid for before the uplink went must reach the monthly meter,
      // which sums manifests. No monitoring context, so no Health observation
      // blames the provider. An error row never satisfies a cadence.
      const outcome = await archiveDumpFailure(env.STORE, {
        target,
        report: spec.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error: new SignalError(
          EGRESS_DOWN_CODE,
          `Offline, not DataForSEO · ${pages.length} paid call${pages.length === 1 ? '' : 's'} kept · ${spent.toFixed(4)} USD counted`,
        ),
        providerCostUsd: spent,
        dataForSeoCostAccountedUsd,
      });
      egress.gate.recordUnmeasured(target.asset, spec.name);
      return { ...outcome, egressDown: true, costUsd: spent, retries: budget.used };
    }
    const normalized = normalizeSignalError(
      error,
      `DataForSEO ${spec.name} request failed.`,
    );
    const outcome = await archiveDumpFailure(env.STORE, {
      monitoring,
      target,
      report: spec.name,
      reportDate,
      requestedAt,
      dataState: 'provider-snapshot',
      error: retriedFailure(normalized, budget.used),
      providerCostUsd: spent,
      dataForSeoCostAccountedUsd,
      knownZeroCost: spent === 0 && ['budget_exhausted', 'dataforseo_already_purchased'].includes(normalized.code) ? true : undefined,
    });
    return { ...outcome, costUsd: spent, retries: budget.used };
  }
}

type DataForSeoAttemptStatus = 'success' | 'unchanged' | 'error';

const CHECKPOINT_REPAIR_LIMIT = 12;
const CHECKPOINT_ORPHAN_RESERVE = CHECKPOINT_REPAIR_LIMIT / 2;
const CHECKPOINT_ORPHAN_LOOKBACK_DAYS = 7;
const CHECKPOINT_OBJECT_LIMIT = 512;
const CHECKPOINT_REPAIR_FAILED = 'dataforseo_checkpoint_incomplete';
const checkpointPrefix = (asset: string, reportDate: string) =>
  `${DATAFORSEO_CHECKPOINT_PREFIX}/${encodeURIComponent(asset)}/${reportDate}`;

function dataForSeoRequestIdentity(asset: string, report: DataForSeoReport, reportDate: string, body: Record<string, unknown>): Promise<string> {
  return sha256Hex(JSON.stringify([asset, report, reportDate, body]));
}

/** A failed archive identifies the original date even after prolonged downtime.
 * Recent paid receipts also let a restart find a write that never reached SQL. */
async function repairCandidates(env: IngestEnv, plan: PlannedReport[], today: string, objects: SignalObjectScope,
  signal?: AbortSignal): Promise<{ item: PlannedReport; date: string }[]> {
  const scope = JSON.stringify(plan.map(({ target, report }) => ({ asset: target.asset, property: target.propertyRef, report: report.name })));
  const candidates = await env.STORE.read(tx => tx.query<{ asset: string; report: string; date: string; failed: boolean }>(`
    WITH targets AS (SELECT * FROM jsonb_to_recordset($1::jsonb) t(asset text, property text, report text)),
    recorded AS (
      SELECT r.asset_id AS asset,r.report,r.report_date AS date,true AS failed,max(r.finished_at) AS last_repair
      FROM noticeos.archive_runs r JOIN targets t ON t.asset=r.asset_id AND t.report=r.report AND t.property=r.property_ref
      WHERE r.integration='dataforseo' AND r.report_date < $2::date AND r.status='error' AND r.error_code IN ($3,$4)
      GROUP BY r.asset_id,r.report,r.report_date
    ), paid_dates AS (
      SELECT DISTINCT asset_id AS asset, (reserved_at AT TIME ZONE 'UTC')::date AS date
      FROM noticeos.dataforseo_request_charges
      WHERE asset_id IN (SELECT asset FROM targets) AND provider_completed
        AND reserved_at >= $2::date - $5::int AND reserved_at < $2::date + 1
    ), possible AS (
      SELECT p.asset,t.report,p.date-d.days AS date,false AS failed,NULL::timestamptz AS last_repair
      FROM paid_dates p JOIN targets t USING(asset) CROSS JOIN (VALUES (0),(1)) d(days)
      WHERE p.date-d.days < $2::date
    )
    SELECT c.asset,c.report,c.date,bool_or(c.failed) AS failed
    FROM (SELECT * FROM recorded UNION ALL SELECT * FROM possible) c JOIN targets t USING(asset,report)
    WHERE NOT EXISTS (SELECT 1 FROM noticeos.archive_runs r
      WHERE r.integration='dataforseo' AND r.asset_id=c.asset AND r.property_ref=t.property AND r.report=c.report
        AND r.report_date=c.date AND r.status IN ('success','unchanged'))
    GROUP BY c.asset,c.report,c.date ORDER BY bool_or(c.failed) DESC, max(c.last_repair) ASC NULLS LAST, c.date, c.asset, c.report`,
  [scope, today, LOCAL_STORE_FAILED, CHECKPOINT_REPAIR_FAILED, CHECKPOINT_ORPHAN_LOOKBACK_DAYS]));
  const recorded: { item: PlannedReport; date: string }[] = [];
  const orphans: typeof recorded = [];
  const knownReports = new Map<string, Set<string>>();
  const selected = new Map(plan.map(item => [planKey(item.target.asset, item.report.name), item]));
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const item = selected.get(planKey(candidate.asset, candidate.report));
    if (!item) continue;
    if (candidate.failed) {
      if (recorded.length < CHECKPOINT_REPAIR_LIMIT) recorded.push({ item, date: candidate.date });
      continue;
    }
    const prefix = objects.key(checkpointPrefix(candidate.asset, candidate.date)) + '/';
    let reports = knownReports.get(prefix);
    if (!reports) {
      const found = await env.RAW_SIGNALS.list({ prefix, delimiter: '/', limit: CHECKPOINT_OBJECT_LIMIT });
      reports = new Set(found.delimitedPrefixes.map(key => key.slice(prefix.length, -1)));
      knownReports.set(prefix, reports);
    }
    if (!reports.has(candidate.report)) continue;
    orphans.push({ item, date: candidate.date });
    if (orphans.length >= Math.max(CHECKPOINT_ORPHAN_RESERVE, CHECKPOINT_REPAIR_LIMIT - recorded.length)) break;
  }
  // Recent charges expire from discovery. Give their saved responses time to leave a durable receipt.
  return [...orphans.slice(0, CHECKPOINT_ORPHAN_RESERVE), ...recorded, ...orphans.slice(CHECKPOINT_ORPHAN_RESERVE)]
    .slice(0, CHECKPOINT_REPAIR_LIMIT);
}

async function recoverDataForSeoCheckpoints(env: IngestEnv, plan: PlannedReport[], panel: SerpPanelConfig, requestedAt: string,
  signal?: AbortSignal): Promise<DataForSeoDumpOutcome[]> {
  const objects = await signalObjectScope(env);
  const candidates = await repairCandidates(env, plan, requestedAt.slice(0, 10), objects, signal);
  const recovered: DataForSeoDumpOutcome[] = [];
  for (const { item: { target, report }, date } of candidates) {
    signal?.throwIfAborted();
    const keys: string[] = [];
    const pages: DumpPage[] = [];
    let providerRows = 0, bytes = 0, truncated = report.name === 'serp-panel';
    try {
      const requests = report.requests(target, date, panel);
      for (const { body, label } of requests) {
        signal?.throwIfAborted();
        const key = await dataForSeoCheckpointKey(env, target, report, date, body, label);
        const saved = await confirmedDataForSeoCheckpoint(env, objects, key, target, report, date, body, label, ARCHIVE_BYTE_LIMIT - bytes);
        if (!saved) throw new SignalError(CHECKPOINT_REPAIR_FAILED, 'The original report cannot be reconstructed from confirmed saved responses.');
        const { checkpoint } = saved;
        bytes += saved.bytes;
        keys.push(key);
        pages.push(checkpoint.page);
        providerRows += checkpoint.providerRows;
        truncated ||= checkpoint.rankedKeywordsTruncated === true;
      }
      if (pages.length === 0) throw new SignalError(CHECKPOINT_REPAIR_FAILED, 'The original request is unavailable in the current report settings.');
      const outcome = await archiveCollectedDump(env, { provider: 'dataforseo', target, report: report.name, reportDate: date,
        requestedAt, dataState: 'provider-snapshot', collected: { pages, providerRows, providerTruncated: truncated }, knownZeroCost: true });
      if (!report.independentRequests && outcome.objectKey) {
        await removeRepairedCheckpoints(env, objects, outcome, keys);
      }
      recovered.push({ ...outcome, costUsd: 0, retries: 0 });
    } catch (error) {
      signal?.throwIfAborted();
      const outcome = await archiveDumpFailure(env.STORE, { target, report: report.name, reportDate: date, requestedAt,
        dataState: 'provider-snapshot', error: normalizeSignalError(error, 'The saved DataForSEO response could not be archived.'), knownZeroCost: true });
      recovered.push({ ...outcome, costUsd: 0, retries: 0 });
    }
  }
  if (recovered.length > 0) {
    console.log(JSON.stringify({ event: 'dataforseo_archive_recovery',
      reports: recovered.map(({ asset, report, reportDate, status, errorCode }) => ({ asset, report, reportDate, status, errorCode })) }));
  }
  return recovered;
}

async function removeRepairedCheckpoints(env: IngestEnv, objects: SignalObjectScope, outcome: SignalDumpOutcome,
  keys: string[]): Promise<void> {
  const { objectKey, asset, report, reportDate } = outcome;
  if (!objectKey || !objects.canReadArchive(objectKey)) return;
  try {
    const [archive] = await env.STORE.read(tx => tx.query<{ hash: string; bytes: bigint }>(`
      SELECT o.content_sha256 AS hash, o.object_bytes AS bytes
      FROM noticeos.archive_runs r JOIN noticeos.archive_objects o USING(workspace_id, object_seq)
      WHERE r.integration='dataforseo' AND r.asset_id=$1 AND r.report=$2 AND r.report_date=$3::date
        AND r.status IN ('success','unchanged') AND o.object_key=$4 LIMIT 1`,
    [asset, report, reportDate, objectKey]));
    if (!archive) return;
    const raw = await env.RAW_SIGNALS.head(objectKey);
    const meta = raw?.customMetadata;
    if (raw && BigInt(raw.size) === BigInt(archive.bytes) && meta?.contentSha256 === archive.hash
      && meta.workspaceId === objects.workspaceId && meta.asset === asset && meta.report === report && meta.reportDate === reportDate) {
      await env.RAW_SIGNALS.delete(keys);
    }
  } catch { console.warn('dataforseo_checkpoint_cleanup_failed'); }
}

async function confirmedDataForSeoCheckpoint(env: IngestEnv, objects: SignalObjectScope, key: string, target: DataForSeoTarget,
  report: ReportSpec, date: string, body: Record<string, unknown>, label: string | undefined,
  remainingBytes: number): Promise<{ checkpoint: DataForSeoRequestCheckpoint; bytes: number } | null> {
  if (!objects.owns(key)) return null;
  const saved = await env.RAW_SIGNALS.get(key).catch(() => {
    throw new SignalError(CHECKPOINT_REPAIR_FAILED, 'The saved DataForSEO response could not be read.');
  });
  const hash = key.slice(key.lastIndexOf('/') + 1, -5);
  const meta = saved?.customMetadata;
  if (!saved || saved.size > Math.min(remainingBytes, RESPONSE_BYTE_LIMIT + 32 * 1024) || meta?.workspaceId !== objects.workspaceId
    || meta.asset !== target.asset || meta.report !== report.name || meta.reportDate !== date
    || meta.requestHash !== hash || meta.schemaVersion !== '1') return null;
  let value: Partial<DataForSeoRequestCheckpoint>;
  try { value = JSON.parse(await saved.text()) as Partial<DataForSeoRequestCheckpoint>; }
  catch { return null; }
  if (!value || value.schemaVersion !== 1 || value.asset !== target.asset || value.report !== report.name || value.reportDate !== date
    || value.requestHash !== hash || value.costAccounted !== true || value.priceConfirmed !== true || value.taskError !== null
    || value.page?.request?.path !== report.path || value.page.request.label !== label
    || typeof value.page.request.attempts !== 'number' || !Number.isSafeInteger(value.page.request.attempts) || value.page.request.attempts < 1
    || JSON.stringify(value.page.request.body) !== JSON.stringify(body)
    || dataForSeoProviderStatus(value.page.response) !== 'completed') return null;
  const billed = billedDataForSeoCost(value.page.response);
  if (billed === null) return null;
  const parsed = parseProviderResponse(200, value.page.response, report.name, report.independentRequests === true);
  if (parsed.taskError || parsed.providerRows !== value.providerRows
    || Boolean(parsed.rankedKeywordsTruncated) !== Boolean(value.rankedKeywordsTruncated)) return null;
  const chargeKey = await customerDataForSeoRequestKey(await dataForSeoRequestIdentity(target.asset, report.name, date, body));
  const [charge] = await env.STORE.read(tx => tx.query<{ settled: number; unresolved: number; cost: string | null; billed: string | null }>(`
    SELECT count(*) FILTER (WHERE provider_completed)::int AS settled,
      count(*) FILTER (WHERE provider_cost_usd IS NULL)::int AS unresolved,
      sum(provider_cost_usd)::text AS cost, max(provider_cost_usd) FILTER (WHERE provider_completed)::text AS billed
    FROM noticeos.dataforseo_request_charges WHERE asset_id=$1 AND request_key=$2`, [target.asset, chargeKey]));
  if (charge?.settled !== 1 || charge.unresolved || charge.cost === null || charge.billed === null
    || Number(charge.billed) !== billed || Number(charge.cost) !== dataForSeoBillAmount(value.costUsd)) return null;
  return { checkpoint: value as DataForSeoRequestCheckpoint, bytes: saved.size };
}

async function latestDataForSeoAttempt(
  store: WorkspaceStore,
  asset: string,
  report: DataForSeoReport,
  reportDate: string,
): Promise<DataForSeoAttemptStatus | null> {
  const [row] = await store.read((tx) =>
    tx.query<{ status: DataForSeoAttemptStatus }>(
      `SELECT status
         FROM noticeos.archive_runs
        WHERE asset_id = $1 AND integration = 'dataforseo'
          AND report = $2 AND report_date = $3::date
        ORDER BY finished_at DESC, run_id COLLATE "C" DESC
        LIMIT 1`,
      [asset, report, reportDate],
    ),
  );
  return row?.status ?? null;
}

/** Stable per request body, so a changed term/device config fetches only its new
 * members while identical paid pages from an interrupted run remain reusable. */
export async function dataForSeoCheckpointKey(
  env: IngestEnv,
  target: DataForSeoTarget,
  spec: Pick<ReportSpec, 'name' | 'path'>,
  reportDate: string,
  body: Record<string, unknown>,
  label?: string,
): Promise<string> {
  const objects = await signalObjectScope(env);
  const identity = JSON.stringify({ path: spec.path, body, label: label ?? null });
  const hash = await sha256Hex(identity);
  return objects.key(`${checkpointPrefix(target.asset, reportDate)}/${spec.name}/${hash}.json`);
}

async function writeDataForSeoCheckpoint(
  bucket: R2Bucket,
  key: string,
  checkpoint: DataForSeoRequestCheckpoint,
  objects: SignalObjectScope,
): Promise<void> {
  if (!objects.owns(key)) throw new Error('Checkpoint owner is unavailable.');
  try {
    await bucket.put(key, JSON.stringify(checkpoint), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        asset: checkpoint.asset,
        report: checkpoint.report,
        reportDate: checkpoint.reportDate,
        requestHash: checkpoint.requestHash,
        schemaVersion: String(checkpoint.schemaVersion),
        workspaceId: objects.workspaceId,
      },
    });
  } catch (error) {
    throw localStoreError(error, 'dataforseo', checkpoint.report);
  }
}

async function readDataForSeoCheckpoint(
  bucket: R2Bucket,
  key: string,
  expected: Pick<DataForSeoRequestCheckpoint, 'asset' | 'report' | 'reportDate'>,
  objects: SignalObjectScope,
): Promise<DataForSeoRequestCheckpoint | null> {
  if (!objects.owns(key)) throw new Error('Checkpoint owner is unavailable.');
  let object = await bucket.get(key);
  if (!object) {
    const legacy = await objects.legacyCheckpoint(key);
    if (legacy !== null) object = await bucket.get(legacy);
  }
  if (!object) return null;
  try {
    const value = JSON.parse(await object.text()) as Partial<DataForSeoRequestCheckpoint>;
    if (
      value.schemaVersion !== 1 ||
      value.asset !== expected.asset ||
      value.report !== expected.report ||
      value.reportDate !== expected.reportDate ||
      !value.page ||
      typeof value.page !== 'object' ||
      !Number.isFinite(value.providerRows) ||
      !Number.isFinite(value.costUsd) ||
      value.taskError === undefined
    ) {
      throw new Error('checkpoint shape does not match its key');
    }
    return value as DataForSeoRequestCheckpoint;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'dataforseo_checkpoint_ignored',
        key,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** The stored reason plus what the run already did about it; silent when
 * nothing was retried. */
function retriedFailure(error: SignalError, retries: number): SignalError {
  if (retries < 1) return error;
  return new SignalError(
    error.code,
    `${error.message} Gave up after ${retries + 1} attempts.`,
  );
}

function dataForSeoBudgetExhausted(capUsd: number): SignalError {
  return new SignalError('budget_exhausted', `DataForSEO paused before the portfolio ${capUsd.toFixed(2)} USD monthly data cap.`);
}

/** One provider call, repeated while the failure is about the call rather than
 * what we asked for. `budget` is shared by every request in the family, so the
 * ceiling is per family. Once the budget is gone a transient response is
 * interpreted as the final response. */
async function callProvider(
  spec: ReportSpec,
  /** The planned request's body only; the envelope's other fields are not the
   * provider's business. */
  requestBody: Record<string, unknown>,
  asset: string,
  requestKey: string,
  authorization: string,
  egress: EgressLane,
  budget: RetryBudget,
): Promise<{ body: unknown; parsed: ParsedProviderResponse; attempts: number; costUsd: number }> {
  const reserveUsd = spec.name === 'serp-panel' ? SERP_PANEL_CALL_USD : MAX_REPORT_COST_USD;
  let costUsd = 0;
  let attempts = 0;
  for (;;) {
    budget.signal?.throwIfAborted();
    const reservation = await reserveDataForSeo(budget.store, { asset, requestKey, reserveUsd, capUsd: budget.monthlyCapUsd,
      requestClock: budget.requestClock, fenceUnsettled: budget.fenceUnsettled, requireSavedCap: budget.fenceUnsettled,
      approvedCredential: budget.approvedCredential });
    if (reservation.kind !== 'reserved') {
      if (reservation.kind === 'budget_exhausted') throw dataForSeoBudgetExhausted(budget.monthlyCapUsd);
      if (reservation.kind === 'dataforseo_uncertain') budget.costUnconfirmed = true;
      const message = reservation.kind === 'dataforseo_uncertain' ? 'DataForSEO may have already billed this request.'
        : reservation.kind === 'dataforseo_already_purchased' ? 'DataForSEO already returned a paid result for this request.'
          : 'Review the stored DataForSEO connection and renew its paid scheduling approval.';
      throw new SignalError(reservation.kind, message);
    }
    try {
      await budget.authorizePurchase?.();
      budget.signal?.throwIfAborted();
    } catch (error) {
      await settleDataForSeo(budget.store, reservation.attemptId, 0);
      throw error;
    }
    // A reservation committed at midnight can cross the month before any I/O.
    if (meteredSpendSince(new Date(reservation.reservedAtMs)) !== meteredSpendSince(new Date(budget.requestClock()))) {
      await settleDataForSeo(budget.store, reservation.attemptId, 0);
      continue;
    }
    attempts += 1;
    budget.keepLane();
    let answer: { status: number; body: unknown; askedForMs: number | null };
    try {
      const response = await egress.transport.fetch(`${API_BASE}${spec.path}`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify([requestBody]),
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(dataForSeoPaidTimeoutMs(spec.path)), ...(budget.signal ? [budget.signal] : [])]),
      });
      // Read before the body, because a 429 that is about to be dropped for
      // being too far away still has to say how far away it was.
      const askedForMs = retryAfterWaitMs(
        response.status === 429 ? response.headers.get('retry-after') : null,
        Date.now(),
      );
      answer = { status: response.status, body: await boundedResponseJson(response, 'DataForSEO', RESPONSE_BYTE_LIMIT), askedForMs };
    } catch (error) {
      budget.costUnconfirmed = true;
      // Ask the gate before spending a retry: on a dead uplink a second call
      // hits the same wall, and the family must stay due.
      const delayMs =
        !budget.fenceUnsettled && !budget.signal?.aborted && isTransientTransport(error)
          && !(await egressExplains(egress.gate, egress.transport, error))
          ? await nextRetryDelay(budget, reserveUsd)
          : null;
      if (delayMs === null) {
        Object.assign(error as object, { attempts });
        throw error;
      }
      budget.used += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    let parsed: ParsedProviderResponse | SignalError;
    try { parsed = parseProviderResponse(answer.status, answer.body, spec.name, spec.independentRequests === true); }
    catch (error) { parsed = normalizeSignalError(error, `DataForSEO ${spec.name} request failed.`); }
    const providerStatus = dataForSeoProviderStatus(answer.body);
    const billed = billedDataForSeoCost(answer.body);
    if (billed !== null && providerStatus !== 'ambiguous') {
      await settleDataForSeo(budget.store, reservation.attemptId, billed, providerStatus === 'completed');
      costUsd += billed;
      budget.confirmedUsd += billed;
    } else {
      budget.costUnconfirmed = true;
      if (budget.fenceUnsettled) {
        throw new SignalError('dataforseo_uncertain', providerStatus === 'ambiguous'
          ? 'DataForSEO did not confirm whether this request completed.'
          : 'DataForSEO did not confirm this request’s cost.');
      }
    }
    const delayMs = providerStatus !== 'completed' && isTransientResponse(answer.status, answer.body)
      ? await nextRetryDelay(budget, reserveUsd, answer.askedForMs) : null;
    if (delayMs === null) {
      if (parsed instanceof SignalError) throw parsed;
      return { body: answer.body, parsed, attempts, costUsd };
    }
    budget.used += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function providerErrorCode(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 40000 && value < 60000;
}

/** One live POST submits one task. Provider status establishes whether it
 * completed, even when its result cannot be used locally. */
function dataForSeoProviderStatus(value: unknown): 'completed' | 'failed' | 'ambiguous' {
  const body = asRecord(value);
  const tasks = arrayField(body, 'tasks');
  if (tasks.length > 1 || (body?.tasks != null && !Array.isArray(body.tasks))) return 'ambiguous';
  const task = asRecord(tasks[0]);
  const envelopeStatus = body?.status_code;
  const taskStatus = task?.status_code;
  if (envelopeStatus === 20000 && taskStatus === 20000) return 'completed';
  const failedTask = providerErrorCode(taskStatus) && (task?.result == null || (Array.isArray(task.result) && task.result.length === 0));
  if ((providerErrorCode(envelopeStatus) && tasks.length === 0)
    || (failedTask && (envelopeStatus === 20000 || providerErrorCode(envelopeStatus)))) return 'failed';
  return 'ambiguous';
}

function billedDataForSeoCost(value: unknown): number | null {
  const body = asRecord(value);
  if (!Number.isInteger(body?.status_code)) return null;
  const total = body?.cost;
  const task = asRecord(arrayField(body, 'tasks')[0])?.cost;
  if (total == null) return dataForSeoBillAmount(task);
  const amount = dataForSeoBillAmount(total);
  return task == null || dataForSeoBillAmount(task) === amount ? amount : null;
}

function dataForSeoBillAmount(raw: unknown): number | null {
  if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim())) return null;
  const amount = finiteNumber(raw);
  if (amount === null) return null;
  const bill = Number(amount.toFixed(6));
  return bill < 100_000_000 && (amount === 0 || bill > 0) ? bill : null;
}

/** The retry allowance for ONE report family, spent across all its requests. */
interface RetryBudget {
  readonly store: WorkspaceStore;
  /** The wait before each retry, in order; its length is the ceiling. */
  readonly backoffMs: number[];
  readonly monthlyCapUsd: number;
  readonly requestClock: () => number;
  readonly signal?: AbortSignal;
  readonly fenceUnsettled: boolean;
  readonly approvedCredential?: DataForSeoConnectionPin;
  readonly authorizePurchase?: () => Promise<void>;
  /** Called as each provider call starts, so a working run keeps the lane. */
  readonly keepLane: () => void;
  confirmedUsd: number;
  costUnconfirmed: boolean;
  /** Retries already spent by this family. */
  used: number;
}

/** The wait before the next retry, or null when there must not be one. Each
 * retry checks just that call's reserve. Earlier attempts are in live spend.
 * `askedForMs` (a 429's `Retry-After`) outranks the ladder up to
 * `RETRY_AFTER_CAP_MS`, past which there is no retry; the ladder stays the
 * floor so `Retry-After: 0` cannot become a hot loop. */
async function nextRetryDelay(
  budget: RetryBudget,
  reserveUsd: number,
  askedForMs: number | null = null,
): Promise<number | null> {
  if (budget.used >= budget.backoffMs.length) return null;
  if (!await canReserveDataForSeo(budget.store, budget.requestClock(), reserveUsd, budget.monthlyCapUsd, budget.fenceUnsettled)) return null;
  const ladderMs = budget.backoffMs[budget.used]!;
  if (askedForMs === null) return ladderMs;
  if (askedForMs > RETRY_AFTER_CAP_MS) return null;
  return Math.max(ladderMs, askedForMs);
}

/** The provider's `Retry-After` in milliseconds, or null when absent or
 * unreadable: an unreadable hint must not cancel a retry the ladder would have
 * made. A date in the past is a wait of zero. */
export function retryAfterWaitMs(
  header: string | null,
  nowMs: number,
): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/** A failure about the call, which a second call may not have: HTTP 5xx, the
 * provider's 5xxxx envelope codes, its 40101/40103 task codes (internal
 * search-engine error; resubmit) and 429. Every other 4xx is about what we
 * asked for and would fail identically again. */
function isTransientResponse(status: number, body: unknown): boolean {
  if (status >= 500 || status === 429) return true;
  if (status < 200 || status >= 300) return false;
  const root = asRecord(body);
  const envelope = finiteNumber(root?.status_code);
  if (envelope !== null && envelope >= 50000 && envelope < 60000) return true;
  const taskStatus = finiteNumber(asRecord(arrayField(root, 'tasks')[0])?.status_code);
  return taskStatus === 40101 || taskStatus === 40103;
}

/** A call that produced no response at all: a dropped connection or our own
 * timeout. A SignalError here is `response_too_large` or
 * `response_invalid_json` — facts about what DID come back, which repeating
 * cannot change. */
function isTransientTransport(error: unknown): boolean {
  return !(error instanceof SignalError) && error instanceof Error;
}

interface ParsedProviderResponse {
  providerRows: number;
  rankedKeywordsTruncated?: boolean;
  /** Set instead of thrown when the caller retains independent requests. */
  taskError: SignalError | null;
}

/**
 * Transport and root-status problems always throw — the call itself is broken.
 * A task the provider accepted but could not answer is a fact about one request:
 * `retainTaskFailure` returns it so a multi-request family keeps the responses
 * it did get, and the caller decides whether losing all of them is an error.
 */
function parseProviderResponse(
  httpStatus: number,
  body: unknown,
  report: string,
  retainTaskFailure = false,
): ParsedProviderResponse {
  const root = asRecord(body);
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new SignalError(
      `dataforseo_http_${httpStatus}`,
      providerFailureMessage(
        root,
        `DataForSEO ${report} returned HTTP ${httpStatus}.`,
      ),
    );
  }
  const statusCode = finiteNumber(root?.status_code);
  if (statusCode !== 20000) {
    throw new SignalError(
      `dataforseo_${statusCode ?? 'invalid_response'}`,
      providerFailureMessage(
        root,
        `DataForSEO ${report} returned an unsuccessful response.`,
      ),
    );
  }
  const task = asRecord(arrayField(root, 'tasks')[0]);
  const taskStatus = finiteNumber(task?.status_code);
  const failed = (error: SignalError): ParsedProviderResponse => {
    if (!retainTaskFailure) throw error;
    return { providerRows: 0, taskError: error };
  };
  if (taskStatus !== 20000) {
    return failed(
      new SignalError(
        `dataforseo_task_${taskStatus ?? 'invalid_response'}`,
        failureText(stringField(task, 'status_message')) ??
          `DataForSEO ${report} returned no successful task.`,
      ),
    );
  }
  const results = arrayField(task, 'result');
  const result = asRecord(results[0]);
  if (!result) {
    // The provider accepted the task, billed it, and reported that it holds
    // nothing for this target: an answer, not a broken response. Archived as a
    // zero-row collection so the verbatim body is stored.
    if (providerAnsweredEmpty(task, results)) {
      return {
        providerRows: 0,
        taskError: null,
      };
    }
    // Anything else is a response we could not read; the row is all a later
    // reader will have.
    return failed(
      new SignalError(
        'dataforseo_invalid_response',
        `DataForSEO ${report} returned a task with no readable result ` +
          `(result_count ${finiteNumber(task?.result_count) ?? 'absent'}, ` +
          `result items ${results.length}).`,
      ),
    );
  }
  const declaredItems = finiteNumber(result.items_count);
  const nestedItems = arrayField(result, 'items').length;
  if (report === 'ranked-keywords') {
    const total = result.total_count;
    const validTotal = total === undefined
      || (typeof total === 'number' && Number.isSafeInteger(total) && nestedItems === Math.min(total, RANKED_KEYWORD_LIMIT));
    const validItems = Array.isArray(result.items) || (result.items === null && result.items_count === 0);
    if (!validItems || result.items_count !== nestedItems || nestedItems > RANKED_KEYWORD_LIMIT || !validTotal) {
      return failed(new SignalError('dataforseo_invalid_response', 'DataForSEO ranked-keyword counts disagree with the returned rows.'));
    }
    return {
      providerRows: nestedItems,
      taskError: null,
      rankedKeywordsTruncated: typeof total === 'number' ? total > nestedItems : nestedItems === RANKED_KEYWORD_LIMIT,
    };
  }
  return {
    providerRows: Math.max(1, declaredItems ?? nestedItems),
    taskError: null,
  };
}

/** Empty means the `result` array is empty and the task's `result_count`
 * agrees or is absent. A response that contradicts itself stays a failure:
 * storing it as empty would turn "could not read" into "nothing". */
function providerAnsweredEmpty(
  task: Record<string, unknown> | null,
  results: unknown[],
): boolean {
  if (results.length !== 0) return false;
  const declared = finiteNumber(task?.result_count);
  return declared === null || declared === 0;
}

/** The provider's words for a part that WORKED, said at every level that
 * succeeded, so none can be a failure's reason. Compared without trailing
 * punctuation or case. */
const PROVIDER_SUCCESS_PHRASES = new Set([
  'ok',
  'success',
  'successful',
  'task created',
  'task handed',
]);

/** A provider message only if it can be a failure's reason; otherwise null so
 * the caller states the failure in its own words. */
function failureText(message: string | null): string | null {
  if (message === null) return null;
  const normalized = message.trim().replace(/[.!]+$/, '').toLowerCase();
  return PROVIDER_SUCCESS_PHRASES.has(normalized) ? null : message;
}

/** The message from the part that actually failed: the envelope's only when
 * the envelope failed, else the first failing task's, else the fallback. A
 * 20000 "Ok." envelope routinely wraps a failed task. */
function providerFailureMessage(
  root: Record<string, unknown> | null,
  fallback: string,
): string {
  if (finiteNumber(root?.status_code) !== 20000) {
    const envelope = failureText(stringField(root, 'status_message'));
    if (envelope) return envelope;
  }
  for (const entry of arrayField(root, 'tasks')) {
    const task = asRecord(entry);
    if (finiteNumber(task?.status_code) === 20000) continue;
    const message = failureText(stringField(task, 'status_message'));
    if (message) return message;
  }
  return fallback;
}

function basicAuthorization(login: string, password: string): string {
  const bytes = new TextEncoder().encode(`${login}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function dumpResult(outcomes: DataForSeoDumpOutcome[], egress?: EgressRunOutcome): DataForSeoDumpsResult {
  return {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    unchanged: outcomes.filter((outcome) => outcome.status === 'unchanged').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    costUsd: outcomes.reduce((sum, outcome) => sum + outcome.costUsd, 0),
    outcomes,
    ...(egress ? { egress } : {}),
  };
}

function finish(
  outcomes: DataForSeoDumpOutcome[],
  scope: DataForSeoCollectScope | null = null,
  skippedFresh: SkippedFreshReport[] = [],
  configSources?: ConfigSourceMap,
  creditRefreshed = false,
  egress?: EgressRunOutcome,
  recovery = false,
): DataForSeoDumpsResult {
  const result = dumpResult(outcomes, egress);
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  console.log(
    JSON.stringify({
      event: 'dataforseo_dumps_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      costUsd: Number(result.costUsd.toFixed(6)),
      // Per file: `store` when the run read the document an operator saved,
      // `file` when it read the compiled copy. Never a tracked query itself.
      ...configSourceLine(configSources, [
        'config/integrations.json',
        'config/serp-panel.json',
      ]),
      skippedFresh,
      // The word and never the figure: a balance does not belong in a log file.
      accountCredit: creditRefreshed ? 'refreshed' : 'not refreshed',
      // DataForSEO's failures only: a family the dead uplink swallowed is
      // counted in `failed` and `unmeasured`, never listed as the provider's.
      errors: measured
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, report, errorCode }) => ({ asset, report, errorCode })),
      unmeasured: outcomes.length - measured.length,
      // Landed on retry is a fact the manifest row cannot show.
      retried: outcomes
        .filter((outcome) => outcome.retries > 0)
        .map(({ asset, report, status, retries }) => ({
          asset,
          report,
          status,
          retries,
        })),
      // Present only on an on-demand run; the $0.07 and $1.60 lines must not look alike.
      ...(scope ? { scope: { asset: scope.asset, families: scope.families ?? null } } : {}),
      ...(recovery ? { recovery: true } : {}),
    }),
  );
  return result;
}
