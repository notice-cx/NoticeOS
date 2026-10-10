import { beginCollection, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
import { signalObjectScope, type SignalObjectScope } from './signal-objects.js';
import { observeIntegration, tryHealthConnection, type HealthConnection } from './integration-health-context.js';
// DataForSEO search-intelligence collector. The weekly cron and
// `POST /api/signal-collect` share one function; a scope only narrows the sweep
// plan, so every run lands the same manifest row, archive and cost.

import {
  archiveCollectedDump,
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
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT,
  dataForSeoReportsFor,
  loadMeteredDataSpend,
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
import constants from '../../../config/constants.json';
import serpPanelConfigJson from '../../../config/serp-panel.json';
import { isolateState } from './isolate-state.js';
import { arrayField, asRecord, sha256Hex, stringField, wholeUtcDaysBetween } from './shared.js';

const API_BASE = 'https://api.dataforseo.com/v3';
const CREDENTIAL_REF = 'DATAFORSEO_LOGIN+DATAFORSEO_PASSWORD';
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 130_000;
/** Not `REQUEST_TIMEOUT_MS`: a courtesy read must never hold a finished sweep open. */
const ACCOUNT_TIMEOUT_MS = 10_000;
const RANKED_KEYWORD_LIMIT = 200;
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
const DATA_MONTHLY_CAP_USD = constants.monthly_caps.data_usd;
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
/** How long one run may hold the lane without returning: several times the
 * longest real sweep, and the longest a dead run can lock the operator out. */
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

/** One paid independent request, durable before the next one starts. These
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

// The collector lane: one DataForSEO run at a time. The cap gate reads
// month-to-date spend once per run, so two concurrent runs would each pay for
// every call. A module-scope marker is the lock because every trigger runs in
// this one isolate; it is not a distributed lock. It cannot wedge shut: the
// holder's `finally`, a restarted runtime and the lease each free it.

/** The run that already holds the lane, as the trigger it refused reports it. */
export interface DataForSeoRunInFlight {
  /** When the holding run started, on the clock its start line was written on. */
  startedAt: string;
  /** Whole seconds. */
  runningSeconds: number;
  /** The holder's scope, or null when the weekly portfolio sweep holds the lane. */
  scope: DataForSeoCollectScope | null;
  /** When the lane frees itself even if the holder never returns. */
  leaseExpiresAt: string;
}

interface CollectorLane {
  /** Rising within this isolate, and the release token: a run whose lease expired
   * and was taken over must not free the lane its successor now holds. */
  readonly token: number;
  readonly startedAtMs: number;
  readonly scope: DataForSeoCollectScope | null;
}

let lane: CollectorLane | null = null;
let laneTokens = 0;
// Forgetting frees the lane but keeps the tokens rising, so a run still going
// from before cannot free the lane of a run started after it.
isolateState('DataForSEO collector lane', { forget: () => { lane = null; }, held: () => lane !== null });

type LaneClaim =
  | { token: number; blockedBy: null }
  | { token: null; blockedBy: DataForSeoRunInFlight };

/** Take the lane, or report who has it. Synchronous so two triggers in one tick see each other. */
function claimLane(nowMs: number, scope: DataForSeoCollectScope | null): LaneClaim {
  const held = lane;
  if (held !== null && nowMs < held.startedAtMs + LANE_LEASE_MS) {
    return { token: null, blockedBy: laneHolder(held, nowMs) };
  }
  const token = (laneTokens += 1);
  lane = { token, startedAtMs: nowMs, scope };
  return { token, blockedBy: null };
}

function releaseLane(token: number): void {
  if (lane?.token === token) lane = null;
}

function laneHolder(held: CollectorLane, nowMs: number): DataForSeoRunInFlight {
  return {
    startedAt: new Date(held.startedAtMs).toISOString(),
    runningSeconds: Math.max(0, Math.round((nowMs - held.startedAtMs) / 1000)),
    scope: held.scope,
    leaseExpiresAt: new Date(held.startedAtMs + LANE_LEASE_MS).toISOString(),
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
    path: '/dataforseo_labs/google/ranked_keywords/live',
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
    path: '/backlinks/summary/live',
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
    path: '/backlinks/timeseries_new_lost_summary/live',
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
    path: '/backlinks/referring_domains/live',
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
    path: '/backlinks/anchors/live',
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
    path: '/dataforseo_labs/google/keyword_ideas/live',
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
    path: '/dataforseo_labs/google/competitors_domain/live',
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
    path: '/serp/google/organic/live/advanced',
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
    path: '/ai_optimization/llm_mentions/target_metrics/live',
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
  if (owed === null) {
    return { attempted: 0, succeeded: 0, unchanged: 0, failed: 0, costUsd: 0, outcomes: [] };
  }
  return await runCollector(env, { ...options, scope: null }, owed);
}

async function runCollector(
  env: IngestEnv,
  options: DataForSeoDumpsOptions,
  owed: EgressLaneRecord | null,
): Promise<DataForSeoDumpsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const claim = claimLane(nowMs, options.scope ?? null);
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
  try {
    return await collectDueReports(env, options, nowMs, owed);
  } finally {
    releaseLane(claim.token);
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
): Promise<DataForSeoDumpsResult> {
  const recovery = owed !== null;
  const requestedAt = new Date(nowMs).toISOString();
  const reportDate = requestedAt.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  // A caller that handed us a login is a test, so the source is `env` by definition.
  const resolved = await resolveCredential(env, 'dataforseo');
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
  const monthlyCapUsd = options.monthlyCapUsd ?? DATA_MONTHLY_CAP_USD;
  const panel = options.serpPanelConfig ?? SERP_PANEL_CONFIG;
  const retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const scope = options.scope ?? null;
  // A property its Data sources row declines is neither asked for nor billed:
  // filtered before the plan, so it reserves nothing and writes no attempt row.
  const candidates = (await dataForSeoCandidates(env.STORE, scope?.asset ?? null))
    .filter((candidate) => !laneDeclined(candidate.asset, 'dataforseo', options.laneRegister));
  const targets = candidates.map((candidate) =>
    dataForSeoTarget(
      candidate,
      sourcedCredentialRef(CREDENTIAL_REF, credentialSource),
      options.laneRegister,
    ),
  );
  const sweep = sweepPlan(targets, panel, scope?.families);
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
  const egressCoverage =
    scope === null
      ? {}
      : {
          covers: (asset: string, family: string | null) =>
            asset === scope.asset &&
            (scope.families === undefined || (family !== null && scope.families.includes(family))),
        };

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
    return { ...finish(outcomes, scope, skippedFresh, options.configSources, false, egressOutcome, recovery), ...collectionMonitoring(monitoring) };
  }

  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) {
    throw new SignalError(
      'config_invalid',
      'DataForSEO monthly data cap must be greater than zero.',
    );
  }
  const authorization = basicAuthorization(login, password);
  const outcomes: DataForSeoDumpOutcome[] = [];
  // Both places the portfolio spends this account, through the one sum the
  // desk's meters read.
  const { spentUsd } = await loadMeteredDataSpend(env.STORE, requestedAt, 'month');
  let monthSpendUsd = spentUsd;
  for (const { target, report } of plan) {
    if (monthSpendUsd + MAX_REPORT_COST_USD > monthlyCapUsd) {
      const outcome = await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: report.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error: new SignalError(
          'budget_exhausted',
          `DataForSEO paused before the portfolio ${monthlyCapUsd.toFixed(2)} USD monthly data cap.`,
        ),
        knownZeroCost: true,
      });
      outcomes.push({ ...outcome, costUsd: 0, retries: 0 });
      continue;
    }
    const outcome = await collectReport(
      env,
      target,
      report,
      reportDate,
      requestedAt,
      authorization,
      egress,
      panel,
      { backoffMs: retryBackoffMs, monthSpendUsd, monthlyCapUsd, used: 0 },
      monitoring,
    );
    outcomes.push(outcome);
    monthSpendUsd += outcome.costUsd;
  }
  // One `os-egress-down` fact for the sweep — or the retraction of one an
  // earlier run left open.
  const egressOutcome = await egress.gate.finalize(egressCoverage);
  // One stamp per sweep on the credential. A family the dead uplink swallowed
  // says nothing about the login, so a sweep made only of those stamps nothing.
  const sweepWorked = outcomes.some((outcome) => outcome.status !== 'error');
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
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
  return { ...finish(outcomes, scope, skippedFresh, options.configSources, creditRefreshed.refreshed, egressOutcome, recovery), ...collectionMonitoring(monitoring), ...(!creditRefreshed.monitoringAvailable ? { monitoringAvailable: false } : {}) };
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
  families?: readonly string[],
): PlannedReport[] {
  const plan: PlannedReport[] = [];
  for (const long of [false, true]) {
    for (const target of targets) {
      for (const report of reportsFor(target.asset, panel, families)) {
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
    propertyRef: normalizeDomain(candidate.domain),
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
  let costUsd = 0;
  let failedRequests = 0;
  let failedAttempts = 0;
  let resumedRequests = 0;
  let lastTaskError: SignalError | null = null;
  try {
    const objects = await signalObjectScope(env);
    // Built inside the boundary so a malformed panel is archived as this
    // property's `config_invalid` attempt rather than aborting the sweep.
    const requests = spec.requests(target, reportDate, panel);
    const priorAttempt = spec.independentRequests
      ? await latestDataForSeoAttempt(env.STORE, target.asset, spec.name, reportDate)
      : null;
    // One report date has one coherent panel. Re-firing it is always a repair,
    // never permission to rebuy its successful query/device pages. A new report
    // date naturally has different keys and starts fresh.
    const resumeCheckpoints = spec.independentRequests === true;
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
        if (checkpointCostsUnaccounted) costUsd += checkpoint.costUsd;
        resumedRequests += 1;
        continue;
      }

      const call = await callProvider(
        spec,
        body,
        authorization,
        egress,
        budget,
      );
      const parsed = parseProviderResponse(
        call.status,
        call.body,
        spec.name,
        spec.independentRequests === true,
      );
      const page: DumpPage = {
        request: {
          path: spec.path,
          body,
          attempts: call.attempts,
          ...(label === undefined ? {} : { label }),
        },
        response: call.body,
      };
      // Count the provider's bill before the checkpoint write: if durable
      // persistence itself fails, the error manifest still records what we paid.
      costUsd += parsed.costUsd;
      providerRows += parsed.providerRows;
      if (spec.independentRequests === true) {
        const key =
          checkpointKey ??
          (await dataForSeoCheckpointKey(env, target, spec, reportDate, body, label));
        await writeDataForSeoCheckpoint(env.RAW_SIGNALS, key, {
          schemaVersion: 1,
          asset: target.asset,
          report: spec.name,
          reportDate,
          requestHash: key.slice(key.lastIndexOf('/') + 1, -5),
          page,
          providerRows: parsed.providerRows,
          costUsd: parsed.costUsd,
          taskError: parsed.taskError
            ? { code: parsed.taskError.code, message: parsed.taskError.message }
            : null,
        }, objects);
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
      Object.assign(lastTaskError, { costUsd });
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
        providerTruncated: providerTruncated(spec, providerRows),
      },
      providerCostUsd: costUsd,
    });
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
    return { ...outcome, costUsd, retries: budget.used };
  } catch (error) {
    // Requests already billed before the failure still count against the cap.
    const spent = Math.max(costUsd, providerCost(error));
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
    });
    return { ...outcome, costUsd: spent, retries: budget.used };
  }
}

type DataForSeoAttemptStatus = 'success' | 'unchanged' | 'error';

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
  return objects.key([
    DATAFORSEO_CHECKPOINT_PREFIX,
    encodeURIComponent(target.asset),
    reportDate,
    spec.name,
    `${hash}.json`,
  ].join('/'));
}

async function writeDataForSeoCheckpoint(
  bucket: R2Bucket,
  key: string,
  checkpoint: DataForSeoRequestCheckpoint,
  objects: SignalObjectScope,
): Promise<void> {
  if (!objects.owns(key)) throw new Error('Checkpoint owner is unavailable.');
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
  const disclosed = new SignalError(
    error.code,
    `${error.message} Gave up after ${retries + 1} attempts.`,
  );
  Object.assign(disclosed, { costUsd: providerCost(error) });
  return disclosed;
}

/** One provider call, repeated while the failure is about the call rather than
 * what we asked for. `budget` is shared by every request in the family, so the
 * ceiling is per family. Once the budget is gone a transient response is
 * returned rather than thrown; `parseProviderResponse` turns it into the right
 * error. */
async function callProvider(
  spec: ReportSpec,
  /** The planned request's body only; the envelope's other fields are not the
   * provider's business. */
  requestBody: Record<string, unknown>,
  authorization: string,
  egress: EgressLane,
  budget: RetryBudget,
): Promise<{ status: number; body: unknown; attempts: number }> {
  for (let attempts = 1; ; attempts += 1) {
    let delayMs: number | null = null;
    try {
      const response = await egress.transport.fetch(`${API_BASE}${spec.path}`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify([requestBody]),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Read before the body, because a 429 that is about to be dropped for
      // being too far away still has to say how far away it was.
      const askedForMs = retryAfterWaitMs(
        response.status === 429 ? response.headers.get('retry-after') : null,
        Date.now(),
      );
      const body = await boundedResponseJson(response, 'DataForSEO', RESPONSE_BYTE_LIMIT);
      if (!isTransientResponse(response.status, body)) {
        return { status: response.status, body, attempts };
      }
      delayMs = nextRetryDelay(budget, askedForMs);
      if (delayMs === null) return { status: response.status, body, attempts };
    } catch (error) {
      // Ask the gate before spending a retry: on a dead uplink a second call
      // hits the same wall, and the family must stay due.
      delayMs =
        isTransientTransport(error) && !(await egressExplains(egress.gate, egress.transport, error))
          ? nextRetryDelay(budget)
          : null;
      if (delayMs === null) {
        Object.assign(error as object, { attempts });
        throw error;
      }
    }
    budget.used += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** The retry allowance for ONE report family, spent across all its requests. */
interface RetryBudget {
  /** The wait before each retry, in order; its length is the ceiling. */
  readonly backoffMs: number[];
  /** Month-to-date metered spend as the family's budget gate saw it. */
  readonly monthSpendUsd: number;
  readonly monthlyCapUsd: number;
  /** Retries already spent by this family. */
  used: number;
}

/** The wait before the next retry, or null when there must not be one. A retry
 * reserves its own report's worth of the cap, so it may never be the call that
 * crosses it. `askedForMs` (a 429's `Retry-After`) outranks the ladder up to
 * `RETRY_AFTER_CAP_MS`, past which there is no retry; the ladder stays the
 * floor so `Retry-After: 0` cannot become a hot loop. */
function nextRetryDelay(
  budget: RetryBudget,
  askedForMs: number | null = null,
): number | null {
  if (budget.used >= budget.backoffMs.length) return null;
  const reserved = (budget.used + 2) * MAX_REPORT_COST_USD;
  if (budget.monthSpendUsd + reserved > budget.monthlyCapUsd) return null;
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
 * 130-second timeout. A SignalError here is `response_too_large` or
 * `response_invalid_json` — facts about what DID come back, which repeating
 * cannot change. */
function isTransientTransport(error: unknown): boolean {
  return !(error instanceof SignalError) && error instanceof Error;
}

/** An explicit "there is more than what is stored here". Both families that can
 * say it are bounded by our own cap, not the provider's. */
function providerTruncated(spec: ReportSpec, providerRows: number): boolean {
  if (spec.name === 'ranked-keywords') {
    return providerRows >= RANKED_KEYWORD_LIMIT;
  }
  // The panel reads two pages of a result set that always continues past them.
  return spec.name === 'serp-panel';
}

interface ParsedProviderResponse {
  providerRows: number;
  costUsd: number;
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
  const rootCost = finiteNumber(root?.cost);
  const costUsd = rootCost ?? 0;
  const task = asRecord(arrayField(root, 'tasks')[0]);
  const taskStatus = finiteNumber(task?.status_code);
  const failed = (error: SignalError): ParsedProviderResponse => {
    Object.assign(error, { costUsd });
    if (!retainTaskFailure) throw error;
    return { providerRows: 0, costUsd, taskError: error };
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
        costUsd: rootCost ?? finiteNumber(task?.cost) ?? 0,
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
  return {
    providerRows: Math.max(1, declaredItems ?? nestedItems),
    costUsd: rootCost ?? finiteNumber(task?.cost) ?? 0,
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

function normalizeDomain(value: string): string {
  try {
    const parsed = new URL(
      value.includes('://') ? value : `https://${value}`,
    );
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return value
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]!;
  }
}

function providerCost(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const value = (error as { costUsd?: unknown }).costUsd;
  return finiteNumber(value) ?? 0;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    unchanged: outcomes.filter((outcome) => outcome.status === 'unchanged').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    costUsd: outcomes.reduce((sum, outcome) => sum + outcome.costUsd, 0),
    outcomes,
    ...(egress ? { egress } : {}),
  };
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
