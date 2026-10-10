import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, persistCollectionAttempt, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
// Analysis-grade GA4, Search Console and Bing Webmaster archives, separate
// from the 15-minute chart aggregates: a short completed-day revision window,
// bounded raw provider responses as gzip JSON in private R2, and append-only
// manifests (`noticeos.archive_runs` naming `noticeos.archive_objects`).
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
  boundedResponseJson,
  normalizeSignalError,
  reportDateOffset,
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
import { arrayField, asRecord, sha256Hex, stringField, wholeUtcDaysBetween } from './shared.js';

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
 * outage: about one dead night's leftovers for a small portfolio, so a longer
 * outage drains over the following days instead of doubling one run.
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
 * Whether `config/ga4-custom-dimensions.json` records the operator having
 * registered every `customEvent:` dimension the spec needs. A property it does
 * not cover is skipped entirely: absence of config is not a failed collection.
 * This does not retire `ga4_custom_dimension_unregistered`: registration is
 * forward-only, and the file is a hand-maintained claim about a system it
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
   * Once every completed run for an (asset, report) has come back with zero
   * rows, ask only the newest completed date, enough to notice the family
   * turning on; the full window resumes on any non-empty run. The first-ever
   * run always takes the full window.
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
  /** A GA4 `FilterExpression`, sent verbatim and archived with every request so
   * the stored rows carry the population they describe. */
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
   * How often the provider refreshes this family, in whole days; omitted means
   * every day. A weekly family asked daily answers six of seven calls with the
   * same snapshot. See `dueBingReports` for how "once" is decided.
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

// Durable GA4 report families rather than the UI's current CSV layout.
// Expressions are stored with every request so later analysis can reproduce
// what a metric meant at collection time.
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
    // The triage half of the `javascript-errors` card: `message` and `source`
    // next to the page. GA4 only answers for an event parameter registered as
    // a custom dimension and backfills nothing before that, so an empty window
    // can mean "no errors" or "not collecting yet";
    // `ga4_custom_dimension_unregistered` keeps those apart.
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
    // A property whose pages never throw answers every revision date empty.
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

/** Microsoft's own refresh interval for the top-query and top-page snapshots. */
const BING_WEEKLY = 7;

const BING_INTEGRATION: DumpIntegration = 'bing-webmaster';

// Rank/traffic and the crawl families are daily provider series. The query and
// page families are one snapshot Microsoft rebuilds weekly.
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
  /** What the provider said this collection cost, where it meters a budget
   * (GA4). Carried beside the pages, never inside the content hash. */
  quota?: Ga4PropertyQuota | null;
  /** The pages as the content hash sees them, when a page carries a field that
   * changes on every call. Archived bytes are always `pages`. */
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
  /** What the collection cost us, absent from the canonical bytes the content
   * hash is taken over because it changes on every call. */
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
  /** (property, family) pairs this run did not ask for because the provider
   * had not refreshed them yet; today only, never a running total. */
  skipped: number;
  /** Earlier report dates this run asked for again because an outage cost
   * them, already counted in `attempted` and `outcomes`. */
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
  /** Override the compiled-in config/integrations.json mapping (tests). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file; reported on the completion line. */
  configSources?: ConfigSourceMap;
  /** The operator's saved clock, assumed for a GA4 property that states no
   * zone of its own. Absent: the zone compiled into this Worker. */
  osTimeZone?: string;
  /** Override the run's egress gate (tests control the verdict TTL). */
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
  // One gate per run, asked only about a provider call that came back with no
  // status; its beacons use the raw fetcher. Without it one failed token mint
  // would write a `request_failed` manifest for every target x family x date.
  const egress: EgressLane = {
    gate: options.egress ?? new EgressGate(env, { lane: 'signal-dumps', fetchImpl, at: requestedAt }),
    transport: watchTransport(fetchImpl),
  };
  const providerFetch = egress.transport.fetch;
  const ga4CustomDimensions = options.ga4CustomDimensions ?? GA4_CUSTOM_DIMENSIONS;
  // Store first, legacy env binding second, for both halves of this lane.
  const google = await resolveGoogleCredential(env);
  const googleHealth = await tryHealthConnection(env, 'google', google.credential, [google.oauth?.clientId ?? '', google.oauth?.clientSecret ?? '']);
  const googleMonitoring = beginCollection(env.STORE, googleHealth);
  const googleSource: CredentialSource =
    options.rawConfig === undefined ? google.source : 'env';
  const googleAccounts = options.rawConfig ?? google.accounts;
  // The register first, the credential blob second. An install with nothing
  // mapped, or with Google not connected, archives nothing rather than failing
  // every family; a property its Data sources row declines is not archived.
  const targets = googleTargets(
    { accounts: googleAccounts, oauth: google.oauth, connected: google.connected },
    googleSource,
    googleCredentialResolver(env),
    options.laneRegister,
    options.osTimeZone,
  ).filter((target) => !laneDeclined(target.asset, target.integration, options.laneRegister));
  const outcomes: SignalDumpOutcome[] = [];
  // Every (property, family) -> the dates this run asks for, resolved before
  // this run writes any manifests, so a probe day's zero-row result cannot
  // narrow the same run's window.
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
  // The earlier dates an outage cost this lane, capped.
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
        // The same walk either way, but a dead uplink records none of these
        // against the provider, and the owed earlier dates are not walked.
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

      // The owed earlier dates go first, so the newest manifest of every family
      // is still this run's own window, which the Tower reads as current.
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
          // A connection that is down stops the pass after one ask: the rest
          // stay owed for the next run.
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
  // Bing not connected at all is no work, not a failure per site and family.
  // A caller that passed a key is a test: `env`.
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
  // obligation leaves it only once something asked for that exact date and
  // heard back, however many runs that takes. An undated part (a Bing family)
  // is answered by this run's own snapshot.
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
      // Per file: `store` when the run read the document an operator saved,
      // `file` when it read the compiled copy. The words only; never a document.
      ...configSourceLine(options.configSources, [
        'config/integrations.json',
        'config/ga4-custom-dimensions.json',
      ]),
      // Named for its reason, so a smaller `attempted` reads as "nothing new"
      // rather than as lost coverage.
      skippedNotDue: result.skipped,
      // Earlier dates asked again, and how many owed ones were left.
      retried: result.retried,
      retryNotAsked: retry.owed - result.retried,
      // Provider failures only: an unmeasured family is never listed as the
      // provider's error.
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
  // A site its Data sources row declines (Not using) owes no archive.
  const candidates = (await loadBingPortfolioCandidates(env.STORE))
    .filter((candidate) => !laneDeclined(candidate.asset, 'bing-webmaster', laneRegister));
  // What this run owes, decided before it writes a single manifest, so today's
  // archive can never satisfy today's own cadence check. A family that is not
  // due is not one of this run's reports, so the credential and
  // unverified-site failures do not invent an attempt for it.
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
    // property per due family; returning before the site loop keeps
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
    // The register first, the verified-site domain match second.
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
 * The BWT families this property owes for `reportDate`. A daily family is
 * always due; a family on a longer cadence is due when the newest date it has
 * ever archived is at least that many days behind. Measured from archives, not
 * the calendar, so a missed run does not push the family a further week out;
 * only `success`/`unchanged` rows count, so a failure never satisfies a
 * cadence; and skipping writes nothing, so "we asked and it was the same" stays
 * distinguishable from "we did not ask".
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
    return wholeUtcDaysBetween(latest, reportDate) >= cadenceDays;
  });
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
      // The quota flag is this machine's store too: its failure must not read
      // as Google unreachable.
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
 * The code an attempt carries when the provider answered but this machine
 * could not keep the answer. `healthFailure` files it as `monitoring`, the
 * OS's own fault, and it is never re-asked daily.
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
  // Everything below is this machine's work, so anything it throws is the
  // store's fault and is named as such.
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
  // Bing Webmaster and Clarity share this provider; the report name carries the rest.
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
    const body = await boundedResponseJson(response, 'Google', RESPONSE_BYTE_LIMIT);
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
  // The last page's quota: the newest reading is the only one that describes
  // the budget as it stands when the family finishes.
  let quota: Ga4PropertyQuota | null = null;

  while (providerRows < GA4_REPORT_ROWS) {
    const windowDays = spec.windowDays ?? 1;
    const startDate = reportDateOffset(reportDate, -(windowDays - 1));
    const request: Record<string, unknown> = {
      dateRanges: [{ startDate, endDate: reportDate }],
      dimensions: spec.dimensions.map((name) => ({ name })),
      metrics: spec.metrics,
      keepEmptyRows: true,
      limit: String(GA4_PAGE_ROWS),
      offset: String(providerRows),
      // Asking changes the archived request, which is why it is part of the
      // content hash while the answer is lifted out below.
      returnPropertyQuota: true,
    };
    if (spec.dimensionFilter) request.dimensionFilter = spec.dimensionFilter;
    const response = await fetchImpl(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
      googlePost(accessToken, request),
    );
    const body = await boundedResponseJson(response, 'Google', RESPONSE_BYTE_LIMIT);
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
    // The quota block is the one field lifted out of a response before it is
    // archived: `consumed` moves on every call, so leaving it in would put it in
    // the content hash and every GA4 archive would read as changed forever.
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
 * rate limit. Both arrive as 429; only one needs an operator.
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
 * custom dimension is not a queryable field. A generic 400 would send the
 * operator to check credentials, and a zero-row success would say this
 * property throws no errors. Null for any other failure.
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
  // Google has worded this several ways; all of them name the offending field.
  if (!/not a valid dimension|is not registered|did not match/i.test(message)) {
    return null;
  }
  const named = custom.filter((dimension) => message.includes(dimension));
  if (named.length === 0) return null;
  // The state and its one fix, then Google's own words.
  return new SignalError(
    'ga4_custom_dimension_unregistered',
    `No GA4 custom dimension ${named.join(', ')} · register it in GA4 admin · Google: ${message}`,
  );
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

/**
 * The object this exact content is already stored under, for this exact report
 * date. `report_date` is in the WHERE and inside the hashed bytes, so two
 * consecutive dates carrying a byte-identical answer each write their own
 * object: the dedup catches a re-fetch, not a snapshot that has not moved since
 * yesterday. Reaching across dates would stamp day two's rows with day one's
 * envelope date.
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
 * The stored object a run names, recorded once per key: its number back. A key
 * already recorded with the same content is that object (an unchanged run
 * names the object an earlier run stored); a key recorded with other content
 * answers no row, and the run is refused.
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

/** One attempt: a failed run names no object and states its error. */
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

/** The families this (property, integration) is due. A GA4 family that reads
 * event parameters is offered only where the operator has registered them. */
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
 * The revision window this (asset, report) costs today: the spec's own window,
 * narrowed to a newest-date probe for an opted-in family whose every completed
 * run so far has returned nothing.
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
 * completed run has ever carried a row. Errors neither arm nor disarm the
 * probe; a single non-empty run restores the full window permanently.
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
  // After 12:15 UTC the previous UTC date is complete for continental-US
  // property timezones. An earlier replay shifts back one more day rather than
  // mislabeling a still-open local day as completed.
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

/** A run's re-collection pass: what it may ask, and whether it still may. */
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
 * The earlier GA4 / Search Console report dates an outage cost this lane. A run
 * asks for the last four completed dates, so a missed date is usually asked
 * again the next day, but the window's oldest date falls out of it and a
 * `latestOnly` or probing family never comes back to it. Owed: a date whose
 * latest attempt failed for a network reason (`healthFailure`'s `network`), and
 * a date the dead uplink swallowed, which the open `os-egress-down` flag names.
 * Anything the provider answered is its verdict and is never re-asked. Only for
 * a property and family this run still collects, on the same Google property,
 * never a date the run's own window asks for, nor one newer than its newest
 * completed date. Oldest first, at most `limit` a run.
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
 * Report dates of these lanes whose latest attempt failed for a network reason.
 * The ILIKE filter only narrows the scan; `networkFailure` is the rule.
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

/** A failure the Integrations page shows as `network`: the provider never
 * answered. The one kind of failed date a dated archive asks about again. */
export function networkFailure(code: string | null): boolean {
  return code !== null && healthFailure(code).failure === 'network';
}

/** The archives whose provider can be asked for a past date. */
type DatedArchive = 'ga4' | 'gsc' | 'posthog';
const DATED_ARCHIVES: ReadonlySet<DumpIntegration> = new Set<DatedArchive>(['ga4', 'gsc', 'posthog']);

/**
 * What one owed collection is called on its collector's flag entry:
 * `ga4:events-28d:2026-09-13` or `posthog:events:2026-09-13` for a dated
 * archive; the bare family for anything else, whose provider only answers with
 * its current state.
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
 * A family the dead uplink swallowed: noted on the run's gate, which names the
 * property on its one `os-egress-down` flag, and nowhere else. No manifest row
 * means no provider-blaming sentence, no Health observation, and a family that
 * is still due for the next run.
 */
export function unmeasuredDumpOutcome(
  gate: EgressGate,
  target: DumpTarget,
  report: string,
  reportDate: string,
): SignalDumpOutcome {
  // Named down to the family, and for a dated archive down to the date, so
  // each lane's re-collection can ask for exactly what the outage skipped.
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
