import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, persistCollectionAttempt, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
// Operator-directed, analysis-grade GA4, Search Console, and Bing Webmaster
// archives.
//
// This lane is deliberately separate from the 15-minute chart aggregates.
// It re-fetches a short completed-day revision window, preserves bounded raw
// provider responses as gzip JSON in private R2, and writes only append-only
// manifests to the store: each run in `noticeos.archive_runs`, naming the
// object it stored in `noticeos.archive_objects` (bead ro-ujb9.76.5.4).
// Credentials and access tokens never enter either store.

import { storedProviderCost, type Ga4PropertyQuota } from '@noticeos/contract';
import type { WorkspaceStore } from '@noticeos/postgres';
import { signalObjectScope } from './signal-objects.js';
import {
  googleCredentialResolver,
  googleTargets,
  groupGoogleTargetsByAccount,
  type GoogleIntegrationId,
  type GooglePropertyTarget,
} from './google-signals.js';
import { GOOGLE_SCOPES, googleAccessToken } from './google-auth.js';
import { resolveGoogleCredential } from './google-oauth.js';
import {
  GA4_QUOTA_EXHAUSTED_CODE,
  isQuotaExhausted,
  parseGa4PropertyQuota,
  recordGa4Quota,
} from './ga4-quota.js';
import {
  BING_CREDENTIAL_REF,
  bingRequest,
  bingResponseRows,
  bingSiteMapping,
  bingTarget,
  getBingVerifiedSites,
  loadBingPortfolioCandidates,
} from './bing-client.js';
import { type LaneRegister, laneDeclined } from './lane-mapping.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import type { CredentialSource } from '@noticeos/contract';
import { credentialConnected, resolveCredential, sourcedCredentialRef } from './credentials.js';
import {
  normalizeSignalError,
  SignalError,
  type SignalTarget,
} from './signal-store.js';
import {
  EGRESS_DOWN_CODE,
  EgressGate,
  type EgressRunOutcome,
  type TransportWatch,
  egressExplains,
  openEgressLaneRecord,
  watchTransport,
} from './egress.js';
import { healthFailure } from './integration-health-store.js';
import ga4CustomDimensionsJson from '../../../config/ga4-custom-dimensions.json';

const SCHEMA_VERSION = 1;
const DEFAULT_REVISION_DAYS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;
const ARCHIVE_BYTE_LIMIT = 32 * 1024 * 1024;
const GSC_PAGE_ROWS = 25_000;
const GSC_REPORT_ROWS = 50_000;
const GA4_PAGE_ROWS = 25_000;
const GA4_REPORT_ROWS = 250_000;
/** How the Data API names an event-scoped parameter. Registration in GA4 admin
 * is what turns a sent parameter into one of these. */
const GA4_CUSTOM_EVENT_PREFIX = 'customEvent:';
const JS_ERROR_EVENT = 'js_error';

/**
 * How many earlier GA4 / Search Console report dates one run re-asks after an
 * outage (bead `ro-aed0.7`).
 *
 * A dead night's leftovers are the revision window's oldest date for every
 * family plus the newest date of the families collected for one date only —
 * about ninety requests for a five-property portfolio, the shape 2026-09-14
 * left. One hundred re-collects a night like that on the next tick, and a
 * week-long outage drains over the following days instead of doubling one run.
 */
export const ARCHIVE_RETRY_LIMIT = 100;

export interface Ga4CustomDimensionAssetConfig {
  eventParams: string[];
}

export interface Ga4CustomDimensionConfig {
  assets: Record<string, Ga4CustomDimensionAssetConfig>;
}

const GA4_CUSTOM_DIMENSIONS = ga4CustomDimensionsJson as Ga4CustomDimensionConfig;

/**
 * Whether this property can answer for every `customEvent:` dimension the spec
 * needs — i.e. whether `config/ga4-custom-dimensions.json` records the operator
 * having registered them (see that file's README). A property it does not cover
 * is skipped entirely: no request, no manifest row. Absence of config is not a
 * failed collection, the same rule the tracked SERP panel follows.
 *
 * This gate does NOT retire `ga4_custom_dimension_unregistered`. Registration is
 * forward-only, so a listed property can still be asked for a date before its
 * dimensions existed — and the file is a hand-maintained claim about a system it
 * cannot inspect, so a wrong entry has to fail loudly rather than read as zero.
 */
function ga4DimensionsRegistered(
  spec: Ga4ReportSpec,
  asset: string,
  config: Ga4CustomDimensionConfig,
): boolean {
  const required = spec.dimensions
    .filter((dimension) => dimension.startsWith(GA4_CUSTOM_EVENT_PREFIX))
    .map((dimension) => dimension.slice(GA4_CUSTOM_EVENT_PREFIX.length));
  if (required.length === 0) return true;
  const declared = config?.assets?.[asset]?.eventParams;
  if (!Array.isArray(declared)) return false;
  return required.every((param) => declared.includes(param));
}

interface DumpReportSpec {
  name: string;
  /**
   * Opt in to probe mode. A family a property does not participate in at all
   * (Discover for a site Google has never surfaced there) answers every
   * revision date with an empty page, so the full window costs four requests a
   * day to re-learn the same nothing. With this set, once every completed run
   * for an (asset, report) has come back with zero rows the collector asks for
   * only the newest completed date — enough to notice the family turning on,
   * at which point the full revision window resumes. The first-ever run has no
   * history and always takes the full window.
   */
  probeWhenAlwaysEmpty?: boolean;
}

interface GscReportSpec extends DumpReportSpec {
  dimensions: string[];
  searchType: 'web' | 'image' | 'discover';
  expandSearchAppearanceByPage?: boolean;
}

interface Ga4MetricSpec {
  name: string;
  expression?: string;
}

interface Ga4ReportSpec extends DumpReportSpec {
  dimensions: string[];
  metrics: Ga4MetricSpec[];
  /** Rolling aggregate ending on reportDate. Omitted means one completed day. */
  windowDays?: number;
  /** Collect once for the newest completed date, not once per revision date. */
  latestOnly?: boolean;
  /**
   * A GA4 `FilterExpression`, sent verbatim and archived with every request so
   * the stored rows carry the population they describe. A family that filters
   * to one event must never be read as a property-wide total.
   */
  dimensionFilter?: Record<string, unknown>;
}

interface BingReportSpec {
  name: string;
  method:
    | 'GetRankAndTrafficStats'
    | 'GetQueryStats'
    | 'GetPageStats'
    | 'GetCrawlStats'
    | 'GetCrawlIssues'
    | 'GetFeeds';
  /**
   * How often the PROVIDER refreshes this family, in whole days. Omitted means
   * 1 — ask every day, because the answer can differ every day.
   *
   * A family Microsoft refreshes weekly answers six of every seven daily calls
   * with the snapshot it already gave us, so those six buy nothing and are
   * spent on someone else's rate limit. Set this and the collector asks only
   * once per cadence per property; see `dueBingReports` for how "once" is
   * decided and what it deliberately does NOT do (latch, or hide a failure).
   */
  cadenceDays?: number;
}

const GSC_REPORTS: GscReportSpec[] = [
  { name: 'page-query', dimensions: ['page', 'query'], searchType: 'web' },
  { name: 'page', dimensions: ['page'], searchType: 'web' },
  { name: 'query', dimensions: ['query'], searchType: 'web' },
  { name: 'country', dimensions: ['country'], searchType: 'web' },
  { name: 'device', dimensions: ['device'], searchType: 'web' },
  { name: 'page-country', dimensions: ['page', 'country'], searchType: 'web' },
  { name: 'page-device', dimensions: ['page', 'device'], searchType: 'web' },
  {
    name: 'search-appearance-pages',
    dimensions: ['searchAppearance'],
    searchType: 'web',
    expandSearchAppearanceByPage: true,
  },
  { name: 'image-page-query', dimensions: ['page', 'query'], searchType: 'image' },
  {
    name: 'discover-page',
    dimensions: ['page'],
    searchType: 'discover',
    probeWhenAlwaysEmpty: true,
  },
];

// These mirror durable GA4 report families rather than the UI's current CSV
// layout. Expressions are stored with every request so later analysis can
// reproduce exactly what a metric meant at collection time.
const GA4_REPORTS: Ga4ReportSpec[] = [
  {
    name: 'pages-screens',
    dimensions: ['unifiedPagePathScreen'],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'activeUsers' },
      { name: 'screenPageViewsPerUser' },
      { name: 'averageEngagementTime', expression: 'userEngagementDuration/activeUsers' },
      { name: 'eventCount' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
  {
    name: 'landing-pages',
    dimensions: ['landingPage'],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'newUsers' },
      {
        name: 'averageEngagementTimePerSession',
        expression: 'userEngagementDuration/sessions',
      },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
  {
    name: 'traffic-acquisition',
    dimensions: ['sessionDefaultChannelGroup'],
    metrics: [
      { name: 'activeUsers' },
      { name: 'sessions' },
      { name: 'engagedSessions' },
      {
        name: 'averageEngagementTimePerSession',
        expression: 'userEngagementDuration/sessions',
      },
      { name: 'eventsPerSession' },
      { name: 'engagementRate' },
      { name: 'eventCount' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
  {
    name: 'traffic-sources',
    dimensions: ['sessionSourceMedium', 'sessionCampaignName'],
    metrics: [
      { name: 'activeUsers' },
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'eventCount' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
  {
    name: 'events',
    dimensions: ['eventName'],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalUsers' },
      { name: 'eventCountPerUser' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
  {
    name: 'events-28d',
    dimensions: ['eventName'],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalUsers' },
    ],
    windowDays: 28,
    latestOnly: true,
  },
  {
    name: 'page-events',
    dimensions: ['unifiedPagePathScreen', 'eventName'],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalUsers' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
  {
    // The triage half of the `javascript-errors` card. The events family counts
    // js_error per page, which names the worst page and nothing an engineer can
    // act on; the emitter already sends `message` and `source` on every report,
    // so this family asks for those two next to the page.
    //
    // GA4 will only answer for an event parameter an operator has REGISTERED as
    // a custom dimension, and it backfills nothing before that registration —
    // so an empty window here can mean "no errors" or "not collecting yet", and
    // `ga4_custom_dimension_unregistered` exists to keep those apart (doc 02:
    // absent is never zero).
    name: 'js-errors',
    dimensions: [
      `${GA4_CUSTOM_EVENT_PREFIX}message`,
      `${GA4_CUSTOM_EVENT_PREFIX}source`,
      'unifiedPagePathScreen',
    ],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { matchType: 'EXACT', value: JS_ERROR_EVENT },
      },
    },
    // A property whose pages never throw answers every revision date with an
    // empty page, and re-learning that costs four requests a day.
    probeWhenAlwaysEmpty: true,
  },
  {
    name: 'landing-page-acquisition',
    dimensions: ['landingPage', 'sessionDefaultChannelGroup', 'sessionSourceMedium'],
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'newUsers' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
      { name: 'sessionKeyEventRate' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  },
];

/** Microsoft's own refresh interval for the top-query and top-page snapshots
 * (doc 11: "current top-result snapshots that update weekly"). */
const BING_WEEKLY = 7;

const BING_INTEGRATION: DumpIntegration = 'bing-webmaster';

// Rank/traffic and the crawl families are genuine daily provider series — a new
// day of history appears every day, so they are asked for every day. The query
// and page families are one current top-result snapshot that Microsoft rebuilds
// weekly, so asking daily re-downloads the same snapshot six times.
const BING_REPORTS: BingReportSpec[] = [
  { name: 'rank-traffic', method: 'GetRankAndTrafficStats' },
  { name: 'queries', method: 'GetQueryStats', cadenceDays: BING_WEEKLY },
  { name: 'pages', method: 'GetPageStats', cadenceDays: BING_WEEKLY },
  { name: 'crawl-stats', method: 'GetCrawlStats' },
  { name: 'crawl-issues', method: 'GetCrawlIssues' },
  { name: 'feeds', method: 'GetFeeds' },
];

export interface DumpPage {
  request: Record<string, unknown>;
  response: unknown;
}

export interface CollectedDump {
  pages: DumpPage[];
  providerRows: number;
  providerTruncated: boolean;
  /**
   * What the provider said this collection cost, where it meters in a budget
   * (GA4 only today). Carried beside the pages rather than inside them — see
   * the note in `collectGa4Dump` on why it never enters the content hash.
   */
  quota?: Ga4PropertyQuota | null;
  /**
   * The pages as the content hash sees them, when a page carries a field that
   * changes on every call (bead `ro-ghis.1`: a PostHog body's own
   * `collectedAt`). Archived bytes are always `pages`; only the hash reads
   * this, so an unchanged re-run still dedupes. Omitted means `pages`.
   */
  canonicalPages?: DumpPage[];
}

interface SignalDumpEnvelope {
  schemaVersion: number;
  provider: DumpProvider;
  integration: DumpIntegration;
  report: string;
  asset: string;
  credentialRef: string;
  propertyRef: string;
  reportDate: string;
  collectedAt: string;
  dataState: DumpDataState;
  providerRows: number;
  providerTruncated: boolean;
  pages: DumpPage[];
  /**
   * What the collection cost us, archived with the run and deliberately ABSENT
   * from the canonical bytes the content hash is taken over: it changes on every
   * call, so hashing it would retire the unchanged-detection this lane depends
   * on. Present only for lanes whose provider meters a budget.
   */
  providerQuota?: Ga4PropertyQuota | null;
}

export type DumpProvider = 'google' | 'microsoft' | 'dataforseo' | 'posthog';
export type DumpIntegration =
  | GoogleIntegrationId
  | 'bing-webmaster'
  | 'dataforseo'
  | 'clarity'
  | 'posthog';
export type DumpDataState =
  | 'provider-final'
  | 'revision-window'
  | 'provider-snapshot';
type DumpStatus = 'success' | 'unchanged' | 'error';

export interface DumpTarget extends Omit<SignalTarget, 'integration'> {
  integration: DumpIntegration;
}

export interface SignalDumpOutcome {
  asset: string;
  integration: DumpIntegration;
  report: string;
  reportDate: string;
  status: DumpStatus;
  providerRows: number;
  providerTruncated: boolean;
  objectKey: string | null;
  errorCode: string | null;
  /** True when the OS's own uplink, not the provider, is why this family went
   * uncollected — see {@link unmeasuredDumpOutcome}. */
  egressDown?: true;
}

/** The run's egress question, carried to every catch that might owe it. */
interface EgressLane {
  gate: EgressGate;
  transport: TransportWatch;
}

export interface SignalDumpsResult {
  attempted: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  /**
   * (property, family) pairs this run did not ask for because the provider had
   * not refreshed them yet — today only, never a running total. Counted rather
   * than folded into `attempted` so a shrinking request count reads as the
   * cadence working and never as a lane that quietly collected less.
   */
  skipped: number;
  /**
   * Earlier report dates this run asked for again because an outage cost them
   * (bead `ro-aed0.7`) — already counted in `attempted` and `outcomes`, named
   * here so a larger run reads as a gap being filled, not as a bigger window.
   */
  retried: number;
  outcomes: SignalDumpOutcome[];
  /** What the run's egress gate concluded — see {@link EgressRunOutcome}. */
  egress: EgressRunOutcome;
}

export interface SignalDumpsOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  rawConfig?: string;
  bingApiKey?: string;
  revisionDays?: number;
  /** Override the built-in config/ga4-custom-dimensions.json (tests inject their own). */
  ga4CustomDimensions?: Ga4CustomDimensionConfig;
  /** Override the compiled-in config/integrations.json mapping (tests state
   * their own register instead of editing the operator's file). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file — resolved once per cron fire
   * in dispatch.ts and reported on the completion line below (`ro-syok.7`). */
  configSources?: ConfigSourceMap;
  /** The operator's saved clock (config/constants.json `os_time_zone`, store
   * first — bead `ro-ujb9.88`), assumed for a GA4 property that states no
   * zone of its own. Absent: the zone compiled into this Worker. */
  osTimeZone?: string;
  /** Override the run's egress gate (tests control the verdict TTL); every other
   * caller gets a real one over the same fetcher. */
  egress?: EgressGate;
  /** Override {@link ARCHIVE_RETRY_LIMIT} (tests pin the bound with a small one). */
  retryLimit?: number;
}

interface PriorDump {
  objectKey: string;
  objectBytes: number;
}

interface ManifestSuccess {
  monitoring?: CollectionMonitoring;
  target: DumpTarget;
  report: string;
  reportDate: string;
  requestedAt: string;
  dataState: DumpDataState;
  status: 'success' | 'unchanged';
  providerRows: number;
  requestCount: number;
  providerTruncated: boolean;
  objectKey: string;
  contentSha256: string;
  objectBytes: number;
  providerCostUsd?: number;
}

interface ManifestFailure {
  monitoring?: CollectionMonitoring;
  target: DumpTarget;
  report: string;
  reportDate: string;
  requestedAt: string;
  dataState: DumpDataState;
  error: SignalError;
  providerCostUsd?: number;
  /** No purchase happened, or a separate archive row already carries its cost. */
  knownZeroCost?: true;
}

export async function runSignalDumps(
  env: IngestEnv,
  options: SignalDumpsOptions = {},
): Promise<SignalDumpsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const requestedAt = new Date(nowMs).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const revisionDays = options.revisionDays ?? DEFAULT_REVISION_DAYS;
  if (!Number.isInteger(revisionDays) || revisionDays < 1 || revisionDays > 14) {
    throw new SignalError('config_invalid', 'Signal dump revisionDays must be between 1 and 14.');
  }
  const reportDates = completedDates(nowMs, revisionDays);
  // CAN THE OS GET OUT (bead `ro-aed0.4`)? This lane was the worst of the dead
  // uplink's fan-outs: one failed token mint walked every target x family x
  // revision date and wrote a `request_failed` manifest for each — several
  // hundred for one dark night, each rendered as "Nightly archive failed — the
  // provider returned request_failed". One gate per run, asked only about a
  // provider call that came back with no status; its beacons use the raw fetcher.
  const egress: EgressLane = {
    gate: options.egress ?? new EgressGate(env, { lane: 'signal-dumps', fetchImpl, at: requestedAt }),
    transport: watchTransport(fetchImpl),
  };
  const providerFetch = egress.transport.fetch;
  const ga4CustomDimensions = options.ga4CustomDimensions ?? GA4_CUSTOM_DIMENSIONS;
  // Store first, legacy env binding second (bead `ro-vu8d.1`), for both halves
  // of this lane: the Google account map here and the Bing key below.
  const google = await resolveGoogleCredential(env);
  const googleHealth = await tryHealthConnection(env, 'google', google.credential, [google.oauth?.clientId ?? '', google.oauth?.clientSecret ?? '']);
  const googleMonitoring = beginCollection(env.STORE, googleHealth);
  const googleSource: CredentialSource =
    options.rawConfig === undefined ? google.source : 'env';
  const googleAccounts = options.rawConfig ?? google.accounts;
  // The register first, the credential blob second, through the one door the
  // live collector uses (`ro-vu8d.16`). An OAuth install with nothing mapped
  // anywhere archives nothing rather than failing every report family, and so
  // does one where Google is not connected at all (bead `ro-ujb9.172`).
  // …and a property its Data sources row declines (Not using) is not
  // archived: the one skip rule every collector applies (bead
  // `ro-ujb9.96.7.18`).
  const targets = googleTargets(
    { accounts: googleAccounts, oauth: google.oauth, connected: google.connected },
    googleSource,
    googleCredentialResolver(env),
    options.laneRegister,
    options.osTimeZone,
  ).filter((target) => !laneDeclined(target.asset, target.integration, options.laneRegister));
  const outcomes: SignalDumpOutcome[] = [];
  // Every (property, family) -> the dates this run asks for, resolved before
  // this run writes any of its own manifests, so a probe day's zero-row result
  // (or a re-collected earlier date) cannot narrow the same run's window.
  const plans = new Map<GooglePropertyTarget, Map<string, string[]>>();
  for (const target of targets) {
    const byReport = new Map<string, string[]>();
    for (const report of reportsFor(target.integration, target.asset, ga4CustomDimensions)) {
      byReport.set(
        report,
        await resolveReportDates(env.STORE, target, target.integration, report, reportDates),
      );
    }
    plans.set(target, byReport);
  }
  // The earlier dates an outage cost this lane (bead `ro-aed0.7`), capped.
  const retry = await owedArchiveDates(
    env,
    targets,
    plans,
    reportDates.at(-1)!,
    options.retryLimit ?? ARCHIVE_RETRY_LIMIT,
  );
  let retried = 0;

  for (const [account, accountTargets] of groupGoogleTargetsByAccount(targets)) {
    for (const integration of ['ga4', 'gsc'] as const) {
      const scopedTargets = accountTargets.filter((target) => target.integration === integration);
      if (scopedTargets.length === 0) continue;

      let accessToken: string;
      try {
        accessToken = await googleAccessToken(
          scopedTargets[0]!.auth,
          GOOGLE_SCOPES[integration],
          nowMs,
          providerFetch,
        );
      } catch (error) {
        // The same walk either way — the run still owes every one of these
        // dates — but a dead uplink records none of them against the provider.
        // The earlier dates owed a re-collection are not walked: nothing asked
        // for them, so they stay owed exactly as they were.
        const unmeasured = await egressExplains(egress.gate, egress.transport, error);
        if (unmeasured) retry.halt();
        const normalized = normalizeSignalError(error, 'Google authentication failed.');
        for (const target of scopedTargets) {
          for (const [report, dates] of plans.get(target) ?? []) {
            for (const reportDate of dates) {
              if (unmeasured) {
                outcomes.push(unmeasuredDumpOutcome(egress.gate, target, report, reportDate));
                continue;
              }
              await recordDumpFailure(env.STORE, {
                monitoring: googleMonitoring,
                target,
                report,
                reportDate,
                requestedAt,
                dataState: dataStateFor(integration),
                error: normalized,
              });
              outcomes.push(failedOutcome(target, report, reportDate, normalized));
            }
          }
        }
        continue;
      }

      // The owed earlier dates go FIRST, so the newest manifest of every
      // family is still this run's own window — the Tower reads a family's
      // latest row as its current date.
      for (const target of scopedTargets) {
        for (const { report, reportDate } of retry.dates.get(target) ?? []) {
          if (!retry.open) break;
          const outcome = await collectAndArchive(
            env,
            target,
            report,
            reportDate,
            requestedAt,
            accessToken,
            egress,
            googleMonitoring,
          );
          outcomes.push(outcome);
          retried += 1;
          // A connection that is down, or still dropping requests, stops the
          // pass after ONE ask: the rest stay owed for the next run rather than
          // spending a timeout each against the same wall.
          if (outcome.egressDown || networkFailure(outcome.errorCode)) retry.halt();
        }
      }

      for (const target of scopedTargets) {
        for (const [report, dates] of plans.get(target) ?? []) {
          for (const reportDate of dates) {
            const outcome = await collectAndArchive(
              env,
              target,
              report,
              reportDate,
              requestedAt,
              accessToken,
              egress,
              googleMonitoring,
            );
            if (outcome.egressDown) retry.halt();
            outcomes.push(outcome);
          }
        }
      }
    }

    console.log(
      JSON.stringify({
        event: 'signal_dumps_account_complete',
        account,
        attempted: outcomes.filter((outcome) =>
          accountTargets.some(
            (target) =>
              target.asset === outcome.asset && target.integration === outcome.integration,
          ),
        ).length,
      }),
    );
  }

  const bing = await resolveCredential(env, 'bing-webmaster');
  const bingHealth = await tryHealthConnection(env, 'bing-webmaster', bing);
  const bingMonitoring = beginCollection(env.STORE, bingHealth);
  // Bing not connected at all archives nothing and records nothing, so the
  // Bing half of this step is no work rather than a failure per site and due
  // family (bead `ro-ujb9.176`). A caller that passed a key is a test: `env`.
  const bingConnected =
    options.bingApiKey !== undefined || (await credentialConnected(env, 'bing-webmaster', bing));
  const skipped = !bingConnected
    ? 0
    : await collectBingDumps(
        env,
        requestedAt,
        reportDates.at(-1)!,
        options.bingApiKey ?? bing.fields.BING_WEBMASTER_API_KEY,
        egress,
        outcomes,
        sourcedCredentialRef(
          BING_CREDENTIAL_REF,
          options.bingApiKey === undefined ? bing.source : 'env',
        ),
        options.laneRegister,
        bingMonitoring,
      );

  // What this run answered for on the flag's `signal-dumps` entry: a dated
  // GA4 / Search Console obligation leaves it only once something asked for
  // that exact date and heard back (or no property owes it any more), so an
  // outage's dates stay owed until they are re-collected, however many runs
  // that takes. An undated part — a Bing family, whose provider can only
  // answer "now" — is answered by this run's own snapshot, as before.
  const answered = new Set(
    outcomes
      .filter((outcome) => !outcome.egressDown)
      .map((outcome) => archivePartKey(outcome.asset, archivePart(outcome.integration, outcome.report, outcome.reportDate))),
  );
  const covers = (asset: string, part: string | null): boolean => {
    const dated = part === null ? null : parseArchivePart(part);
    if (dated === null) return true;
    const target = targets.find((candidate) => candidate.asset === asset && candidate.integration === dated.integration);
    if (target === undefined || !plans.get(target)?.has(dated.report)) return true;
    return answered.has(archivePartKey(asset, part!));
  };
  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    unchanged: outcomes.filter((outcome) => outcome.status === 'unchanged').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    skipped,
    retried,
    outcomes,
    // One `os-egress-down` fact for the whole night — or the retraction of one
    // an earlier run left open.
    egress: await egress.gate.finalize({ covers }),
  };
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  console.log(
    JSON.stringify({
      event: 'signal_dumps_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      // WHERE THIS RUN'S CONFIG CAME FROM (bead `ro-syok.7`) — the per-asset
      // mapping and the GA4 custom-dimension roster, each `store` when the run
      // read the document an operator saved and `file` when it read the copy
      // compiled into this Worker. The words only; never a document.
      ...configSourceLine(options.configSources, [
        'config/integrations.json',
        'config/ga4-custom-dimensions.json',
      ]),
      // Named for its reason, so a smaller `attempted` is legible as "the
      // provider has nothing new for these yet" rather than as lost coverage.
      skippedNotDue: result.skipped,
      // Earlier dates an outage cost, asked again (bead `ro-aed0.7`), and how
      // many owed ones this run left for the next (the bound, or a pass the
      // connection cut short).
      retried: result.retried,
      retryNotAsked: retry.owed - result.retried,
      // Provider failures only: a family the dead uplink swallowed is counted
      // in `failed` and `unmeasured`, never listed as the provider's error.
      errors: measured
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, integration, report, reportDate, errorCode }) => ({
          asset,
          integration,
          report,
          reportDate,
          errorCode,
        })),
      unmeasured: outcomes.length - measured.length,
    }),
  );
  return { ...result, ...collectionMonitoring(googleMonitoring), ...collectionMonitoring(bingMonitoring) };
}

/** How many (property, family) pairs this run left alone because the provider
 * has not refreshed them since the last archive. */
async function collectBingDumps(
  env: IngestEnv,
  requestedAt: string,
  reportDate: string,
  apiKey: string | undefined,
  egress: EgressLane,
  outcomes: SignalDumpOutcome[],
  credentialRef: string,
  laneRegister?: LaneRegister,
  monitoring?: CollectionMonitoring,
): Promise<number> {
  // A site its Data sources row declines (Not using) owes no archive: it is
  // not asked for, and no attempt is recorded for it (bead `ro-ujb9.96.7.18`).
  const candidates = (await loadBingPortfolioCandidates(env.STORE))
    .filter((candidate) => !laneDeclined(candidate.asset, 'bing-webmaster', laneRegister));
  // What this run owes, decided for the whole lane before it writes a single
  // manifest of its own — so today's archive can never satisfy today's own
  // cadence check — and consulted by every path below. A family that is not due
  // is not one of this run's reports at all, so the credential failure and the
  // unverified-site failure do not invent an attempt for it either: an error row
  // for a request nobody was going to make is a fabricated attempt.
  const plan = new Map<string, BingReportSpec[]>();
  for (const candidate of candidates) {
    plan.set(
      candidate.asset,
      await dueBingReports(env.STORE, candidate.asset, reportDate),
    );
  }
  const skipped =
    candidates.length * BING_REPORTS.length -
    [...plan.values()].reduce((sum, reports) => sum + reports.length, 0);

  let sites: Map<string, string>;
  try {
    if (!apiKey) {
      throw new SignalError(
        'config_missing',
        'BING_WEBMASTER_API_KEY is not configured.',
      );
    }
    sites = await getBingVerifiedSites(apiKey, egress.transport.fetch);
  } catch (error) {
    // One dead discovery call is one fact about this OS, not a manifest per
    // property per due family — and returning before the site loop keeps
    // `bwt_site_unverified` unreachable on a night no site list arrived.
    const unmeasured = await egressExplains(egress.gate, egress.transport, error);
    const normalized = normalizeSignalError(
      error,
      'Bing Webmaster authentication failed.',
    );
    for (const candidate of candidates) {
      // No site list was fetched, so only the register can name a site here.
      const mapped = bingSiteMapping(candidate.asset, candidate.domain, null, laneRegister);
      const target = bingTarget(candidate, mapped?.value ?? candidate.domain, credentialRef);
      for (const report of plan.get(candidate.asset) ?? []) {
        if (unmeasured) {
          outcomes.push(unmeasuredDumpOutcome(egress.gate, target, report.name, reportDate));
          continue;
        }
        await recordDumpFailure(env.STORE, {
          monitoring,
          target,
          report: report.name,
          reportDate,
          requestedAt,
          dataState: 'provider-snapshot',
          error: normalized,
        });
        outcomes.push(
          failedOutcome(target, report.name, reportDate, normalized),
        );
      }
    }
    return skipped;
  }

  for (const candidate of candidates) {
    // The register first, the verified-site domain match second (`ro-vu8d.16`).
    const siteUrl = bingSiteMapping(
      candidate.asset,
      candidate.domain,
      sites,
      laneRegister,
    )?.value;
    const target = bingTarget(candidate, siteUrl ?? candidate.domain, credentialRef);
    if (!siteUrl) {
      const error = new SignalError(
        'bwt_site_unverified',
        `Bing Webmaster does not list a verified site for ${candidate.domain}.`,
      );
      for (const report of plan.get(candidate.asset) ?? []) {
        await recordDumpFailure(env.STORE, {
          monitoring,
          target,
          report: report.name,
          reportDate,
          requestedAt,
          dataState: 'provider-snapshot',
          error,
        });
        outcomes.push(failedOutcome(target, report.name, reportDate, error));
      }
      continue;
    }

    for (const report of plan.get(candidate.asset) ?? []) {
      outcomes.push(
        await collectAndArchiveBing(
          env,
          target,
          report,
          reportDate,
          requestedAt,
          apiKey,
          egress,
          monitoring,
        ),
      );
    }
  }
  return skipped;
}

/**
 * The BWT families this property owes for `reportDate`, in declaration order.
 *
 * A daily family is always due. A family on a longer cadence is due when the
 * newest date it has ever ARCHIVED is at least that many days behind the date
 * being collected — so a property collects it once a week and, on the other six
 * days, is simply not asked.
 *
 * Three properties this deliberately has:
 *
 * - **It is measured from archives, not from the calendar.** No day-of-week
 *   anchor, so a run the OS missed does not push the family a further week out;
 *   the day after an outage it is overdue and collected.
 * - **A failure never satisfies a cadence.** Only `success`/`unchanged` rows
 *   count, so a weekly family that failed today is due again tomorrow instead of
 *   waiting out a week on the strength of an error.
 * - **Skipping writes nothing.** A run's status is a closed vocabulary of
 *   attempts (`success`, `unchanged`, `error`), and a day we did
 *   not ask about is not an attempt. The family keeps its last real manifest, so
 *   "we asked and it was the same" stays distinguishable from "we did not ask" —
 *   and the lane's freshness, which reads the newest manifest across families,
 *   is still carried by the four daily ones.
 */
async function dueBingReports(
  store: WorkspaceStore,
  asset: string,
  reportDate: string,
): Promise<BingReportSpec[]> {
  if (BING_REPORTS.every((spec) => (spec.cadenceDays ?? 1) <= 1)) {
    return BING_REPORTS;
  }
  const rows = await store.read((tx) =>
    tx.query<{ report: string; latest: string | null }>(
      `SELECT report, max(report_date) AS latest
         FROM noticeos.archive_runs
        WHERE asset_id = $1 AND integration = $2
          AND status IN ('success','unchanged')
        GROUP BY report`,
      [asset, BING_INTEGRATION],
    ),
  );
  const archived = new Map(rows.map((row) => [row.report, row.latest]));
  return BING_REPORTS.filter((spec) => {
    const cadenceDays = spec.cadenceDays ?? 1;
    if (cadenceDays <= 1) return true;
    const latest = archived.get(spec.name) ?? null;
    // Never archived — including the day a property is seeded — is always due.
    if (latest === null) return true;
    return wholeDaysBetween(latest, reportDate) >= cadenceDays;
  });
}

/** Whole UTC days from `from` to `to`. An unparseable stored date reads as
 * infinitely old, so a history the run cannot understand causes a collection
 * rather than a silent, permanent skip. */
function wholeDaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round((end - start) / 86_400_000);
}

async function collectAndArchive(
  env: IngestEnv,
  target: GooglePropertyTarget,
  report: string,
  reportDate: string,
  requestedAt: string,
  accessToken: string,
  egress: EgressLane,
  monitoring?: CollectionMonitoring,
): Promise<SignalDumpOutcome> {
  const dataState = dataStateFor(target.integration);
  try {
    const collected =
      target.integration === 'gsc'
        ? await collectGscDump(
            target.propertyRef,
            reportSpec(GSC_REPORTS, report),
            reportDate,
            accessToken,
            egress.transport.fetch,
          )
        : await collectGa4Dump(
            target.propertyRef,
            reportSpec(GA4_REPORTS, report),
            reportDate,
            accessToken,
            egress.transport.fetch,
          );
    if (target.integration === 'ga4') {
      // The quota flag is this machine's store too: its failure is not
      // Google's, and must not read as Google unreachable (bead `ro-aed0.10`).
      await recordGa4Quota(env, {
        asset: target.asset,
        lane: 'signal-dumps',
        propertyRef: target.propertyRef,
        quota: collected.quota ?? null,
        at: requestedAt,
      }).catch((error: unknown) => {
        throw localStoreError(error, 'google', report);
      });
    }
    return await archiveCollectedDump(env, {
      monitoring,
      provider: 'google',
      target,
      report,
      reportDate,
      requestedAt,
      dataState,
      collected,
    });
  } catch (error) {
    // The uplink can also die mid-run, after the token was minted.
    if (await egressExplains(egress.gate, egress.transport, error)) {
      return unmeasuredDumpOutcome(egress.gate, target, report, reportDate);
    }
    const normalized = normalizeSignalError(error, 'Google signal dump failed.');
    await recordDumpFailure(env.STORE, {
      monitoring,
      target,
      report,
      reportDate,
      requestedAt,
      dataState,
      error: normalized,
    });
    return failedOutcome(target, report, reportDate, normalized);
  }
}

async function collectAndArchiveBing(
  env: IngestEnv,
  target: DumpTarget,
  spec: BingReportSpec,
  reportDate: string,
  requestedAt: string,
  apiKey: string,
  egress: EgressLane,
  monitoring?: CollectionMonitoring,
): Promise<SignalDumpOutcome> {
  const dataState: DumpDataState = 'provider-snapshot';
  try {
    const response = await bingRequest(
      spec.method,
      { siteUrl: target.propertyRef },
      apiKey,
      egress.transport.fetch,
    );
    const rows = bingResponseRows(
      response,
      `bwt_dump_${spec.name.replaceAll('-', '_')}_invalid_response`,
    );
    return await archiveCollectedDump(env, {
      monitoring,
      provider: 'microsoft',
      target,
      report: spec.name,
      reportDate,
      requestedAt,
      dataState,
      collected: {
        pages: [
          {
            request: { method: spec.method, siteUrl: target.propertyRef },
            response,
          },
        ],
        providerRows: rows.length,
        providerTruncated: false,
      },
    });
  } catch (error) {
    if (await egressExplains(egress.gate, egress.transport, error)) {
      return unmeasuredDumpOutcome(egress.gate, target, spec.name, reportDate);
    }
    const normalized = normalizeSignalError(
      error,
      'Bing Webmaster signal dump failed.',
    );
    await recordDumpFailure(env.STORE, {
      monitoring,
      target,
      report: spec.name,
      reportDate,
      requestedAt,
      dataState,
      error: normalized,
    });
    return failedOutcome(target, spec.name, reportDate, normalized);
  }
}

/**
 * The code an attempt carries when the provider ANSWERED but this machine could
 * not keep the answer: a D1 read or write, or the R2 put, while archiving it
 * (bead `ro-aed0.10`).
 *
 * Before this code, every collector's catch turned such a failure into its own
 * `request_failed` — the words for a provider that never answered — so the
 * Integrations page said "the provider could not be reached" about this
 * machine's own store, and the dated archives (GA4, Search Console, PostHog)
 * asked the provider again for an answer they had already been given.
 * `healthFailure` files this code as `monitoring` — NoticeOS's own fault —
 * and, not being a network failure, it is never re-asked daily.
 */
export const LOCAL_STORE_FAILED = 'local_store_failed';

/** A failure of this machine's own store while keeping a provider's answer,
 * in words that never blame the provider. A SignalError already names its
 * cause (an archive over the size bound) and passes through. */
export function localStoreError(error: unknown, provider: DumpProvider, report: string): SignalError {
  if (error instanceof SignalError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new SignalError(
    LOCAL_STORE_FAILED,
    `${providerName(provider)} answered, but this machine could not save the ${report} report: ${detail}`.slice(0, 500),
  );
}

export async function archiveCollectedDump(
  env: IngestEnv,
  input: ArchiveInput,
): Promise<SignalDumpOutcome> {
  // Everything below is this machine's work — hashing, compressing, the
  // manifest reads and writes, the R2 put — so anything it throws is the
  // store's fault and is named as such, whichever collector called.
  try {
    return await storeCollectedDump(env, input);
  } catch (error) {
    throw localStoreError(error, input.provider, input.report);
  }
}

interface ArchiveInput {
  monitoring?: CollectionMonitoring;
  provider: DumpProvider;
  target: DumpTarget;
  report: string;
  reportDate: string;
  requestedAt: string;
  dataState: DumpDataState;
  collected: CollectedDump;
  providerCostUsd?: number;
}

async function storeCollectedDump(
  env: IngestEnv,
  input: ArchiveInput,
): Promise<SignalDumpOutcome> {
  const {
    monitoring,
    provider,
    target,
    report,
    reportDate,
    requestedAt,
    dataState,
    collected,
    providerCostUsd = 0,
  } = input;
  const objects = await signalObjectScope(env);
  const envelope: SignalDumpEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    provider,
    integration: target.integration,
    report,
    asset: target.asset,
    credentialRef: target.credentialRef,
    propertyRef: target.propertyRef,
    reportDate,
    collectedAt: requestedAt,
    dataState,
    providerRows: collected.providerRows,
    providerTruncated: collected.providerTruncated,
    pages: collected.pages,
    ...(collected.quota ? { providerQuota: collected.quota } : {}),
  };
  const canonical = JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    provider: envelope.provider,
    integration: envelope.integration,
    report: envelope.report,
    asset: envelope.asset,
    credentialRef: envelope.credentialRef,
    propertyRef: envelope.propertyRef,
    reportDate: envelope.reportDate,
    dataState: envelope.dataState,
    providerRows: envelope.providerRows,
    providerTruncated: envelope.providerTruncated,
    pages: collected.canonicalPages ?? envelope.pages,
  });
  const canonicalBytes = new TextEncoder().encode(canonical);
  if (canonicalBytes.byteLength > ARCHIVE_BYTE_LIMIT) {
    throw new SignalError(
      'archive_too_large',
      `${providerName(provider)} ${report} archive exceeded ${ARCHIVE_BYTE_LIMIT} bytes.`,
    );
  }
  const contentSha256 = await sha256Hex(canonicalBytes);
  const prior = await findPriorDump(
    env.STORE,
    target,
    report,
    reportDate,
    contentSha256,
  );
  if (prior && objects.canReadArchive(prior.objectKey)) {
    await recordDumpSuccess(env.STORE, {
      monitoring,
      target,
      report,
      reportDate,
      requestedAt,
      dataState,
      status: 'unchanged',
      providerRows: collected.providerRows,
      requestCount: collected.pages.length,
      providerTruncated: collected.providerTruncated,
      objectKey: prior.objectKey,
      contentSha256,
      objectBytes: prior.objectBytes,
      providerCostUsd,
    });
    return {
      asset: target.asset,
      integration: target.integration,
      report,
      reportDate,
      status: 'unchanged',
      providerRows: collected.providerRows,
      providerTruncated: collected.providerTruncated,
      objectKey: prior.objectKey,
      errorCode: null,
    };
  }

  const archiveBytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (archiveBytes.byteLength > ARCHIVE_BYTE_LIMIT) {
    throw new SignalError(
      'archive_too_large',
      `${providerName(provider)} ${report} archive exceeded ${ARCHIVE_BYTE_LIMIT} bytes.`,
    );
  }
  const compressed = await gzip(archiveBytes);
  const objectKey = objects.key(dumpObjectKey(
    provider,
    target,
    report,
    reportDate,
    requestedAt,
    contentSha256,
  ));
  const object = await env.RAW_SIGNALS.put(objectKey, compressed, {
    httpMetadata: {
      contentType: 'application/json',
      contentEncoding: 'gzip',
    },
    customMetadata: {
      workspaceId: objects.workspaceId,
      asset: target.asset,
      provider,
      integration: target.integration,
      report,
      reportDate,
      schemaVersion: String(SCHEMA_VERSION),
      contentSha256,
    },
  });
  await recordDumpSuccess(env.STORE, {
    monitoring,
    target,
    report,
    reportDate,
    requestedAt,
    dataState,
    status: 'success',
    providerRows: collected.providerRows,
    requestCount: collected.pages.length,
    providerTruncated: collected.providerTruncated,
    objectKey,
    contentSha256,
    objectBytes: object.size,
    providerCostUsd,
  });
  return {
    asset: target.asset,
    integration: target.integration,
    report,
    reportDate,
    status: 'success',
    providerRows: collected.providerRows,
    providerTruncated: collected.providerTruncated,
    objectKey,
    errorCode: null,
  };
}

function providerName(provider: DumpProvider): string {
  if (provider === 'google') return 'Google';
  // Two Microsoft lanes now share this provider (Bing Webmaster and Clarity),
  // so the vendor is the honest label; the report name carries the rest.
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'posthog') return 'PostHog';
  return 'DataForSEO';
}

async function collectGscDump(
  siteUrl: string,
  spec: GscReportSpec,
  reportDate: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<CollectedDump> {
  const primary = await collectGscQuery(
    siteUrl,
    spec.dimensions,
    spec.searchType,
    reportDate,
    accessToken,
    fetchImpl,
    GSC_REPORT_ROWS,
  );
  if (!spec.expandSearchAppearanceByPage || primary.providerTruncated) return primary;

  const appearances = gscDimensionValues(primary.pages, 'searchAppearance');
  let providerRows = primary.providerRows;
  let providerTruncated = false;
  for (const appearance of appearances) {
    const remaining = GSC_REPORT_ROWS - providerRows;
    if (remaining <= 0) {
      providerTruncated = true;
      break;
    }
    const detail = await collectGscQuery(
      siteUrl,
      ['page'],
      spec.searchType,
      reportDate,
      accessToken,
      fetchImpl,
      remaining,
      {
        dimension: 'searchAppearance',
        expression: appearance,
      },
    );
    primary.pages.push(...detail.pages);
    providerRows += detail.providerRows;
    if (detail.providerTruncated) {
      providerTruncated = true;
      break;
    }
  }

  return {
    pages: primary.pages,
    providerRows,
    providerTruncated,
  };
}

async function collectGscQuery(
  siteUrl: string,
  dimensions: string[],
  searchType: GscReportSpec['searchType'],
  reportDate: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  rowCap: number,
  filter?: { dimension: string; expression: string },
): Promise<CollectedDump> {
  const pages: DumpPage[] = [];
  let providerRows = 0;
  let providerTruncated = false;

  while (providerRows < rowCap) {
    const rowLimit = Math.min(GSC_PAGE_ROWS, rowCap - providerRows);
    const request: Record<string, unknown> = {
      startDate: reportDate,
      endDate: reportDate,
      dimensions,
      type: searchType,
      dataState: 'final',
      rowLimit,
      startRow: providerRows,
    };
    if (filter) {
      request.dimensionFilterGroups = [
        {
          groupType: 'and',
          filters: [
            {
              dimension: filter.dimension,
              operator: 'equals',
              expression: filter.expression,
            },
          ],
        },
      ];
    }
    const response = await fetchImpl(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      googlePost(accessToken, request),
    );
    const body = await boundedResponseJson(response);
    if (!response.ok) throw googleProviderError('gsc_dump', response.status, body);
    const rows = arrayField(asRecord(body), 'rows');
    pages.push({ request, response: body });
    providerRows += rows.length;
    if (rows.length < rowLimit) break;
    if (providerRows >= rowCap) providerTruncated = true;
  }

  return { pages, providerRows, providerTruncated };
}

function gscDimensionValues(pages: DumpPage[], dimension: string): string[] {
  const values = new Set<string>();
  for (const page of pages) {
    const request = asRecord(page.request);
    const dimensions = arrayField(request, 'dimensions');
    const dimensionIndex = dimensions.indexOf(dimension);
    if (dimensionIndex < 0) continue;
    for (const row of arrayField(asRecord(page.response), 'rows')) {
      const key = arrayField(asRecord(row), 'keys')[dimensionIndex];
      if (typeof key === 'string' && key.length > 0) values.add(key);
    }
  }
  return [...values].sort();
}

async function collectGa4Dump(
  propertyId: string,
  spec: Ga4ReportSpec,
  reportDate: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<CollectedDump> {
  const pages: DumpPage[] = [];
  let providerRows = 0;
  let providerTruncated = false;
  let declaredRows: number | null = null;
  // The LAST page's quota, not the first: a paginated family spends tokens on
  // every page, so the newest reading is the only one that describes the budget
  // as it stands when the family finishes.
  let quota: Ga4PropertyQuota | null = null;

  while (providerRows < GA4_REPORT_ROWS) {
    const windowDays = spec.windowDays ?? 1;
    const startDate = isoDateOffset(reportDate, -(windowDays - 1));
    const request: Record<string, unknown> = {
      dateRanges: [{ startDate, endDate: reportDate }],
      dimensions: spec.dimensions.map((name) => ({ name })),
      metrics: spec.metrics,
      keepEmptyRows: true,
      limit: String(GA4_PAGE_ROWS),
      offset: String(providerRows),
      // 33 base requests per property per day before pagination, and no idea
      // what they cost until now. Asking changes the archived REQUEST, so every
      // GA4 family reads as changed once on the run after this shipped, then
      // settles back to its usual unchanged rate.
      returnPropertyQuota: true,
    };
    if (spec.dimensionFilter) request.dimensionFilter = spec.dimensionFilter;
    const response = await fetchImpl(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
      googlePost(accessToken, request),
    );
    const body = await boundedResponseJson(response);
    if (!response.ok) {
      throw (
        unregisteredCustomDimensionError(spec, body) ??
        ga4DumpError(response.status, body)
      );
    }
    const record = asRecord(body);
    const rows = arrayField(record, 'rows');
    const rowCount = finiteNonNegativeInteger(record?.rowCount);
    if (rowCount !== null) declaredRows = rowCount;
    // The quota block is the ONE field lifted out of a response before it is
    // archived. Everything else goes in verbatim, but `consumed` moves on every
    // single call by construction: leaving it in the bytes would put it in the
    // content hash, and every GA4 archive would read as changed forever — the
    // unchanged detection that keeps this lane's R2 footprint honest would
    // silently stop working. The archive is evidence about the PROPERTY's data;
    // what the call cost US is a different fact, and it travels beside it.
    const { propertyQuota: _lifted, ...archived } = record ?? {};
    quota = parseGa4PropertyQuota(record) ?? quota;
    pages.push({ request, response: record === null ? body : archived });
    providerRows += rows.length;

    if (rows.length === 0 || rows.length < GA4_PAGE_ROWS) break;
    if (declaredRows !== null && providerRows >= declaredRows) break;
    if (providerRows >= GA4_REPORT_ROWS) providerTruncated = true;
  }
  if (declaredRows !== null && declaredRows > GA4_REPORT_ROWS) providerTruncated = true;

  return { pages, providerRows, providerTruncated, quota };
}

/**
 * A GA4 archive failure, with an exhausted budget told apart from an ordinary
 * rate limit. Both arrive as 429; only one needs an operator, and a manifest
 * that calls them the same thing is why a quota crunch could not be seen.
 */
function ga4DumpError(status: number, body: unknown): SignalError {
  const generic = googleProviderError('ga4_dump', status, body);
  return isQuotaExhausted(status, body)
    ? new SignalError(GA4_QUOTA_EXHAUSTED_CODE, generic.message)
    : generic;
}

/**
 * The one GA4 rejection that is a lane-configuration fact rather than a
 * provider or credential fault: an event parameter nobody has registered as a
 * custom dimension is not a queryable field, and the Data API answers by
 * rejecting the field name.
 *
 * It earns its own error code because every other outcome reads the same on the
 * manifest. A generic `ga4_dump_http_400` sends the operator to check
 * credentials; a zero-row success would say this property throws no errors —
 * the exact "absent means zero" reading doc 02 forbids. Registration is
 * operator work in the GA4 admin (the measurement channel is `forbidden`-class
 * per AGENTS.md), so the honest state to record is "asked, not yet answerable".
 *
 * Returns null when the failure is anything else, so the normal error path
 * still owns quota, auth, and malformed-request responses.
 */
function unregisteredCustomDimensionError(
  spec: Ga4ReportSpec,
  body: unknown,
): SignalError | null {
  const custom = spec.dimensions.filter((dimension) =>
    dimension.startsWith(GA4_CUSTOM_EVENT_PREFIX),
  );
  if (custom.length === 0) return null;
  const message = stringField(asRecord(asRecord(body)?.error), 'message');
  if (!message) return null;
  // Google has worded this several ways over the API's life; all of them name
  // the offending field, which is the part worth matching on.
  if (!/not a valid dimension|is not registered|did not match/i.test(message)) {
    return null;
  }
  const named = custom.filter((dimension) => message.includes(dimension));
  if (named.length === 0) return null;
  // The state and its one fix (bead `ro-ujb9.96.6.27`): the event parameter
  // has to be registered as a custom dimension in GA4's admin before this
  // family can collect. Google's own words follow.
  return new SignalError(
    'ga4_custom_dimension_unregistered',
    `No GA4 custom dimension ${named.join(', ')} · register it in GA4 admin · Google: ${message}`,
  );
}

function isoDateOffset(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time)) {
    throw new SignalError('config_invalid', `Invalid report date "${date}".`);
  }
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function googlePost(accessToken: string, body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_BYTE_LIMIT) {
    await response.body?.cancel();
    throw new SignalError(
      'response_too_large',
      `Google response exceeded ${RESPONSE_BYTE_LIMIT} bytes.`,
    );
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_BYTE_LIMIT) {
        await reader.cancel();
        throw new SignalError(
          'response_too_large',
          `Google response exceeded ${RESPONSE_BYTE_LIMIT} bytes.`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SignalError('response_invalid_json', 'Google returned invalid JSON.');
  }
}

/**
 * The object this exact content is already stored under, for this exact report
 * date — the whole reach of the dedup, deliberately (`ro-z86`).
 *
 * `report_date` is in the WHERE clause and inside the hashed canonical bytes, so
 * two consecutive dates carrying a byte-identical provider answer each write
 * their own object. What that catches is a RE-FETCH: a re-run of
 * `signals:collect`, a revision window re-asking a GSC day. What it deliberately
 * does not catch is a snapshot family whose payload has not moved since
 * yesterday.
 *
 * Measured over 1105 archives (2026-07-25..08-04) before it was left alone: 61
 * objects, 5.5% of the archive and 22% of the provider-snapshot lanes, repeat an
 * earlier date's payload — but they are all tiny BWT families and cost 35 KiB of
 * 8.3 MiB, 0.42%. Reaching across dates would save ~1.8 MiB a year and cost the
 * panel dir its dates: the shared object's envelope names the FIRST date, and
 * `scripts/signal-archive.mjs` takes every row's `report_date` from that
 * envelope, so day two's rows would arrive stamped day one. See
 * workers/ingest/README.md for the full accounting.
 */
async function findPriorDump(
  store: WorkspaceStore,
  target: DumpTarget,
  report: string,
  reportDate: string,
  contentSha256: string,
): Promise<PriorDump | null> {
  const [prior] = await store.read((tx) =>
    tx.query<{ objectKey: string; objectBytes: bigint }>(
      `SELECT o.object_key AS "objectKey", o.object_bytes AS "objectBytes"
         FROM noticeos.archive_runs r
         JOIN noticeos.archive_objects o ON o.workspace_id = r.workspace_id AND o.object_seq = r.object_seq
        WHERE r.asset_id = $1 AND r.integration = $2 AND r.report = $3 AND r.report_date = $4::date
          AND o.content_sha256 = $5 AND r.status IN ('success','unchanged')
        ORDER BY r.finished_at DESC, r.run_id COLLATE "C" DESC
        LIMIT 1`,
      [target.asset, target.integration, report, reportDate, contentSha256],
    ),
  );
  return prior ? { objectKey: prior.objectKey, objectBytes: Number(prior.objectBytes) } : null;
}

/**
 * The stored object a run names, recorded once per key and dated by the run
 * that stored it (`archive_objects.object_key`): its number back.
 * A key already recorded with the same content is that object — an unchanged
 * run names the object an earlier run stored. A key recorded with other
 * content answers no row, and the run is refused.
 */
const RECORD_OBJECT_SQL = `WITH stored AS (
  INSERT INTO noticeos.archive_objects (workspace_id, object_key, content_sha256, object_bytes, first_stored_at)
  VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
  ON CONFLICT (workspace_id, object_key) DO NOTHING
  RETURNING object_seq)
SELECT object_seq FROM stored
UNION ALL
SELECT object_seq FROM noticeos.archive_objects
 WHERE object_key = $2 AND content_sha256 = $3 AND object_bytes = $4`;

/** One attempt. A failed run names no object and states its error; a stored
 * one names its object. */
const INSERT_RUN_SQL = `INSERT INTO noticeos.archive_runs
  (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref, report_date,
   requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count,
   provider_truncated, object_seq, error_code, error_message, cost_usd, cost_state)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::timestamptz, $10::timestamptz, $11, $12, $13, $14, $15,
        $16, $17::bigint, $18::text, $19::text, $20::numeric, $21)`;

async function recordDumpSuccess(store: WorkspaceStore, manifest: ManifestSuccess): Promise<void> {
  const id = crypto.randomUUID();
  const finishedAt = new Date().toISOString();
  const cost = storedProviderCost(manifest.target.integration, manifest.providerCostUsd ?? 0);
  await persistCollectionAttempt({
    target: manifest.target,
    monitoring: manifest.monitoring,
    attempt: {
      id, startedAt: manifest.requestedAt, finishedAt,
      source: 'signal_dump_runs', ok: !manifest.providerTruncated, code: manifest.providerTruncated ? 'incomplete-report' : undefined,
      report: manifest.report, reportDate: manifest.reportDate,
    },
  }, () =>
    // One transaction: the object recorded (or found), then the run naming it.
    store.write(async (tx) => {
      const [object] = await tx.query<{ object_seq: bigint }>(RECORD_OBJECT_SQL, [
        tx.workspaceId, manifest.objectKey, manifest.contentSha256, manifest.objectBytes, finishedAt,
      ]);
      if (object === undefined) {
        throw new Error(`archive object ${manifest.objectKey} is already recorded with other content`);
      }
      await tx.execute(INSERT_RUN_SQL, [
        tx.workspaceId, id, manifest.target.asset, manifest.target.integration, manifest.report,
        manifest.target.credentialRef, manifest.target.propertyRef, manifest.reportDate,
        manifest.requestedAt, finishedAt, manifest.status, manifest.dataState, SCHEMA_VERSION,
        manifest.providerRows, manifest.requestCount, manifest.providerTruncated, object.object_seq,
        null, null, cost.usd, cost.state,
      ]);
    }),
  );
}

async function recordDumpFailure(store: WorkspaceStore, manifest: ManifestFailure): Promise<void> {
  const id = crypto.randomUUID();
  const finishedAt = new Date().toISOString();
  const cost = manifest.knownZeroCost && (manifest.providerCostUsd === undefined || manifest.providerCostUsd === 0)
    ? { usd: 0, state: 'reported' as const }
    : storedProviderCost(manifest.target.integration, manifest.providerCostUsd ?? 0);
  await persistCollectionAttempt({
    target: manifest.target,
    monitoring: manifest.monitoring,
    attempt: {
      id, startedAt: manifest.requestedAt, finishedAt,
      source: 'signal_dump_runs', ok: false, code: manifest.error.code,
      report: manifest.report, reportDate: manifest.reportDate,
    },
  }, () =>
    store.write((tx) =>
      tx.execute(INSERT_RUN_SQL, [
        tx.workspaceId, id, manifest.target.asset, manifest.target.integration, manifest.report,
        manifest.target.credentialRef, manifest.target.propertyRef, manifest.reportDate,
        manifest.requestedAt, finishedAt, 'error', manifest.dataState, SCHEMA_VERSION,
        0, 0, false, null, manifest.error.code, manifest.error.message.slice(0, 500), cost.usd, cost.state,
      ]),
    ),
  );
}

/** The families this (property, integration) is actually due. A GA4 family that
 * reads event parameters is offered only where the operator has registered
 * them; everything else applies everywhere. */
function reportsFor(
  integration: GoogleIntegrationId,
  asset: string,
  config: Ga4CustomDimensionConfig,
): string[] {
  if (integration === 'gsc') return GSC_REPORTS.map((report) => report.name);
  return GA4_REPORTS.filter((report) =>
    ga4DimensionsRegistered(report, asset, config),
  ).map((report) => report.name);
}

function datesForReport(
  integration: GoogleIntegrationId,
  report: string,
  reportDates: string[],
): string[] {
  if (
    integration === 'ga4' &&
    reportSpec(GA4_REPORTS, report).latestOnly
  ) {
    return reportDates.slice(-1);
  }
  return reportDates;
}

/**
 * The revision window this (asset, report) actually costs today: the spec's own
 * window, narrowed to a single newest-date probe for an opted-in family whose
 * every completed run so far has returned nothing.
 */
async function resolveReportDates(
  store: WorkspaceStore,
  target: DumpTarget,
  integration: GoogleIntegrationId,
  report: string,
  reportDates: string[],
): Promise<string[]> {
  const dates = datesForReport(integration, report, reportDates);
  if (dates.length <= 1) return dates;
  const spec = reportSpec<DumpReportSpec>(
    integration === 'gsc' ? GSC_REPORTS : GA4_REPORTS,
    report,
  );
  if (!spec.probeWhenAlwaysEmpty) return dates;
  return (await everyCompletedRunWasEmpty(store, target.asset, integration, report))
    ? dates.slice(-1)
    : dates;
}

/**
 * True only when this (asset, report) has completed at least once and no
 * completed run has ever carried a row. Errors are not evidence of emptiness,
 * so they neither arm nor disarm the probe; a single non-empty run anywhere in
 * the history restores the full window permanently.
 */
async function everyCompletedRunWasEmpty(
  store: WorkspaceStore,
  asset: string,
  integration: DumpIntegration,
  report: string,
): Promise<boolean> {
  const [row] = await store.read((tx) =>
    tx.query<{ completed: number; maxRows: number }>(
      `SELECT count(*)::int AS completed, COALESCE(max(provider_rows), 0) AS "maxRows"
         FROM noticeos.archive_runs
        WHERE asset_id = $1 AND integration = $2 AND report = $3
          AND status IN ('success','unchanged')`,
      [asset, integration, report],
    ),
  );
  return (row?.completed ?? 0) > 0 && (row?.maxRows ?? 0) === 0;
}

function reportSpec<T extends { name: string }>(reports: T[], name: string): T {
  const report = reports.find((candidate) => candidate.name === name);
  if (!report) throw new SignalError('config_invalid', `Unknown Google signal report "${name}".`);
  return report;
}

function dataStateFor(integration: GoogleIntegrationId): DumpDataState {
  return integration === 'gsc' ? 'provider-final' : 'revision-window';
}

function completedDates(nowMs: number, count: number): string[] {
  const dates: string[] = [];
  const now = new Date(nowMs);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  // The scheduled 12:15 UTC run can safely call the previous UTC date for the
  // portfolio's continental-US property timezones. A manual/pre-cutoff replay
  // shifts back one more day rather than mislabeling a still-open local day as
  // completed.
  const latestOffset = now.getUTCHours() * 60 + now.getUTCMinutes() < 12 * 60 + 15 ? 2 : 1;
  for (let offset = latestOffset + count - 1; offset >= latestOffset; offset--) {
    dates.push(new Date(today - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

function dumpObjectKey(
  provider: DumpProvider,
  target: DumpTarget,
  report: string,
  reportDate: string,
  requestedAt: string,
  contentSha256: string,
): string {
  const runStamp = requestedAt.replace(/[-:.]/g, '');
  return [
    'raw',
    provider,
    target.integration,
    encodeURIComponent(target.asset),
    report,
    reportDate,
    `${runStamp}-${contentSha256.slice(0, 16)}.json.gz`,
  ].join('/');
}

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const compressed = new Blob([ownedBytes(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(compressed).arrayBuffer();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBytes(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return owned;
}

/** One earlier report date owed a re-collection. */
interface OwedArchiveDate {
  report: string;
  reportDate: string;
}

/** A run's re-collection pass (bead `ro-aed0.7`): what it may ask, and whether
 * it still may. */
interface ArchiveRetryPass {
  /** Per property, the owed dates this run asks for — oldest first, bounded. */
  dates: Map<GooglePropertyTarget, OwedArchiveDate[]>;
  /** Every owed date found, before the bound. */
  owed: number;
  /** False once this run has seen the connection fail: nothing more is asked. */
  open: boolean;
  halt(): void;
}

/**
 * The earlier GA4 / Search Console report dates an outage cost this lane, for
 * this run to ask again (bead `ro-aed0.7`).
 *
 * THE GAP. A run asks for the last four completed dates, so a date a dead night
 * missed is usually asked again the next day — but not always: the window's
 * oldest date falls out of it, and a family collected for the newest date only
 * (`events-28d`, a probing family) never comes back to that date at all. The
 * 2026-09-14 outage left 92 of those failing with nothing due to ask again.
 *
 * WHAT IS OWED — two records, and nothing else:
 *
 * - **A date whose LATEST attempt failed for a network reason**, by the same
 *   rule (`healthFailure`) that shows it as `network` on the Integrations
 *   page, so what the page calls a connection failure is exactly what is asked
 *   again. Anything the provider answered — a 403, a quota refusal, an
 *   unregistered dimension — is the provider's verdict and is never re-asked
 *   daily.
 * - **A date the dead uplink swallowed.** Such a date has no manifest
 *   (`ro-aed0.4`), so the open `os-egress-down` flag's `signal-dumps` entry
 *   names it instead, down to the date, until something asks for it.
 *
 * Only for a property and family this run still collects, on the same Google
 * property, and never a date the run's own window asks for anyway — nor one
 * newer than its newest completed date, which may still be an open US day.
 * Oldest first, at most `limit` a run: a long outage drains over several days
 * rather than doubling one tick.
 */
async function owedArchiveDates(
  env: IngestEnv,
  targets: GooglePropertyTarget[],
  plans: Map<GooglePropertyTarget, Map<string, string[]>>,
  latestCompleted: string,
  limit: number,
): Promise<ArchiveRetryPass> {
  const owed = new Map<string, { target: GooglePropertyTarget } & OwedArchiveDate>();
  const targetFor = (asset: string, integration: string) =>
    targets.find((target) => target.asset === asset && target.integration === integration);
  const consider = (target: GooglePropertyTarget | undefined, report: string, reportDate: string) => {
    if (target === undefined || reportDate > latestCompleted) return;
    const planned = plans.get(target)?.get(report);
    if (planned === undefined || planned.includes(reportDate)) return;
    owed.set(archivePartKey(target.asset, archivePart(target.integration, report, reportDate)), {
      target,
      report,
      reportDate,
    });
  };

  for (const row of await networkFailedArchiveDates(env.STORE, ['ga4', 'gsc'])) {
    const target = targetFor(row.asset, row.integration);
    if (target?.propertyRef === row.propertyRef) consider(target, row.report, row.reportDate);
  }
  const entry = await openEgressLaneRecord(env, 'signal-dumps');
  for (const [asset, parts] of Object.entries(entry?.parts ?? {})) {
    for (const part of parts) {
      const dated = parseArchivePart(part);
      if (dated !== null) consider(targetFor(asset, dated.integration), dated.report, dated.reportDate);
    }
  }

  const ordered = [...owed.values()].sort(
    (a, b) =>
      a.reportDate.localeCompare(b.reportDate) ||
      a.target.asset.localeCompare(b.target.asset) ||
      a.target.integration.localeCompare(b.target.integration) ||
      a.report.localeCompare(b.report),
  );
  const dates = new Map<GooglePropertyTarget, OwedArchiveDate[]>();
  for (const { target, report, reportDate } of ordered.slice(0, Math.max(0, limit))) {
    const list = dates.get(target) ?? [];
    list.push({ report, reportDate });
    dates.set(target, list);
  }
  const pass: ArchiveRetryPass = {
    dates,
    owed: owed.size,
    open: true,
    halt() {
      pass.open = false;
    },
  };
  return pass;
}

/**
 * Report dates of these lanes whose latest attempt failed for a network reason
 * — GA4 / Search Console, whose provider can be asked for a past date. PostHog
 * reads a wider rule of its own (`owedWindows`, src/posthog-dumps.ts, beads
 * `ro-aed0.8`, `ro-aed0.9`). The ILIKE filter only narrows the scan to codes
 * that could be one (case-blind, as D1's LIKE was); `networkFailure` is the
 * rule.
 */
export async function networkFailedArchiveDates(
  store: WorkspaceStore,
  integrations: readonly DumpIntegration[],
): Promise<{ asset: string; integration: string; propertyRef: string; report: string; reportDate: string }[]> {
  const rows = await store.read((tx) =>
    tx.query<{
      asset: string;
      integration: string;
      propertyRef: string;
      report: string;
      reportDate: string;
      errorCode: string | null;
    }>(
      `SELECT e.asset_id AS asset, e.integration,
              e.property_ref AS "propertyRef", e.report,
              e.report_date AS "reportDate", e.error_code AS "errorCode"
         FROM noticeos.archive_runs e
        WHERE e.integration = ANY($1::text[])
          AND e.status = 'error'
          AND (e.error_code ILIKE '%timeout%' OR e.error_code ILIKE '%network%'
               OR e.error_code ILIKE '%request_failed%' OR e.error_code ILIKE '%unreachable%')
          AND NOT EXISTS (
            SELECT 1 FROM noticeos.archive_runs later
             WHERE later.workspace_id = e.workspace_id AND later.asset_id = e.asset_id
               AND later.integration = e.integration AND later.report = e.report
               AND later.report_date = e.report_date AND later.property_ref = e.property_ref
               AND later.requested_at > e.requested_at
          )`,
      [[...integrations]],
    ),
  );
  return rows.filter((row) => networkFailure(row.errorCode));
}

/** A failure the Integrations page shows as `network` — the provider never
 * answered. The one kind of failed date a dated archive asks about again. */
export function networkFailure(code: string | null): boolean {
  return code !== null && healthFailure(code).failure === 'network';
}

/** The archives whose provider can be asked for a past date: GA4 and Search
 * Console name the date, PostHog bounds every query to its window (`ro-aed0.8`). */
type DatedArchive = 'ga4' | 'gsc' | 'posthog';
const DATED_ARCHIVES: ReadonlySet<DumpIntegration> = new Set<DatedArchive>(['ga4', 'gsc', 'posthog']);

/**
 * What one owed collection is called on its collector's flag entry:
 * `ga4:events-28d:2026-09-13` for a GA4 / Search Console family and
 * `posthog:events:2026-09-13` for a PostHog window end, whose date can be asked
 * for again; the bare family for anything else, whose provider only ever
 * answers with its current state.
 */
export function archivePart(integration: DumpIntegration, report: string, reportDate: string): string {
  return DATED_ARCHIVES.has(integration) ? `${integration}:${report}:${reportDate}` : report;
}

/** A dated part back into its pieces; null for a bare family or anything else. */
export function parseDatedArchivePart(
  part: string,
): { integration: DatedArchive; report: string; reportDate: string } | null {
  const match = /^(ga4|gsc|posthog):([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(part);
  if (match === null) return null;
  return { integration: match[1] as DatedArchive, report: match[2]!, reportDate: match[3]! };
}

function parseArchivePart(
  part: string,
): { integration: GoogleIntegrationId; report: string; reportDate: string } | null {
  const dated = parseDatedArchivePart(part);
  return dated === null || dated.integration === 'posthog' ? null : { ...dated, integration: dated.integration };
}

export function archivePartKey(asset: string, part: string): string {
  return `${asset}\u0000${part}`;
}

/**
 * A family the dead uplink swallowed (beads `ro-aed0.3`, `ro-aed0.4`): noted on
 * the run's gate, which names the property on its one `os-egress-down` flag, and
 * NOWHERE ELSE. No manifest row means no provider-blaming sentence on the
 * property's card, no Health observation, and — because only a success or
 * unchanged row satisfies a cadence — a family that is still due for the next
 * run to collect.
 */
export function unmeasuredDumpOutcome(
  gate: EgressGate,
  target: DumpTarget,
  report: string,
  reportDate: string,
): SignalDumpOutcome {
  // Named down to the family, so the flag can say exactly what the outage
  // skipped — the DataForSEO daily re-collection runs from that list
  // (`ro-aed0.6`) — and, for a GA4 / Search Console family or a PostHog window,
  // down to the DATE, which that lane's own re-collection asks for again
  // (`ro-aed0.7`, `ro-aed0.8`).
  gate.recordUnmeasured(target.asset, archivePart(target.integration, report, reportDate));
  return {
    asset: target.asset,
    integration: target.integration,
    report,
    reportDate,
    status: 'error',
    providerRows: 0,
    providerTruncated: false,
    objectKey: null,
    errorCode: EGRESS_DOWN_CODE,
    egressDown: true,
  };
}

function failedOutcome(
  target: DumpTarget,
  report: string,
  reportDate: string,
  error: SignalError,
): SignalDumpOutcome {
  return {
    asset: target.asset,
    integration: target.integration,
    report,
    reportDate,
    status: 'error',
    providerRows: 0,
    providerTruncated: false,
    objectKey: null,
    errorCode: error.code,
  };
}

/** Provider-neutral failure boundary for collectors that reuse this archive
 * store. The error attempt is durable even when no R2 object was produced. */
export async function archiveDumpFailure(
  store: WorkspaceStore,
  input: {
    monitoring?: CollectionMonitoring;
    target: DumpTarget;
    report: string;
    reportDate: string;
    requestedAt: string;
    dataState: DumpDataState;
    error: SignalError;
    providerCostUsd?: number;
    knownZeroCost?: true;
  },
): Promise<SignalDumpOutcome> {
  await recordDumpFailure(store, {
    ...input,
    providerCostUsd: input.providerCostUsd ?? 0,
  });
  return failedOutcome(
    input.target,
    input.report,
    input.reportDate,
    input.error,
  );
}

function googleProviderError(prefix: string, status: number, body: unknown): SignalError {
  const record = asRecord(body);
  const nested = asRecord(record?.error);
  const message =
    stringField(nested, 'message') ?? `Google request failed with HTTP ${status}.`;
  return new SignalError(`${prefix}_http_${status}`, message.slice(0, 500));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function arrayField(record: Record<string, unknown> | null, field: string): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Read-only expansion of the same family/date policy used by collection. */
export async function integrationArchivePlan(store: WorkspaceStore, target: GooglePropertyTarget, nowMs: number, config: Ga4CustomDimensionConfig = GA4_CUSTOM_DIMENSIONS): Promise<{ report: string; date: string; cadenceDays: number }[]> {
  const dates = completedDates(nowMs, DEFAULT_REVISION_DAYS);
  const entries = await Promise.all(reportsFor(target.integration, target.asset, config).map(async report =>
    (await resolveReportDates(store, target, target.integration, report, dates)).map(date => ({ report, date, cadenceDays: 1 }))));
  return entries.flat();
}
export const BING_ARCHIVE_FAMILIES = BING_REPORTS.map(spec => ({ report: spec.name, cadenceDays: spec.cadenceDays ?? 1 }));
