import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CollectNowInput, CollectNowResult, ConnectCredentialResult, CreateAssetResult, MoveAssetResult, CredentialProbe, CredentialStoreState,
  GoogleOAuthCompletion, GoogleOAuthStart, GooglePropertyDiscovery,
  CredentialSummary, DeleteCredentialResult, IntegrationHealthPayload, IntegrationProviderId, MediavineResult, MediavineStatus,
  MediavineSync, PutCredentialInput, PutCredentialResult, PutSiteTokenInput, PutSiteTokenResult, SiteDiscovery,
} from "@noticeos/contract";
import type { ConfigWriteMismatch, JsonValue } from "@noticeos/contract/configuration";
import { savedOsTimeZone } from "@noticeos/contract/time-zone-setting";
import { gateTitle } from "@noticeos/contract/task-gate";
import { revenueCalendarDate } from "../shared/daily-revenue";
import { MEDIAVINE_REPORTING_CLOCK } from "../shared/daily-revenue";
import { revenueExpectedThrough, shiftRevenueDate } from "../shared/revenue-projection";
import { bookLedger } from '../test/money';
import { writeInsightSnapshots } from '../test/provider-reports';
import { seedRevenueHistory, syntheticRevenueDay, syntheticRevenueHolidays } from '../test/revenue-fixture';
import { MISSING, applyDocumentOps, configDocumentKey, resolveOps, validateSchemaAndSafety, type Changeset, type Mismatch } from "../../../scripts/config-documents.mjs";
import { attachTestCluster, type TestClusterHandle } from "../../../scripts/postgres-test-copies.mjs";
import { openWorkspaceStore, type WorkspaceStore } from "@noticeos/postgres";
import worker, { type TowerEnv } from "../worker/index";
import { compiledConfig } from "../worker/compiled-config";
import { configWriteStatus } from "../worker/config-route";
import { towerConfigResolver } from "../worker/config-source";
import { recordConnectionStatusDay } from "../worker/connection-status-daily";
import { HOURLY_TICK, runTowerCron } from "../worker/tower-cron";
import { handleTasksRequest, ownsPath, readSpokes, type BdResult } from "../vite/task-lane";
import {
  WALL_FEED_INJECTED_TEXT, WALL_FEED_SITES_ADDED_AT, injectWallFeedEvent, seedWallFeedAlertsAndReports, seedWallFeedChanges,
  seedWallFeedProviderReports, seedWallFeedRevenue, seedWallFeedRuns, seedWallFeedTasks, wallFeedSites,
} from "./wall-feed-fixture";
import {
  EVERY_SOURCE_CATALOG, INITIAL_DOCUMENTS, JOURNEY_ARCHIVED_SITE, JOURNEY_ASSET, JOURNEY_COUNTER_CARDS, JOURNEY_CREDENTIALS_KEY, JOURNEY_KEY, JOURNEY_NOW,
  JOURNEY_FINDING_KEY, JOURNEY_SITE, JOURNEY_TASK_PROJECT, JOURNEY_CORE_PROJECT, JOURNEY_TIME_ZONE, initialTasks, journeyFindingSnapshot,
  journeyPosthogSnapshot, journeySerpPanelSnapshot,
} from "./fixtures";

/** The ingest's own environment, as its code reads it here: the fixture store
 * and the synthetic store key. No provider binding, so nothing falls back to
 * an environment credential. */
export interface JourneyIngestEnv {
  NOTICEOS_WORKSPACE_PROFILE: "standalone";
  CREDENTIALS_KEY: string; RAW_SIGNALS: JourneyBucket;
  /** This fixture's own Postgres copy (journeyPostgres below): the call's
   * store the production ingest code reads its settings from, as a Worker
   * call's is (workers/ingest/src/call-store.ts). */
  STORE: WorkspaceStore;
  /** A hosted installation's own Google OAuth client: present only after
   * `/__journey/google-hosted`, a synthetic client the fixture's Google
   * network accepts, never a real one. */
  GOOGLE_OAUTH_CLIENT_ID?: string; GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

/** The slice of an R2 bucket the archive lanes call (put a report, read a
 * checkpoint back): the fixture's disposable, in-memory raw-signal store. */
export interface JourneyBucket {
  put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: unknown): Promise<{ key: string; size: number }>;
  get(key: string): Promise<{ size: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

function journeyBucket(): JourneyBucket {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
    },
  };
}
interface JourneyHealthConnection { provider: IntegrationProviderId; revision: string; configured: boolean; changedAt: string | null }
interface JourneyCollectionMonitoring { readonly connection: Readonly<JourneyHealthConnection> | null; readonly store: WorkspaceStore; available: boolean }

/** Production ingest functions, run over the fixture store as they are. server.mjs
 * loads them through Vite and hands them over unchanged; their Worker types stay
 * out of the Tower's typecheck, so these are the shapes this file relies on. */
export interface JourneyIngest {
  /** workers/ingest/src/config-store.ts: the settings read cache, forgotten
   * after the fixture copies its documents in (this server's clock never
   * moves, so the cache's one second never passes). */
  forgetConfigCache(store?: WorkspaceStore): void;
  /** workers/ingest/src/asset-state.ts */
  createAsset(env: JourneyIngestEnv, body: unknown, nowMs: number): Promise<CreateAssetResult>;
  moveAsset(env: JourneyIngestEnv, body: unknown, nowMs: number): Promise<MoveAssetResult>;
  /** workers/ingest/src/integration-health-read.ts: the `integrationHealth()` RPC's whole body. */
  readIntegrationHealth(env: JourneyIngestEnv, nowMs: number): Promise<IntegrationHealthPayload>;
  /** workers/ingest/src/credential-summaries-read.ts: the `listCredentialSummaries()` RPC's whole body. */
  readCredentialSummaries(env: JourneyIngestEnv): Promise<CredentialStoreState>;
  /** workers/ingest/src/credentials.ts */
  putCredential(env: JourneyIngestEnv, input: PutCredentialInput): Promise<PutCredentialResult>;
  /** workers/ingest/src/credential-connect.ts: the connect panel's save and
   * test, run unchanged; only the provider's network answer is the fixture's. */
  connectCredential(env: JourneyIngestEnv, input: PutCredentialInput, options: { fetchImpl: typeof fetch; nowMs: number }): Promise<ConnectCredentialResult>;
  /** workers/ingest/src/site-tokens.ts: one site's token merged into its
   * provider's per-site map, run unchanged. */
  putSiteToken(env: JourneyIngestEnv, input: PutSiteTokenInput): Promise<PutSiteTokenResult>;
  deleteCredential(env: JourneyIngestEnv, provider: string): Promise<DeleteCredentialResult>;
  recordCredentialOutcome(env: JourneyIngestEnv, provider: IntegrationProviderId, outcome: { ok: boolean; error?: string | null; at?: string }): Promise<void>;
  /** workers/ingest/src/integration-health-context.ts */
  tryHealthConnection(env: JourneyIngestEnv, provider: IntegrationProviderId): Promise<JourneyHealthConnection | null>;
  observeIntegration(env: JourneyIngestEnv, connection: JourneyHealthConnection | null, input: {
    capability: string; asset?: string; target?: string; observedAt: string; ok: boolean; code?: string;
    attemptId?: string; evidenceSource: "probe" | "mediavine_runs";
  }): Promise<boolean>;
  /** workers/ingest/src/collection-attempt.ts */
  beginCollection(store: WorkspaceStore, connection: JourneyHealthConnection | null): JourneyCollectionMonitoring;
  recordCollectedHealth(collected: {
    target: { asset: string; integration: string; propertyRef: string };
    attempt: { id: string; startedAt: string; finishedAt: string; source: "signal_runs"; ok: boolean };
    monitoring: JourneyCollectionMonitoring;
  }): Promise<boolean>;
  /** workers/ingest/src/site-discovery.ts: the `discoverSites()` RPC's whole
   * body; only the provider's network answer is the fixture's. */
  discoverSites(env: JourneyIngestEnv, provider: string, options: { fetchImpl: typeof fetch; nowMs: number }): Promise<SiteDiscovery>;
  /** workers/ingest/src/dispatch.ts: the `collectNow()` RPC's whole body, the
   * scheduled job's own lane step run for the confirmed sites; only the
   * provider's network answer is the fixture's. */
  runCollectNow(env: JourneyIngestEnv, input: CollectNowInput, options: { fetchImpl: typeof fetch; nowMs: number }): Promise<CollectNowResult>;
  /** workers/ingest/src/hygiene.ts: the hourly tick's uptime step, the OS
   * fetching each site's home page; only the site's answer is the fixture's. */
  runUptimeChecks(env: JourneyIngestEnv, options: { fetchImpl: typeof fetch; nowMs: number; confirmWaitMs?: number }): Promise<{ checked: number; retried: number; fired: number; resolved: number }>;
  /** workers/ingest/src/credential-probes.ts: the `probeCredential()` RPC's
   * whole body, Test connection's result. */
  probeCredential(env: JourneyIngestEnv, provider: string, options: { fetchImpl: typeof fetch; nowMs: number }): Promise<CredentialProbe>;
  /** workers/ingest/src/google-oauth.ts: signing in to Google, run unchanged;
   * Google's consent screen is the walk's own redirect and Google's token
   * endpoint the fixture's network. */
  beginGoogleOAuth(env: JourneyIngestEnv, input: { origin: string; nowMs: number }): Promise<GoogleOAuthStart>;
  completeGoogleOAuth(env: JourneyIngestEnv, input: { code: string; state: string; redirectUri: string; nowMs: number; fetchImpl: typeof fetch }): Promise<GoogleOAuthCompletion>;
  /** workers/ingest/src/credential-probes.ts: what the Google account lists. */
  discoverGoogleProperties(env: JourneyIngestEnv, options: { fetchImpl: typeof fetch; nowMs: number }): Promise<GooglePropertyDiscovery>;
  /** workers/ingest/src/mediavine.ts: a site's revenue status, its sync
   * (Refresh, a backfill) and Disconnect, run unchanged; only Mediavine's
   * network answer is the fixture's. */
  mediavineStatus(env: JourneyIngestEnv, asset: string): Promise<MediavineStatus>;
  syncMediavine(env: JourneyIngestEnv, input: MediavineSync, options: { fetchImpl: typeof fetch; nowMs: number }): Promise<MediavineResult<MediavineStatus>>;
  disconnectMediavine(env: JourneyIngestEnv): Promise<DeleteCredentialResult>;
  /** workers/ingest/src/google-auth.ts: what a collection stamps on the
   * Google credential when Google revokes the sign-in. */
  GOOGLE_OAUTH_REVOKED_MESSAGE: string;
  /** The lanes whose own words the Tower draws after a failure, run unchanged
   * over the fixture store; only the provider's or the site's answer is the
   * fixture's. workers/ingest/src/ notifier.ts, hygiene.ts, ga4-quota.ts,
   * time-zone-change.ts, signal-store.ts, routes/watch-windows.ts and
   * watch-windows.ts. */
  runNotifier?(env: JourneyIngestEnv, options: { nowMs: number; fetchImpl: typeof fetch }): Promise<unknown>;
  runHygieneChecks?(env: JourneyIngestEnv, options: { assets: { asset: string; domain: string }[]; fetchImpl: typeof fetch; nowMs: number }): Promise<unknown>;
  recordGa4Quota?(env: JourneyIngestEnv, input: {
    asset: string; lane: "google-signals" | "signal-dumps"; propertyRef: string; at: string;
    quota: { tokensPerDay: { consumed: number | null; remaining: number | null } | null; tokensPerHour: { consumed: number | null; remaining: number | null } | null };
  }): Promise<unknown>;
  recordTimeZoneChange?(env: JourneyIngestEnv, change: { asset: string; integration: string; from: string; to: string; effectiveOn: string }): Promise<{ filed: boolean; error?: string }>;
  recordSignalSuccess?(env: JourneyIngestEnv, target: { asset: string; integration: string; credentialRef: string; propertyRef: string },
    window: { start: string; end: string }, requestedAt: string, result: {
      providerRows: number; observations: { date: string; metric: string; value: number }[];
      dataState: "final"; provisionalFrom: null; timeZone: string;
    }): Promise<unknown>;
  writeWatchWindow?(env: JourneyIngestEnv, input: Record<string, unknown>, nowMs: number): Promise<{ ok: boolean }>;
  runWatchWindows?(env: JourneyIngestEnv, nowMs: number): Promise<unknown>;
  /** workers/ingest/src/pull.ts: the nightly report fetch, run unchanged;
   * only the site's answer is the fixture's. */
  runPullAdapter?(env: JourneyIngestEnv & { ASSET_TOKENS: string }, options: {
    entries: { asset: string; url: string; enabled: boolean; format: "envelope" }[];
    fetchImpl: typeof fetch; nowMs: number;
  }): Promise<{ outcomes: { ok: boolean; status: number | null; evidence?: string }[] }>;
}

/**
 * The journey's isolated Postgres store: a copy of the run's template for this
 * server alone, asked of the run's copy service
 * (scripts/postgres-test-copies.mts).
 *
 * A reset takes another copy and never waits on the one before: the copy the
 * last test used is given back without waiting (the copy service ends its
 * sessions and takes its name away), and the next test gets a copy under a new
 * name. A copy that cannot be taken back stays in the run's cluster, which is
 * deleted when the run ends. The server's own store on that copy closes
 * first, so work the last test left running finishes rather than has its
 * connection ended under it.
 */
function journeyPostgres(handle: TestClusterHandle) {
  const cluster = attachTestCluster(handle);
  let database: string | null = null;
  let store: WorkspaceStore | null = null;
  const current = () => {
    if (database === null || store === null) throw new Error("The journey's Postgres copy is not ready: await harness.ready() first");
    return { url: cluster.url(database), store };
  };
  return {
    current,
    /** A copy of its own, answering: a reset that says it is done has a store
     * the next test reaches, or it fails naming why. */
    async ready() {
      database ??= await cluster.createDatabase();
      store ??= openWorkspaceStore(cluster.url(database));
      await store.workspaceId();
    },
    async reset() {
      const [used, usedStore] = [database, store];
      database = null;
      store = null;
      await usedStore?.close().catch(() => undefined);
      if (used !== null) void cluster.releaseDatabase(used).catch(() => undefined);
      await this.ready();
    },
    async close() {
      await store?.close();
      store = null;
      if (database !== null) await cluster.dropDatabase(database);
      database = null;
    },
  };
}

/** A Tower call's context: it closes its call's store through it. */
const CALL_CONTEXT = { waitUntil: (work: Promise<unknown>) => void work.catch(() => undefined) };

/** The synthetic DataForSEO API login (an account name, not a secret). */
export const JOURNEY_DATAFORSEO_LOGIN = "journey-login";

/**
 * The providers' side of the network, for the connect panel's save and test:
 * the production ingest code sends its real requests here instead of the
 * internet. Bing Webmaster's GetUserSites lists the
 * journey's verified site for the synthetic key only; DataForSEO's free
 * account endpoint answers the synthetic login and key with a prepaid credit.
 * Anything else is refused the way each provider refuses it, and any other
 * address is a network failure — nothing leaves this process.
 */
export const journeyProviderNetwork: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://ssl.bing.com" && url.pathname.startsWith("/webmaster/api.svc/json/")) {
    if (url.searchParams.get("apikey") !== JOURNEY_KEY) return Response.json({ ErrorCode: 3, Message: "InvalidApiKey" }, { status: 400 });
    if (url.pathname.endsWith("/GetUserSites")) return Response.json({ d: JOURNEY_BING_SITES });
    // The first collection: the same 35 days of clicks and impressions
    // `/__journey/receive` files, as Bing answers them.
    if (url.pathname.endsWith("/GetRankAndTrafficStats") && url.searchParams.get("siteUrl") === JOURNEY_SITE) {
      return Response.json({ d: journeyBingDays().map(({ date, clicks, impressions }) =>
        ({ Date: `/Date(${Date.parse(`${date}T00:00:00Z`)})/`, Clicks: clicks, Impressions: impressions })) });
    }
    return Response.json({ ErrorCode: 7, Message: "NotAuthorized" }, { status: 400 });
  }
  // PostHog: the synthetic personal API key belongs to
  // the US cloud, so the EU cloud refuses it the way PostHog does; the US one
  // lists the journey's project (and a staging one no site claims), each
  // project's details and saved insights, and answers every archive query
  // with no rows — the collector's own path, counted nobody.
  if (url.origin === "https://us.posthog.com" || url.origin === "https://eu.posthog.com") {
    const authorized = new Headers(init?.headers).get("authorization") === `Bearer ${JOURNEY_KEY}`;
    if (!authorized || url.origin === "https://eu.posthog.com") return Response.json({ detail: "Invalid personal API key." }, { status: 401 });
    if (url.pathname === "/api/projects/") return Response.json({ results: JOURNEY_POSTHOG_PROJECTS.map(({ id, name }) => ({ id, name })) });
    const project = JOURNEY_POSTHOG_PROJECTS.find((entry) => url.pathname.startsWith(`/api/projects/${entry.id}/`));
    if (!project) return Response.json({ detail: "Not found." }, { status: 404 });
    const rest = url.pathname.slice(`/api/projects/${project.id}/`.length);
    if (rest === "") return Response.json({ id: project.id, name: project.name, timezone: "UTC", app_urls: project.appUrls, recording_domains: [] });
    if (rest === "insights/") return Response.json({ results: project.insights });
    if (rest === "query/" && init?.method === "POST") return Response.json({ results: [], query_status: { complete: true } });
    return Response.json({ detail: "Not found." }, { status: 404 });
  }
  // Clarity: the data export answers the synthetic
  // token with one metric block of the journey's pages, and refuses any other
  // the way Clarity does.
  if (url.origin === "https://www.clarity.ms" && url.pathname === "/export-data/api/v1/project-live-insights") {
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${JOURNEY_KEY}`) return Response.json({ message: "Unauthorized" }, { status: 401 });
    return Response.json([{ metricName: "Traffic", information: [{ sessionsCount: "42", distinctUserCount: "30", URL: JOURNEY_SITE }] }]);
  }
  // Mediavine: the publishers' GraphQL signs the
  // synthetic login in, lists the journey's one site, and reports $1.25 a day
  // with a summary two cents above the daily rows — the difference the Data
  // sources row shows. Any other login is refused the way Mediavine refuses it.
  if (url.origin === "https://api-publishers.mediavine.com" && url.pathname === "/graphql") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
    const query = body.query ?? "";
    const denied = () => Response.json({ errors: [{ message: "Unauthenticated", extensions: { code: "UNAUTHENTICATED" } }] });
    if (query.includes("unidashSignIn")) {
      const login = body.variables?.data as { email?: string; password?: string } | undefined;
      if (login?.email !== JOURNEY_MEDIAVINE_EMAIL || login.password !== JOURNEY_KEY) return denied();
      return Response.json({ data: { unidashSignIn: { accessToken: JOURNEY_MEDIAVINE_TOKEN, refreshToken: `${JOURNEY_MEDIAVINE_TOKEN}-refresh`, expiresIn: 3600, twoFactorRequired: false } } });
    }
    if (query.includes("unidashRefreshToken")) return denied();
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${JOURNEY_MEDIAVINE_TOKEN}`) return denied();
    if (query.includes("sitesForUser")) {
      return Response.json({ data: { sitesForUser: { edges: [{ node: JOURNEY_MEDIAVINE_SITE }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("earningsReport") && body.variables?.siteId === JOURNEY_MEDIAVINE_SITE.id) {
      const day = (value: unknown) => { const [m, d, y] = String(value).split("/"); return `${y}-${m}-${d}`; };
      const days: string[] = [];
      for (let at = Date.parse(`${day(body.variables.startDate)}T00:00:00Z`); at <= Date.parse(`${day(body.variables.endDate)}T00:00:00Z`); at += 86_400_000) {
        days.push(new Date(at).toISOString().slice(0, 10));
      }
      return Response.json({ data: { internalSite: JOURNEY_MEDIAVINE_SITE, metricsSummary: { summary: { earnings: days.length * 1.25 + 0.02 } },
        earningsReport: { earnings: days.map((date) => ({ date: date.replaceAll("-", "/"), revenue: 1.25 })) } } });
    }
    return Response.json({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] });
  }
  // Google: the token endpoint exchanges the walk's
  // synthetic consent code and refreshes the grant for the synthetic client
  // only; the Analytics Admin API lists the journey's two properties, each
  // with its web stream's address; Search Console lists the journey's domain
  // property and one no site claims; and the GA4 and Search Console reports
  // answer every day of the window.
  if (url.origin === "https://oauth2.googleapis.com") {
    if (url.pathname === "/revoke") return new Response(null, { status: 200 });
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (form.get("client_id") !== JOURNEY_GOOGLE_CLIENT_ID || form.get("client_secret") !== JOURNEY_KEY) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (form.get("grant_type") === "authorization_code" && form.get("code") === JOURNEY_GOOGLE_CODE) {
      const claims = btoa(JSON.stringify({ email: JOURNEY_GOOGLE_ACCOUNT })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      return Response.json({ access_token: JOURNEY_GOOGLE_ACCESS, refresh_token: JOURNEY_GOOGLE_REFRESH, expires_in: 3599,
        scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly",
        id_token: `e30.${claims}.journey` });
    }
    if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === JOURNEY_GOOGLE_REFRESH) {
      return Response.json({ access_token: JOURNEY_GOOGLE_ACCESS, expires_in: 3599 });
    }
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  const googleAuthorized = new Headers(init?.headers).get("authorization") === `Bearer ${JOURNEY_GOOGLE_ACCESS}`;
  if (url.origin === "https://analyticsadmin.googleapis.com") {
    if (!googleAuthorized) return Response.json({ error: { message: "Unauthenticated" } }, { status: 401 });
    if (url.pathname === "/v1beta/accountSummaries") {
      return Response.json({ accountSummaries: [{ displayName: "Journey Example Holdings", propertySummaries: JOURNEY_GA4_PROPERTIES.map(({ id, name }) => ({ property: `properties/${id}`, displayName: name })) }] });
    }
    const streams = /^\/v1beta\/properties\/(\d+)\/dataStreams$/.exec(url.pathname);
    const property = JOURNEY_GA4_PROPERTIES.find((entry) => entry.id === streams?.[1]);
    if (property) return Response.json({ dataStreams: [{ type: "WEB_DATA_STREAM", webStreamData: { defaultUri: property.uri } }] });
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  }
  if (url.origin === "https://analyticsdata.googleapis.com" && init?.method === "POST") {
    if (!googleAuthorized) return Response.json({ error: { message: "Unauthenticated" } }, { status: 401 });
    const range = (JSON.parse(String(init.body ?? "{}")) as { dateRanges?: { startDate: string; endDate: string }[] }).dateRanges?.[0];
    const days = journeyDays(range?.startDate, range?.endDate);
    return Response.json({
      dimensionHeaders: [{ name: "date" }],
      metricHeaders: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }, { name: "eventCount" }],
      rows: days.map((date, index) => ({ dimensionValues: [{ value: date.replaceAll("-", "") }],
        metricValues: [{ value: String(20 + index) }, { value: String(15 + index) }, { value: String(40 + index) }, { value: String(90 + index) }] })),
      metadata: { timeZone: "UTC" },
    });
  }
  if (url.origin === "https://www.googleapis.com" && url.pathname.startsWith("/webmasters/v3/sites")) {
    if (!googleAuthorized) return Response.json({ error: { message: "Unauthenticated" } }, { status: 401 });
    if (url.pathname === "/webmasters/v3/sites") return Response.json({ siteEntry: JOURNEY_GSC_SITES });
    if (url.pathname.endsWith("/searchAnalytics/query") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { startDate?: string; endDate?: string };
      return Response.json({ rows: journeyDays(body.startDate, body.endDate).map((date, index) => ({ keys: [date], clicks: 5 + index, impressions: 50 + index * 10, ctr: 0.1, position: 8.5 })) });
    }
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  }
  // Discord: the synthetic webhook takes the connect
  // panel's test message as Discord does (204); any other webhook is one
  // Discord no longer knows (404).
  if (url.origin === "https://discord.com" && url.pathname.startsWith("/api/webhooks/") && init?.method === "POST") {
    return new Response(null, { status: url.href === JOURNEY_DISCORD_WEBHOOK ? 204 : 404 });
  }
  // A calendar host: the synthetic secret feed is a
  // calendar; any other address answers a sign-in page, as a rotated secret
  // link does.
  if (url.origin === "https://calendar.example") {
    return url.href === JOURNEY_CALENDAR_FEED
      ? new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", { status: 200, headers: { "content-type": "text/calendar" } })
      : new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.origin === "https://api.dataforseo.com") {
    const expected = `Basic ${btoa(`${JOURNEY_DATAFORSEO_LOGIN}:${JOURNEY_KEY}`)}`;
    if (new Headers(init?.headers).get("authorization") !== expected) return new Response("", { status: 401 });
    if (url.pathname === "/v3/appendix/user_data") {
      return Response.json({ status_code: 20000, tasks: [{ result: [{ money: { balance: 18.72 } }] }] });
    }
    // Every report family answers one synthetic row at a published price, so
    // the first collection records a real cost through the lane's own meter.
    return Response.json({ status_code: 20000, status_message: "Ok.", cost: 0.011,
      tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.011, result: [{ items_count: 1, items: [{ keyword: "journey example" }] }] }] });
  }
  throw new TypeError("The journey fixture has no network beyond its synthetic providers");
};

/** The same providers, with a PostHog key that may read projects but not run
 * queries: PostHog answers each query 403, as it does a key missing the
 * Query scope. */
const posthogWithoutQueries: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://us.posthog.com" && url.pathname.endsWith("/query/")) {
    return Response.json({ type: "authentication_error", detail: "API key missing required scope query:read" }, { status: 403 });
  }
  return journeyProviderNetwork(input, init);
};

/** The same providers, with a Google account that signs in and lists its
 * sites but may not read their reports: GA4 and Search Console answer each
 * report 403, as they do an account without access. */
const googleWithoutReports: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if ((url.origin === "https://analyticsdata.googleapis.com" && init?.method === "POST") ||
      (url.origin === "https://www.googleapis.com" && url.pathname.endsWith("/searchAnalytics/query"))) {
    return Response.json({ error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } }, { status: 403 });
  }
  return journeyProviderNetwork(input, init);
};

/** The synthetic site the nightly site checks read: its home page, robots.txt, sitemap and three sampled pages, healthy or as
 * one regressed night leaves them — the home page's served text cut to 120
 * words, two AI crawlers newly disallowed, one page newly `noindex` and one
 * newly without a title. */
function journeySite(night: "healthy" | "regressed"): typeof fetch {
  const base = `https://${JOURNEY_ASSET}`;
  const pages = [0, 1, 2].map((n) => `${base}/p/${n}`);
  const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const page = (url: string) =>
    `<!doctype html><html><head><title>Journey page</title><meta name="description" content="A page of the journey site.">` +
    `<link rel="canonical" href="${url}"></head><body><h1>Journey page</h1><p>Words about the journey site.</p></body></html>`;
  const home = (words: number) =>
    `<!doctype html><html><head><title>Journey Example</title></head><body><p>${Array.from({ length: words }, (_, n) => `word${n}`).join(" ")}</p></body></html>`;
  const blocked = night === "regressed" ? ["GPTBot", "ClaudeBot"] : [];
  const robots = `User-agent: *\nAllow: /\n${blocked.map((bot) => `\nUser-agent: ${bot}\nDisallow: /\n`).join("")}\nSitemap: ${base}/sitemap.xml\n`;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
  return async (input) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target === `${base}/`) return html(home(night === "healthy" ? 860 : 120));
    if (target === `${base}/robots.txt`) return new Response(robots, { status: 200, headers: { "content-type": "text/plain" } });
    if (target === `${base}/sitemap.xml`) return new Response(sitemap, { status: 200, headers: { "content-type": "application/xml" } });
    if (target === pages[0]) return html(night === "healthy" ? page(target) : page(target).replace("</head>", '<meta name="robots" content="noindex"></head>'));
    if (target === pages[1]) return html(night === "healthy" ? page(target) : page(target).replace("<title>Journey page</title>", ""));
    if (target === pages[2]) return html(page(target));
    return new Response("not found", { status: 404 });
  };
}

/** The synthetic Google account: the OAuth client the
 * fixture's Google network accepts (dropped as a client file, or the hosted
 * installation's own), the consent screen's code, the grant it issues, and
 * what the account holds — two GA4 properties (the journey's and one no site
 * claims) and two Search Console sites. */
export const JOURNEY_GOOGLE_CLIENT_ID = "journey-client.apps.googleusercontent.com";
export const JOURNEY_GOOGLE_CODE = "journey-google-consent-code";
export const JOURNEY_GOOGLE_ACCOUNT = "founder@journey.example";
const JOURNEY_GOOGLE_ACCESS = "journey-google-access";
const JOURNEY_GOOGLE_REFRESH = "journey-google-refresh";
const JOURNEY_GA4_PROPERTIES = [
  { id: "313598867", name: "Journey Example — web", uri: JOURNEY_SITE },
  { id: "402211876", name: "Another site — web", uri: "https://another.example/" },
];
const JOURNEY_GSC_SITES = [
  { siteUrl: `sc-domain:${JOURNEY_ASSET}`, permissionLevel: "siteOwner" },
  { siteUrl: "https://another.example/", permissionLevel: "siteFullUser" },
];
/** Every day of a report window, inclusive, as YYYY-MM-DD. */
function journeyDays(start: string | undefined, end: string | undefined): string[] {
  const days: string[] = [];
  if (!start || !end) return days;
  for (let at = Date.parse(`${start}T00:00:00Z`); at <= Date.parse(`${end}T00:00:00Z`) && days.length < 400; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** The synthetic Discord webhook and calendar feed the fixture's network
 * accepts, and the webhook the notifier's failed delivery is replayed
 * against: addresses nothing outside this process ever hears of. */
export const JOURNEY_DISCORD_WEBHOOK = "https://discord.com/api/webhooks/0/journey-only-not-a-real-key";
export const JOURNEY_CALENDAR_FEED = "https://calendar.example/journey-only-not-a-real-key/basic.ics";

/** The synthetic Mediavine account: its login, the
 * access token its sign-in issues, and its one site, on the journey's domain. */
export const JOURNEY_MEDIAVINE_EMAIL = "journey@example.test";
const JOURNEY_MEDIAVINE_TOKEN = "journey-mediavine-access";
export const JOURNEY_MEDIAVINE_SITE = { id: "journey-mediavine-site", title: "Journey Example", domain: JOURNEY_ASSET };

/** The synthetic PostHog account: the journey's own
 * project, whose app URL is the journey's domain, with two saved funnels (one
 * query-based, one filter-based) and a trend that is not a funnel; and a
 * staging project no site claims. */
export const JOURNEY_POSTHOG_PROJECTS = [
  { id: 596607, name: "Journey Example", appUrls: [JOURNEY_SITE], insights: [
    { id: 1, short_id: "sgn1", name: "Signup", query: { kind: "InsightVizNode", source: { kind: "FunnelsQuery",
      series: [{ kind: "EventsNode", event: "$pageview" }, { kind: "EventsNode", event: "signed_up" }] } } },
    { id: 2, short_id: "chk2", name: "Checkout", filters: { insight: "FUNNELS", events: [
      { id: "$pageview", order: 0, properties: [{ key: "$pathname", operator: "exact", value: "/pricing" }] },
      { id: "checkout_started", order: 1 }, { id: "purchase", order: 2 }] } },
    { id: 3, short_id: "trd3", name: "Weekly visitors", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", series: [] } } },
  ] },
  { id: 596608, name: "Staging", appUrls: [], insights: [] },
];

/** The synthetic Bing account: the journey's own site, verified, and a
 * subdomain the account holds but never verified — listed by the connect
 * panel, matched to no asset, and never collected. */
const JOURNEY_BING_SITES = [{ Url: JOURNEY_SITE, IsVerified: true }, { Url: "https://blog.journey.example/", IsVerified: false }];

/** 35 days of Bing traffic ending the day before the fixture's clock: clicks
 * 1…35 and ten times as many impressions, so 28 days sum to 602 and 7 to 224. */
export function journeyBingDays(): { date: string; clicks: number; impressions: number }[] {
  return Array.from({ length: 35 }, (_, index) => {
    const day = index + 1;
    return { date: new Date(Date.parse(JOURNEY_NOW) - (36 - day) * 86_400_000).toISOString().slice(0, 10), clicks: day, impressions: day * 10 };
  });
}

/** The task lane reads saved project membership from the configuration store
 * through the ingest door (scripts/config-store-client.mjs), with the
 * operator's bearer from the secrets file. Here the door is an in-process
 * handler on a non-routable origin and the bearer is synthetic, so the lane's
 * real snapshot parsing and host-link resolution run over fixed synthetic
 * descriptors, without the operator's installation files or live door. */
const JOURNEY_CONFIG_DOOR = "http://config-door.journey.invalid";
const JOURNEY_OPERATOR_TOKEN = "journey-synthetic-operator-token";

/** The wire shape the real store door sends (serializeMismatch in
 * workers/ingest/src/config-store.ts): MISSING is a symbol and cannot cross
 * RPC, so absence is a field of its own. */
function serializeMismatch(m: Mismatch): ConfigWriteMismatch {
  const where = m.op.kind === "store-asset-set"
    ? { asset: m.op.asset, column: m.op.column }
    : { file: m.op.file, pointer: m.op.pointer };
  const expectAbsent = m.expect === MISSING;
  return {
    ...where,
    expect: expectAbsent ? null : (m.expect as JsonValue),
    ...(expectAbsent ? { expectAbsent: true as const } : {}),
    current: m.current === MISSING ? null : (m.current as JsonValue),
    absent: m.current === MISSING,
  };
}

/** Real Tower routes + Postgres reads. Doubles exist ONLY at external boundaries:
 * provider credentials/probes, fake bd, and disposable config persistence. The
 * latter runs the production validation, compare-and-set and application code.
 * The ingest functions (asset creation, the credential store, integration
 * health) are the real ones, injected by server.mjs after Vite loads them.
 */
export function createJourneyHarness(ingestCode: JourneyIngest, postgresHandle: TestClusterHandle) {
  let bucket = journeyBucket();
  const postgres = journeyPostgres(postgresHandle);
  // A fresh view per call: the ingest code reads it as its call's env.
  const ingestEnv = (): JourneyIngestEnv => ({ NOTICEOS_WORKSPACE_PROFILE: "standalone", CREDENTIALS_KEY: JOURNEY_CREDENTIALS_KEY, RAW_SIGNALS: bucket,
    STORE: postgres.current().store,
    ...(hostedGoogle ? { GOOGLE_OAUTH_CLIENT_ID: JOURNEY_GOOGLE_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: JOURNEY_KEY } : {}) });
  let documents = structuredClone(INITIAL_DOCUMENTS);
  let versions = new Map(Object.keys(documents).map((file) => [file, 1]));
  let collected = false;
  let failNextSave = false;
  // A hosted installation: its own Google OAuth client arrives with the
  // deployment, so the panel is one button.
  let hostedGoogle = false;
  // A PostHog key that reads projects but may not run queries: set by
  // `/__journey/posthog-query-denied`, so the next collection meets the
  // refusal PostHog gives such a key.
  let posthogQueryDenied = false;
  let googleReportsDenied = false;

  /** One provider's card, from the production credential read over the rows
   * the fixture store holds. Every "is it connected / has it been tested"
   * question this fixture asks comes from here. */
  async function credential(provider: IntegrationProviderId): Promise<CredentialSummary> {
    const found = (await ingestCode.readCredentialSummaries(ingestEnv())).summaries.find((row) => row.provider === provider);
    if (!found) throw new Error(`The credential read returned no ${provider} card`);
    return found;
  }
  const connected = async (provider: IntegrationProviderId) => (await credential(provider)).source === "store";
  /** Tested = the stored row carries a verdict the (stand-in) connection test
   * stamped through the production recorder. A new Save clears it, as it does
   * on a real install. */
  const tested = async (provider: IntegrationProviderId) => {
    const card = await credential(provider);
    return card.source === "store" && card.lastOkAt !== null;
  };

  let tasks = initialTasks();
  let taskProject = JOURNEY_TASK_PROJECT;
  const requests: { method: string; path: string; status: number }[] = [];
  const taskCommands: string[][] = [];
  const fixtureRoot = fileURLToPath(new URL("./fixture-repo", import.meta.url));

  const refuse = async (): Promise<never> => { throw new Error("External operation is not available in the isolated journey fixture"); };

  /** Once the fixture has accepted its synthetic connection values, the real
   * credential store seals them into the fixture store: that row is what the
   * credential cards and the integration-health read both resolve a saved
   * connection from. The answer is the store's own, summary included. */
  async function seal(input: PutCredentialInput): Promise<PutCredentialResult> {
    const sealed = await ingestCode.putCredential(ingestEnv(), input);
    if (!sealed.ok) throw new Error(`The fixture store refused the synthetic ${input.provider} connection: ${sealed.error}`);
    return sealed;
  }
  /** The health read takes its inventory from the config store; here the
   * documents live in the fixture's own storage, so it is copied in first. */
  async function publishDocuments() {
    const files = Object.keys(documents);
    const { store: postgresStore } = postgres.current();
    await postgresStore.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.config_documents AS d (workspace_id, document_key, body, version, updated_at, updated_by)
         SELECT $1::uuid, p.document_key, p.body::json, p.version, $5::timestamptz, 'journey-fixture'
           FROM unnest($2::text[], $3::text[], $4::int[]) AS p(document_key, body, version)
         ON CONFLICT (workspace_id, document_key) DO UPDATE
            SET body = excluded.body, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [
          tx.workspaceId,
          files.map((file) => configDocumentKey(file) ?? file),
          files.map((file) => JSON.stringify(documents[file])),
          files.map((file) => versions.get(file) ?? 1),
          JOURNEY_NOW,
        ],
      ),
    );
    ingestCode.forgetConfigCache(postgresStore);
  }

  /** Whether the site list holds this site: read on Postgres, where the Tower
   * and the ingest read it. */
  async function siteStored(id: string): Promise<boolean> {
    const found = await postgres.current().store.read((tx) =>
      tx.query("SELECT 1 AS stored FROM noticeos.assets WHERE asset_id = $1", [id]));
    return found.length > 0;
  }
  /** The site list, as `/__journey/status` states it. */
  async function storedSites(): Promise<{ id: string; display_name: string; status: string }[]> {
    return postgres.current().store.read((tx) =>
      tx.query<{ id: string; display_name: string; status: string }>(
        'SELECT asset_id AS id, display_name, status FROM noticeos.assets ORDER BY asset_id COLLATE "C"'));
  }

  /** The feed's sites, directly in this server's Postgres copy; an existing
   * site keeps its metadata and place. */
  async function feedSitesIntoPostgres() {
    const sites = wallFeedSites();
    await postgres.current().store.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
         SELECT $1::uuid, s.asset_id, s.domain, s.display_name, 'live', false, s.is_os, $5::timestamptz, $5::timestamptz
           FROM unnest($2::text[], $3::text[], $4::text[], $6::boolean[]) AS s(asset_id, domain, display_name, is_os)
         ON CONFLICT DO NOTHING`,
        [tx.workspaceId, sites.map((site) => site.id), sites.map((site) => site.domain), sites.map((site) => site.displayName),
          WALL_FEED_SITES_ADDED_AT, sites.map((site) => site.isOs)],
      ),
    );
  }

  const ingest: TowerEnv["INGEST"] = {
    // The site's revenue status and sync are the production ones over the
    // fixture store, the saved documents published first as a real run reads
    // them.
    async mediavineStatus(asset) {
      await publishDocuments();
      return ingestCode.mediavineStatus(ingestEnv(), asset);
    },
    // The forecast calendar's save: the register write goes through this
    // fixture's own document store (below), as every Tower save does here.
    async saveMediavineSettings(input) {
      if (!await connected('mediavine') || input.asset !== JOURNEY_ASSET || input.siteId !== JOURNEY_MEDIAVINE_SITE.id) return { ok: false, message: 'Choose the synthetic site.' };
      const config = documents['config/integrations.json'] as { assets: Record<string, Record<string, Record<string, unknown>>> };
      const lane = config.assets[JOURNEY_ASSET]?.['ad-network'];
      if (!lane) return { ok: false, message: 'Create the asset first.' };
      // As the ingest's own door (workers/ingest/src/mediavine.ts): it starts
      // a sync and never writes a decline, which is the row's Not using with
      // its reason.
      if (!input.enabled && lane.status !== 'skipped' && lane.status !== 'not-applicable') return { ok: false, message: 'Stop this sync with Not using on the site’s Ad revenue row.' };
      const values = { mediavineSiteId: input.siteId, mediavineEnabled: input.enabled, ...(input.enabled ? { status: 'needs-setup' } : {}), ...(input.holidayCalendar === undefined ? {} : { revenueHolidayCalendar: input.holidayCalendar }) };
      const result = await ingest.applyConfigOps({ actor: 'journey-fixture', ops: Object.entries(values).map(([field, value]) => ({
        kind: 'file-json-set' as const, file: 'config/integrations.json', pointer: `/assets/${JOURNEY_ASSET}/ad-network/${field}`, value,
        ...(lane[field] === undefined ? { expectAbsent: true as const } : { expect: lane[field] }),
      })) });
      if (!result.ok) return { ok: false, message: 'The synthetic settings could not be saved.' };
      return { ok: true, value: await ingest.mediavineStatus(input.asset) };
    },
    async syncMediavine(input) {
      await publishDocuments();
      return ingestCode.syncMediavine(ingestEnv(), input, { fetchImpl: journeyProviderNetwork, nowMs: Date.parse(JOURNEY_NOW) });
    },
    async getConfigDocuments(files) {
      return files.map((file) => ({ file, body: structuredClone(documents[file] ?? null),
        source: "store" as const, version: versions.get(file) ?? 1, updatedAt: JOURNEY_NOW,
        updatedBy: "journey-fixture", }));
    },
    async applyConfigOps(input) {
      if (failNextSave) {
        failNextSave = false;
        return { ok: false, error: "store_unavailable", detail: "The isolated test store refused this save. Retry setup." };
      }
      const change: Changeset = { version: 1, createdAt: JOURNEY_NOW, slug: input.slug ?? "journey-save", ops: input.ops as Changeset["ops"] };
      if (change.ops.some((op) => op.kind === "store-asset-set")) {
        return { ok: false, error: "store_op_not_accepted", detail: "This door writes config documents; an asset column is written through PATCH /api/assets/:id." };
      }
      try {
        validateSchemaAndSafety(change);
        // Same refusal order and wire shapes as workers/ingest/src/config-store.ts
        // applyConfigOps, so the browser handles exactly what the real Tower sends.
        const named = [...new Set(change.ops.flatMap((op) => ("file" in op ? [op.file] : [])))];
        const unseeded = named.filter((file) => !(file in documents));
        if (unseeded.length) return { ok: false, error: "not_seeded", detail: `The isolated fixture holds no ${unseeded.join(", ")}.`, files: unseeded };
        const versionMismatches = named.flatMap((file) => {
          const expected = input.expectVersions?.[file];
          const observed = versions.get(file) ?? 0;
          return typeof expected === "number" && expected !== observed ? [{ file, expected, observed }] : [];
        });
        if (versionMismatches.length) return { ok: false, error: "version_mismatch", files: versionMismatches };
        const resolved = await resolveOps(change, null, {
          readDocument: async (file) => structuredClone(documents[file] ?? null),
          // The fixture's compiled copies, as the ingest's `bundled`.
          readBuiltIn: async (file) => structuredClone(INITIAL_DOCUMENTS[file] ?? null),
        });
        if (resolved.mismatches.length) return { ok: false, error: "expect_mismatch", mismatches: resolved.mismatches.map(serializeMismatch) };
        const changed = applyDocumentOps(resolved.resolved, resolved.documents, { at: JOURNEY_NOW });
        for (const file of changed) {
          documents[file] = resolved.documents.get(file);
          versions.set(file, (versions.get(file) ?? 0) + 1);
        }
        return { ok: true, applied: change.ops.length, documents: changed.map((file) => ({ file, version: versions.get(file)!, body: documents[file] })) };
      } catch (error) {
        return { ok: false, error: "invalid_changeset", detail: error instanceof Error ? error.message : "Invalid fixture change" };
      }
    },
    createAsset: (input) => ingestCode.createAsset(ingestEnv(), input, Date.now()),
    moveAsset: (input) => ingestCode.moveAsset(ingestEnv(), input, Date.now()),
    async integrationHealth() {
      await publishDocuments();
      return ingestCode.readIntegrationHealth(ingestEnv(), Date.now());
    },
    // The credential cards: the production read over the rows sealed below,
    // not a fixture summary.
    listCredentialSummaries: () => ingestCode.readCredentialSummaries(ingestEnv()),
    async putCredential(input) {
      // Fixture boundary: only the documented synthetic values are accepted. The
      // write itself, and the summary it answers with, are the store's own.
      if (input.provider === 'mediavine' && input.fields.MEDIAVINE_USER === JOURNEY_MEDIAVINE_EMAIL && input.fields.MEDIAVINE_PASSWORD === JOURNEY_KEY) {
        return seal(input);
      }
      // The client file dropped on Google's panel.
      if (input.provider === 'google-oauth-app' && input.fields.GOOGLE_OAUTH_CLIENT_ID === JOURNEY_GOOGLE_CLIENT_ID && input.fields.GOOGLE_OAUTH_CLIENT_SECRET === JOURNEY_KEY) {
        return seal(input);
      }
      if (input.provider !== "bing-webmaster" || input.fields.BING_WEBMASTER_API_KEY !== JOURNEY_KEY) {
        return { ok: false, error: "validation", issues: [{ path: "fields", code: "fixture_only", message: "Only the documented synthetic Bing key is accepted by this isolated test server." }] };
      }
      return seal(input);
    },
    // The connect panel: the production save-and-test over the fixture store,
    // with the providers answering from `journeyProviderNetwork`.
    // A token pasted on a site's row (Clarity): the production merge into
    // the per-site map, over the fixture store.
    putSiteToken: (input) => ingestCode.putSiteToken(ingestEnv(), input),
    // With PostHog's queries refused, the key's test is stamped a second
    // before the collection that meets the refusal, as it is on an
    // installation, so the card reads the later answer (compare google-revoked).
    connectCredential: (input) => ingestCode.connectCredential(ingestEnv(), input,
      { fetchImpl: journeyProviderNetwork, nowMs: Date.parse(JOURNEY_NOW) - (posthogQueryDenied ? 1000 : 0) }),
    // The connect panel's site list and Start collecting: the production
    // listing and the production dispatch step over the fixture store, the
    // saved documents published first so the lane reads the mapping the press
    // just saved, as a real run does.
    discoverSites: (provider) => ingestCode.discoverSites(ingestEnv(), provider,
      { fetchImpl: journeyProviderNetwork, nowMs: Date.parse(JOURNEY_NOW) }),
    async collectNow(input) {
      await publishDocuments();
      const network = posthogQueryDenied ? posthogWithoutQueries : googleReportsDenied ? googleWithoutReports : journeyProviderNetwork;
      return ingestCode.runCollectNow(ingestEnv(), input, { fetchImpl: network, nowMs: Date.parse(JOURNEY_NOW) });
    },
    // Test connection: the production probe over the fixture store, its
    // verdict stamped and observed where the real test's is; only the
    // provider's network answer is the fixture's.
    async probeCredential(provider) {
      await publishDocuments();
      return ingestCode.probeCredential(ingestEnv(), provider, { fetchImpl: journeyProviderNetwork, nowMs: Date.parse(JOURNEY_NOW) });
    },
    setCredentialExpiry: refuse,
    async deleteCredential(provider) {
      if (provider !== 'mediavine') return refuse();
      // Mediavine's own Disconnect (credential-probes.ts disconnectCredential).
      const removed = await ingestCode.disconnectMediavine(ingestEnv());
      if (!removed.ok) throw new Error(`The fixture store could not remove the synthetic ${provider} connection`);
      return removed;
    },
    createAnnotation: refuse, readAssetState: refuse, writeAssetColumn: refuse,
    calendarUpcoming: refuse, researchLookup: refuse,
    runScheduled: refuse, fetch: refuse, watchQueryHistory: refuse,
    createWatchWindow: refuse, backtestRule: refuse,
    // Signing in to Google: the production start and callback, the account's
    // lists, over the fixture's Google network.
    beginGoogleOAuth: (input) => ingestCode.beginGoogleOAuth(ingestEnv(), { origin: input.origin, nowMs: Date.parse(JOURNEY_NOW) }),
    // With Google's reports refused, the sign-in is stamped a second before the
    // collection that meets the refusal, as on an installation (compare
    // posthogQueryDenied above), so the card reads the later answer.
    completeGoogleOAuth: (input) => ingestCode.completeGoogleOAuth(ingestEnv(),
      { ...input, nowMs: Date.parse(JOURNEY_NOW) - (googleReportsDenied ? 1000 : 0), fetchImpl: journeyProviderNetwork }),
    discoverGoogleProperties: () => ingestCode.discoverGoogleProperties(ingestEnv(), { fetchImpl: journeyProviderNetwork, nowMs: Date.parse(JOURNEY_NOW) }),
    ga4Realtime: refuse,
  };

  /** The GET /api/config-documents?bodies=1 answer the real door gives
   * (workers/ingest/src/routes/config-documents.ts), over this fixture's
   * documents. Anything else is refused, as the real door refuses it. */
  const configDoor: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== JOURNEY_CONFIG_DOOR) throw new Error("The journey config door answers only its own synthetic origin");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${JOURNEY_OPERATOR_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if ((init?.method ?? "GET") !== "GET" || url.pathname !== "/api/config-documents") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const bodies = url.searchParams.get("bodies") === "1";
    return Response.json({ ready: true, reason: null, unseeded: [],
      documents: Object.keys(documents).map((file) => ({ file, version: versions.get(file) ?? 1,
        updatedAt: JOURNEY_NOW, updatedBy: "journey-fixture", ...(bodies ? { body: structuredClone(documents[file]) } : {}) })) });
  };
  // This host inventory is fixed independently of the mutable stored map.
  // Installation folders are absent from the public source export; the real
  // resolver still parses and matches every saved asset/prefix/database.
  const taskHost = JSON.stringify({ repositories: [JOURNEY_TASK_PROJECT, JOURNEY_CORE_PROJECT] });
  const readProjects = () => readSpokes(fixtureRoot, { door: JOURNEY_CONFIG_DOOR, token: JOURNEY_OPERATOR_TOKEN,
    fetchImpl: configDoor, readHost: async () => taskHost });

  function runBd(argv: string[], cwd: string): BdResult {
    if (path.resolve(cwd) !== path.resolve(fixtureRoot)) throw new Error("Task fixture escaped its own spoke");
    taskCommands.push([...argv]);
    const verb = argv[2];
    const arg = argv[3];
    const answer = (value: unknown): BdResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    if (verb === "ready") return answer(tasks.filter((row) => row.status === "open" && row.issue_type === "task"));
    if (verb === "epic" && arg === "status") return answer([]);
    if (verb === "comments") return answer([]);
    if (verb === "list") {
      const statuses = argv[argv.indexOf("--status") + 1]?.split(",") ?? ["open"];
      return answer(tasks.filter((row) => statuses.includes(row.status) && (row.issue_type !== "gate" || argv.includes("--include-gates"))));
    }
    if (verb === "show") return answer(tasks.filter((row) => row.id === arg));
    if (verb === "gate" && arg === "resolve") {
      const row = tasks.find((task) => task.id === argv[4]);
      if (!row || row.issue_type !== "gate") return { code: 1, stdout: "", stderr: "Unknown fixture gate" };
      row.status = "closed";
      row.closed_at = JOURNEY_NOW;
      publishTasks();
      return answer({ id: row.id });
    }
    // The inbox's other two answers and a filed task, so the journeys prove
    // each one reaches `bd` through the real lane.
    if (verb === "human" && (arg === "respond" || arg === "dismiss")) {
      const row = tasks.find((task) => task.id === argv[4]);
      if (!row || row.issue_type === "gate" || !row.labels.includes("human")) return { code: 1, stdout: "", stderr: "Unknown fixture ask" };
      if (arg === "respond" && !argv.includes("--response")) return { code: 1, stdout: "", stderr: "A response is required" };
      row.status = "closed";
      row.closed_at = JOURNEY_NOW;
      publishTasks();
      return answer({ id: row.id });
    }
    if (verb === "create" && typeof arg === "string" && arg.trim() !== "") {
      const id = `${taskProject.prefix}-f${tasks.length + 1}`;
      tasks.push({ ...initialTasks()[0]!, priority: 1, id, title: arg, labels: [], description: "", acceptance_criteria: "" });
      publishTasks();
      return answer({ id });
    }
    if (verb === "close") {
      const row = tasks.find((task) => task.id === arg);
      const reason = argv.includes("--reason") ? argv[argv.indexOf("--reason") + 1]?.trim() : "";
      if (!row || !reason) return { code: 1, stdout: "", stderr: "A fixture task and completion evidence are required" };
      row.status = "closed";
      row.closed_at = JOURNEY_NOW;
      row.close_reason = reason;
      publishTasks();
      return answer({ id: row.id });
    }
    return { code: 1, stdout: "", stderr: "This synthetic task executor does not implement that command" };
  }

  /** The task projects the fixture has saved, as the runner reads them. */
  function savedTaskProjects(): string[] {
    const saved = documents["config/beads.json"] as { spokes?: { asset?: unknown }[] } | undefined;
    return (saved?.spokes ?? []).flatMap((spoke) => (typeof spoke.asset === "string" ? [spoke.asset] : []));
  }

  /** Photographs `publishTasks` is filing into this fixture's Postgres copy,
   * where the desk reads them: every answer waits for them (`fetchRequest`),
   * so the next read sees what the last command did. */
  let publishing: Promise<void> = Promise.resolve();
  function filePhotograph(payload: string) {
    const { store: postgresStore } = postgres.current();
    publishing = publishing.then(() =>
      postgresStore.write((tx) =>
        tx.execute(
          `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
          [tx.workspaceId, JOURNEY_NOW, payload],
        ),
      ).then(() => undefined),
    );
  }

  /** The runner's task snapshot, as `runBeadsPoll` files it: one entry per
   * saved task project, and an empty one when none is saved, which preserves
   * the core snapshot's actual project availability. */
  function publishTasks() {
    if (!savedTaskProjects().includes(taskProject.asset)) {
      filePhotograph(JSON.stringify({ projects: [] }));
      return;
    }
    const open = tasks.filter((task) => task.status === "open");
    // Only the operator's own asks wait on the operator; a filed task does not.
    const waiting = open.filter((task) => task.issue_type === "gate" || task.labels.includes("human"));
    // A human gate is titled by its ask, as `runBeadsPoll` titles it.
    const toItem = (task: ReturnType<typeof initialTasks>[number]) => ({ id: task.id,
      title: task.await_type === "human" ? gateTitle(task.title, task.description) : task.title,
      priority: task.priority, status: task.status, issueType: task.issue_type, updatedAt: JOURNEY_NOW });
    filePhotograph(
      JSON.stringify({ projects: [{ asset: taskProject.asset, prefix: taskProject.prefix, ok: true, error: null,
        counts: { open: open.length, ready: open.filter((t) => t.issue_type === "task").length, inProgress: 0,
          blocked: 0, highPriority: open.length, closedRecent: tasks.length - open.length, deferred: 0, waiting: waiting.length },
        waitingUrgent: waiting.length, priorities: [0, 1, 2, 3, 4].map((band) => open.filter((t) => t.priority === band).length), epics: [],
        ready: open.filter((t) => t.issue_type === "task").map(toItem), inProgress: [], recentlyClosed: [], deferred: [], waiting: waiting.map(toItem) }] }));
  }

  async function receiveData(): Promise<Response> {
    const config = documents["config/integrations.json"] as { assets: Record<string, Record<string, { siteUrl?: string }>> };
    const mapping = config.assets[JOURNEY_ASSET]?.["bing-webmaster"]?.siteUrl;
    if (!await tested("bing-webmaster") || mapping !== JOURNEY_SITE || !await siteStored(JOURNEY_ASSET)) {
      return Response.json({ error: "Complete the real create, connect, test and site-mapping steps first." }, { status: 409 });
    }
    if (!collected) {
      // Fixture boundary: this replaces the external collector, not a read-model.
      // Rows have the same constraints/shape as saved successful provider results.
      const end = new Date(Date.parse(JOURNEY_NOW) - 86_400_000).toISOString().slice(0, 10);
      const start = new Date(Date.parse(JOURNEY_NOW) - 35 * 86_400_000).toISOString().slice(0, 10);
      // On Postgres, where the collectors write them: the run, the series it
      // measured and its values, in one transaction.
      const days = journeyBingDays();
      await postgres.current().store.write(async (tx) => {
        const [run] = await tx.query<{ run_seq: bigint }>(
          `INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref,
             started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
           VALUES ($1::uuid, 'journey-bing', $2, 'bing-webmaster', 'synthetic', $3, $4::timestamptz, $4::timestamptz, 'success',
                   $5::date, $6::date, 'final', 35, 70)
           RETURNING run_seq`,
          [tx.workspaceId, JOURNEY_ASSET, JOURNEY_SITE, JOURNEY_NOW, start, end],
        );
        await tx.execute(
          `INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
           VALUES ($1::uuid, $2, 'bing-webmaster', $3, NULL, 'clicks'), ($1::uuid, $2, 'bing-webmaster', $3, NULL, 'impressions')
           ON CONFLICT DO NOTHING`,
          [tx.workspaceId, JOURNEY_ASSET, JOURNEY_SITE],
        );
        await tx.execute(
          `INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
           SELECT $1::uuid, $2::bigint, s.series_id, v.observed_date, v.value
             FROM unnest($5::date[], $6::text[], $7::float8[]) WITH ORDINALITY AS v(observed_date, metric, value, place)
             JOIN noticeos.measurement_series s
               ON s.asset_id = $3 AND s.integration = 'bing-webmaster' AND s.property_ref = $4 AND s.time_zone IS NULL
              AND s.metric = v.metric
            ORDER BY v.place`,
          [
            tx.workspaceId, run!.run_seq, JOURNEY_ASSET, JOURNEY_SITE,
            days.flatMap(({ date }) => [date, date]),
            days.flatMap(() => ["clicks", "impressions"]),
            days.flatMap(({ clicks, impressions }) => [clicks, impressions]),
          ],
        );
      });
      // …and the monitoring result the collector records beside its run.
      const env = ingestEnv();
      const monitoring = ingestCode.beginCollection(env.STORE, await ingestCode.tryHealthConnection(env, "bing-webmaster"));
      if (!await ingestCode.recordCollectedHealth({ monitoring,
        target: { asset: JOURNEY_ASSET, integration: "bing-webmaster", propertyRef: JOURNEY_SITE },
        attempt: { id: "journey-bing", startedAt: JOURNEY_NOW, finishedAt: JOURNEY_NOW, source: "signal_runs", ok: true } })) {
        throw new Error("The fixture could not record the Bing collection's monitoring result");
      }
      collected = true;
      publishTasks();
    }
    return Response.json({ received: true, asset: JOURNEY_ASSET, last7Clicks: 224, last28Clicks: 602 });
  }

  /** One lane's failure, reached through the lane itself (see the route). */
  async function afterFailure(kind: string): Promise<Response> {
    if (!await siteStored(JOURNEY_ASSET)) {
      return Response.json({ error: "Create the fixture asset first." }, { status: 409 });
    }
    const lane = <T>(fn: T | undefined, name: string): T => {
      if (fn === undefined) throw new Error(`server.mjs did not hand the harness ${name}`);
      return fn;
    };
    const env = ingestEnv();
    const nowMs = Date.parse(JOURNEY_NOW);
    const day = (offset: number) => new Date(nowMs + offset * 86_400_000).toISOString().slice(0, 10);
    if (kind === "discord") {
      // A deleted Discord webhook: the webhook stored,
      // then the hourly notifier's delivery of an open error alert answered
      // 404, as Discord answers a webhook deleted in the server's settings.
      // Fire an error alert first (`/__journey/uptime?status=503`).
      const sealed = await ingestCode.putCredential(env, { provider: "discord", fields: { DISCORD_WEBHOOK_URL: JOURNEY_DISCORD_WEBHOOK } });
      if (!sealed.ok) throw new Error(`The fixture store refused the synthetic Discord webhook: ${sealed.error}`);
      const discord: typeof fetch = async (input) => {
        if ((input instanceof Request ? input.url : String(input)) !== JOURNEY_DISCORD_WEBHOOK) throw new TypeError("Only the synthetic webhook answers");
        return Response.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 });
      };
      return Response.json(await lane(ingestCode.runNotifier, "runNotifier")(env, { nowMs, fetchImpl: discord }));
    }
    if (kind === "site-checks") {
      // Eight healthy nights of the site checks, then one regressed night an
      // hour ago, and a GA4 property whose daily token budget is down to 5%.
      const assets = [{ asset: JOURNEY_ASSET, domain: JOURNEY_ASSET }];
      const run = lane(ingestCode.runHygieneChecks, "runHygieneChecks");
      for (let night = 8; night >= 1; night -= 1) {
        await run(env, { assets, fetchImpl: journeySite("healthy"), nowMs: nowMs - night * 86_400_000 });
      }
      const regressed = await run(env, { assets, fetchImpl: journeySite("regressed"), nowMs: nowMs - 3_600_000 });
      await lane(ingestCode.recordGa4Quota, "recordGa4Quota")(env, { asset: JOURNEY_ASSET, lane: "google-signals",
        propertyRef: "properties/313598867", at: new Date(nowMs - 3_600_000).toISOString(),
        quota: { tokensPerDay: { consumed: 190_000, remaining: 10_000 }, tokensPerHour: null } });
      return Response.json(regressed);
    }
    if (kind === "posthog-query-denied") {
      // A PostHog key that reads projects but not queries: the next
      // collection (Start in the connect panel) meets PostHog's 403.
      posthogQueryDenied = true;
      return Response.json({ armed: true });
    }
    if (kind === "google-reports-denied") {
      // A Google account that may list its sites but not read their reports:
      // the next collection (Start in the connect panel) meets GA4's and
      // Search Console's 403 on every property.
      googleReportsDenied = true;
      return Response.json({ armed: true });
    }
    if (kind === "time-zone") {
      // The GA4 property's reporting time zone moved three days ago, as the
      // collector files it on the site's timeline.
      return Response.json(await lane(ingestCode.recordTimeZoneChange, "recordTimeZoneChange")(env,
        { asset: JOURNEY_ASSET, integration: "ga4", from: "Europe/Lisbon", to: "UTC", effectiveOn: day(-3) }));
    }
    if (kind === "watch-split") {
      // An outcome check on Google clicks whose baseline was collected on the
      // site's URL-prefix property and whose post window on its domain
      // property: the daily watch sweep closes it unmeasurable, naming both.
      const record = lane(ingestCode.recordSignalSuccess, "recordSignalSuccess");
      const collect = async (propertyRef: string, start: number, end: number) => {
        const dates: string[] = [];
        for (let offset = start; offset <= end; offset += 1) dates.push(day(offset));
        await record(env, { asset: JOURNEY_ASSET, integration: "gsc", credentialRef: "journey-google", propertyRef },
          { start: dates[0]!, end: dates.at(-1)! }, new Date(nowMs - (60 - start) * 60_000).toISOString(),
          { providerRows: dates.length, observations: dates.map((date) => ({ date, metric: "clicks", value: 40 })),
            dataState: "final", provisionalFrom: null, timeZone: "UTC" });
      };
      await collect(JOURNEY_SITE, -60, -31);
      await collect(`sc-domain:${JOURNEY_ASSET}`, -30, -1);
      const registered = await lane(ingestCode.writeWatchWindow, "writeWatchWindow")(env, {
        asset: JOURNEY_ASSET, ref_kind: "manual", ref: "Title rewrite batch", metric_integration: "gsc", metric: "clicks",
        registered_at: new Date(nowMs - 30 * 86_400_000).toISOString(), baseline_start: day(-58), baseline_end: day(-31),
        check_offsets: [7, 14, 28], thresholds: { ship: { direction: "up", min_delta_pct: 10 }, kill: { direction: "down", min_delta_pct: 10 } },
      }, nowMs - 30 * 86_400_000);
      if (!registered.ok) throw new Error(`The synthetic watch was refused: ${JSON.stringify(registered)}`);
      return Response.json(await lane(ingestCode.runWatchWindows, "runWatchWindows")(env, nowMs));
    }
    if (kind === "watch-query") {
      // An outcome check narrowed to one search query whose query archive was
      // never collected: the daily watch sweep closes
      // it unmeasurable, and the row names the query beside its series.
      const registered = await lane(ingestCode.writeWatchWindow, "writeWatchWindow")(env, {
        asset: JOURNEY_ASSET, ref_kind: "manual", ref: "Recipe intro rewrite", metric_integration: "gsc", metric: "clicks",
        scope: { query: "high protein meal plan" },
        registered_at: new Date(nowMs - 30 * 86_400_000).toISOString(), baseline_start: day(-58), baseline_end: day(-31),
        check_offsets: [7, 14, 28], thresholds: { ship: { direction: "up", min_delta_pct: 10 }, kill: { direction: "down", min_delta_pct: 10 } },
      }, nowMs - 30 * 86_400_000);
      if (!registered.ok) throw new Error(`The synthetic watch was refused: ${JSON.stringify(registered)}`);
      return Response.json(await lane(ingestCode.runWatchWindows, "runWatchWindows")(env, nowMs));
    }
    return Response.json({ error: "Unknown failure" }, { status: 404 });
  }

  /** Does this config save write a task project (`config/beads.json`)? Read
   * off a copy, so the request's own body is still there to answer from. */
  async function savesTaskProject(request: Request): Promise<boolean> {
    const body = await request.clone().json().catch(() => null) as { ops?: unknown } | null;
    return Array.isArray(body?.ops) && body.ops.some((op) =>
      op !== null && typeof op === "object" && (op as { file?: unknown }).file === "config/beads.json");
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/__journey/status") {
      response = Response.json({ isolated: true, now: JOURNEY_NOW,
        connected: await connected("bing-webmaster"), tested: await tested("bing-webmaster"), collected,
        assets: await storedSites(),
        documents, tasks, requests, taskCommands });
    } else if (url.pathname === "/__journey/reset" && request.method === "POST") {
      await postgres.reset(); bucket = journeyBucket(); documents = structuredClone(INITIAL_DOCUMENTS);
      versions = new Map(Object.keys(documents).map((file) => [file, 1]));
      collected = false; failNextSave = false; hostedGoogle = false; posthogQueryDenied = false; googleReportsDenied = false; tasks = initialTasks(); taskProject = JOURNEY_TASK_PROJECT;
      requests.length = 0; taskCommands.length = 0;
      response = Response.json({ reset: true });
    } else if (url.pathname === "/__journey/google-hosted" && request.method === "POST") {
      // A hosted installation: its Google OAuth client is the deployment's
      // own, so Google's panel is one button.
      hostedGoogle = true;
      response = Response.json({ hosted: true, clientId: JOURNEY_GOOGLE_CLIENT_ID });
    } else if (url.pathname === "/__journey/google-revoked" && request.method === "POST") {
      // Google stops accepting the stored sign-in: the
      // outcome a collection stamps, in the ingest's own words, standing in
      // for Google's invalid_grant. Sign in to Google first; the sign-in's own
      // success is stamped at the fixture's clock, so the refusal comes a
      // second after it.
      await ingestCode.recordCredentialOutcome(ingestEnv(), "google",
        { ok: false, error: ingestCode.GOOGLE_OAUTH_REVOKED_MESSAGE, at: new Date(Date.parse(JOURNEY_NOW) + 1000).toISOString() });
      response = Response.json({ revoked: true, lastError: ingestCode.GOOGLE_OAUTH_REVOKED_MESSAGE });
    } else if (url.pathname === "/__journey/counters" && request.method === "POST") {
      // The site's all-time totals: three cards in the
      // register, and the counters lane's reading for two of them,
      // `?minutesAgo=` before the fixture's clock (default 10; past 30 is two
      // 15-minute cadences, amber). The third has no reading and no report.
      if (!await siteStored(JOURNEY_ASSET)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        const counters = documents["config/counters.json"] as { assets: Record<string, unknown> };
        counters.assets[JOURNEY_ASSET] = { heading: "All-time totals", cards: JOURNEY_COUNTER_CARDS };
        versions.set("config/counters.json", (versions.get("config/counters.json") ?? 0) + 1);
        const at = new Date(Date.parse(JOURNEY_NOW) - Number(url.searchParams.get("minutesAgo") ?? 10) * 60_000).toISOString();
        // On Postgres, where the site's totals are read.
        await postgres.current().store.write((tx) =>
          tx.execute(
            `INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
             SELECT $1::uuid, $2, r.metric, r.value, $3::timestamptz FROM unnest($4::text[], $5::bigint[]) AS r(metric, value)
             ON CONFLICT (workspace_id, asset_id, metric) DO UPDATE SET value = excluded.value, observed_at = excluded.observed_at`,
            [tx.workspaceId, JOURNEY_ASSET, at, ["accounts", "leads"], [1284, 312]],
          ),
        );
        response = Response.json({ seeded: true, observedAt: at, cards: JOURNEY_COUNTER_CARDS });
      }
    } else if (url.pathname === "/__journey/refused-tower" && request.method === "POST") {
      // A stored config/tower.json the Tower cannot read in one part, as a
      // hand edit or a store written before a contract change leaves it:
      // written straight into the store, never through a Save.
      // `?part=wall`: a layout with no rows, beside one version that still
      // reads. `?part=countdown`: a countdown with no emoji, beside a valid
      // saved layout.
      const siteRows = { version: 1, rows: [{ id: "strip", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] },
        { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }] };
      const part = url.searchParams.get("part");
      const tower = { ...(documents["config/tower.json"] as Record<string, unknown>) };
      if (part === "wall") {
        tower.wall = { layout: { version: 1, rows: [] },
          history: [{ savedAt: new Date(Date.parse(JOURNEY_NOW) - 86_400_000).toISOString(), reason: "Strip and sites", layout: siteRows }] };
      } else if (part === "countdown") {
        tower.wall = { layout: siteRows, history: [] };
        tower.countdown = { emoji: "", label: "Launch", targetAt: new Date(Date.parse(JOURNEY_NOW) + 20 * 86_400_000).toISOString() };
      }
      if (part === "wall" || part === "countdown") {
        documents["config/tower.json"] = tower;
        versions.set("config/tower.json", (versions.get("config/tower.json") ?? 0) + 1);
        response = Response.json({ stored: tower });
      } else {
        response = Response.json({ error: "part is wall or countdown" }, { status: 400 });
      }
    } else if (url.pathname === "/__journey/redirect-away") {
      // A route that sends the browser to another site, as an OAuth start or
      // a billing portal would: the offline guard must refuse it.
      response = new Response(null, { status: 302, headers: { location: "https://example.com/" } });
    } else if (url.pathname === "/__journey/fail-next-save" && request.method === "POST") {
      failNextSave = true; response = Response.json({ armed: true });
    } else if (url.pathname === "/__journey/receive" && request.method === "POST") {
      response = await receiveData();
    } else if (url.pathname === "/__journey/tasks-snapshot" && request.method === "POST") {
      // The local runner's task-board refresh, on demand: the snapshot the
      // desk's task reads come from. `/__journey/receive` files it beside its
      // synthetic collection; a journey whose data came from the real
      // collector (Start collecting) asks for it here.
      publishTasks();
      response = Response.json({ published: true });
    } else if (url.pathname === "/__journey/core-tasks" && request.method === "POST") {
      // A provisioned core project uses the existing is_os asset model. Only
      // this fixture's Postgres and fake bd receive writes; no user site exists.
      taskProject = JOURNEY_CORE_PROJECT;
      tasks = [];
      await postgres.current().store.write((tx) => tx.execute(
        `INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
         VALUES ($1::uuid, $2, NULL, 'NoticeOS', 'live', false, true, $3::timestamptz, $3::timestamptz)`,
        [tx.workspaceId, taskProject.asset, JOURNEY_NOW],
      ));
      const saved = documents["config/beads.json"] as { spokes: unknown[] };
      saved.spokes = [structuredClone(taskProject)];
      versions.set("config/beads.json", (versions.get("config/beads.json") ?? 0) + 1);
      publishTasks();
      response = Response.json({ project: taskProject.asset });
    } else if (url.pathname === "/__journey/task-source" && request.method === "POST") {
      // Publish the fixture's synthetic site task project: the fixture's
      // task project saved, as Settings → Task projects saves it, and the
      // runner's first snapshot of it filed. Before this the installation has
      // no project snapshot yet; Tasks remains reachable.
      if (!savedTaskProjects().includes(JOURNEY_ASSET)) {
        const saved = documents["config/beads.json"] as { spokes: unknown[] };
        saved.spokes.push(structuredClone(JOURNEY_TASK_PROJECT));
        versions.set("config/beads.json", (versions.get("config/beads.json") ?? 0) + 1);
      }
      publishTasks();
      response = Response.json({ connected: "beads", project: JOURNEY_TASK_PROJECT.asset });
    } else if (url.pathname === "/__journey/every-source" && request.method === "POST") {
      // Before creating the asset: Add a site then writes a cell for every
      // property data source, exactly as it does against a full catalog.
      const config = documents["config/integrations.json"] as { catalog: { id: string }[] };
      for (const row of EVERY_SOURCE_CATALOG) {
        if (!config.catalog.some((entry) => entry.id === row.id)) config.catalog.push(structuredClone(row));
      }
      versions.set("config/integrations.json", (versions.get("config/integrations.json") ?? 0) + 1);
      response = Response.json({ catalog: config.catalog.map((entry) => entry.id) });
    } else if (url.pathname === "/__journey/connection-history" && request.method === "POST") {
      // System health's daily record of its four connection counts: `?days=`
      // earlier days written by the production recorder, so the Connections
      // strip draws the line an installation draws after that many days.
      // Today's row is the hourly tick's, run here as the Worker's cron runs
      // it over this store and its saved settings, which also records each
      // data source's day for the Source history; only the earlier days'
      // counts are the fixture's.
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 6) || 6));
      for (let back = days; back >= 1; back -= 1) {
        await recordConnectionStatusDay(postgres.current().store, {
          sitesFailing: back % 3 === 0 ? 1 : 0,
          sitesOverdue: back % 4 === 0 ? 1 : 0,
          reportsMissing: Math.min(3, back),
          sitesWorking: back > 4 ? 0 : 1,
        }, new Date(Date.now() - back * 86_400_000));
      }
      const today = await runTowerCron(HOURLY_TICK, { STORE: postgres.current().store, INGEST: ingest, config: towerConfigResolver(ingest, compiledConfig()) });
      response = Response.json({ days, today: today.map((step) => step.state) });
    } else if (url.pathname === "/__journey/older-settings" && request.method === "POST") {
      // A settings document saved before these keys existed:
      // the stored constants lack the monthly cap and the time rate, so
      // Settings shows the compiled values until a Save creates the keys.
      const constants = documents["config/constants.json"] as Record<string, unknown>;
      delete constants.monthly_caps;
      delete constants.operator_rate_usd_per_min;
      versions.set("config/constants.json", (versions.get("config/constants.json") ?? 0) + 1);
      response = Response.json({ constants });
    } else if (url.pathname === "/__journey/undeclared-source" && request.method === "POST") {
      // A site with no status for a catalog data source:
      // what a hand-written or product-update changeset can leave behind. The
      // site's first declared source loses its entry; `?lane=` picks another.
      const config = documents["config/integrations.json"] as { assets: Record<string, Record<string, unknown>> };
      const declared = config.assets[JOURNEY_ASSET];
      const lane = url.searchParams.get("lane") ?? Object.keys(declared ?? {})[0];
      if (!declared || !lane || !(lane in declared)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        delete declared[lane];
        versions.set("config/integrations.json", (versions.get("config/integrations.json") ?? 0) + 1);
        response = Response.json({ asset: JOURNEY_ASSET, lane });
      }
    } else if (url.pathname === "/__journey/uptime" && request.method === "POST") {
      // The hourly uptime check, run by the production ingest lane over this
      // store. The only stand-in is the site itself: its home page answers
      // `?status=` (default 200), `?minutesAgo=` (default 12) before the
      // fixture's clock; with `?transient=1` only the first GET gets that
      // status and the confirming retry gets the page, which the lane asks at
      // once here rather than after 45 seconds. Nothing leaves this process.
      if (!await siteStored(JOURNEY_ASSET)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        const answer = Number(url.searchParams.get("status") ?? 200);
        const minutesAgo = Number(url.searchParams.get("minutesAgo") ?? 12);
        const transient = url.searchParams.get("transient") === "1";
        const home = `https://${JOURNEY_ASSET}/`;
        let tries = 0;
        const site: typeof fetch = async (input) => {
          const target = input instanceof Request ? input.url : String(input);
          if (target !== home) throw new Error(`The journey network has no ${target}`);
          tries += 1;
          return answer === 200 || (transient && tries > 1)
            ? new Response("<!doctype html><html><body><p>Journey Example home page</p></body></html>", { status: 200, headers: { "content-type": "text/html" } })
            : new Response("unavailable", { status: answer });
        };
        const run = await ingestCode.runUptimeChecks(ingestEnv(), { fetchImpl: site, nowMs: Date.parse(JOURNEY_NOW) - minutesAgo * 60_000, confirmWaitMs: 0 });
        response = Response.json(run);
      }
    } else if (url.pathname.startsWith("/__journey/after-failure/") && request.method === "POST") {
      // A failure's own words, reached through the lane that writes them:
      // each state below is the production lane run over this store, with
      // only the provider's or the site's answer the fixture's, so a capture
      // shows what an installation shows.
      response = await afterFailure(url.pathname.slice("/__journey/after-failure/".length));
    } else if (url.pathname === "/__journey/finding" && request.method === "POST") {
      // One saved finding on the fixture asset, after the real wizard created it.
      if (!await siteStored(JOURNEY_ASSET)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        // On Postgres, where the publisher writes it.
        await writeInsightSnapshots(postgres.current().store, [{
          id: "journey-finding", asset: JOURNEY_ASSET, generated_at: JOURNEY_NOW, window_start: "2026-08-30",
          window_end: "2026-09-05", payload: JSON.stringify(journeyFindingSnapshot()),
        }]);
        response = Response.json({ seeded: true, key: JOURNEY_FINDING_KEY });
      }
    } else if (url.pathname === "/__journey/costs" && request.method === "POST") {
      // Booked monthly costs for a site the wizard created,
      // `{ asset?, months: { "YYYY-MM": cents } }`, estimated as the cost
      // import books them — so Financials' revenue, cost and net are three
      // different lines, and a month can fall below zero.
      const body = await request.json() as { asset?: string; months?: Record<string, number> };
      const asset = body.asset ?? JOURNEY_ASSET;
      const months = Object.entries(body.months ?? {});
      if (!await siteStored(asset)) {
        response = Response.json({ error: "Create the site first." }, { status: 409 });
      } else if (months.length === 0 || months.some(([period, cents]) => !/^\d{4}-\d{2}$/.test(period) || !Number.isInteger(cents) || cents < 0)) {
        response = Response.json({ error: "months maps YYYY-MM to whole cents." }, { status: 400 });
      } else {
        // Into the ledger on Postgres, where the Tower reads it.
        await bookLedger(postgres.current().store, months.map(([period, cents]) => ({
          kind: 'cost' as const, asset, period, family: 'infra', amount_minor: cents, currency: 'USD', source: null,
          booking_state: 'estimated' as const, recorded_at: JOURNEY_NOW,
        })));
        response = Response.json({ seeded: true, asset, months: months.length });
      }
    } else if (url.pathname === "/__journey/serp-panel" && request.method === "POST") {
      // A saved analysis with one tracked search panel, in
      // the market `?market=<locationCode>-<languageCode>` names, or none.
      const [location, language] = (url.searchParams.get("market") ?? "").split("-");
      const market = location && language ? { locationCode: Number(location), languageCode: language } : null;
      if (!await siteStored(JOURNEY_ASSET)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        const snapshot = journeySerpPanelSnapshot(market);
        await writeInsightSnapshots(postgres.current().store, [{
          id: "journey-serp-panel", asset: JOURNEY_ASSET, generated_at: JOURNEY_NOW, window_start: snapshot.windowStart,
          window_end: snapshot.windowEnd, payload: JSON.stringify(snapshot),
        }]);
        response = Response.json({ seeded: true, market });
      }
    } else if (url.pathname === "/__journey/posthog" && request.method === "POST") {
      // A site whose only collected source is PostHog: the
      // saved analysis its product archive produces, standing in for the
      // external collector and the nightly analysis.
      if (!await siteStored(JOURNEY_ASSET)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        const snapshot = journeyPosthogSnapshot();
        await writeInsightSnapshots(postgres.current().store, [{
          id: "journey-posthog", asset: JOURNEY_ASSET, generated_at: JOURNEY_NOW, window_start: snapshot.windowStart,
          window_end: snapshot.windowEnd, payload: JSON.stringify(snapshot),
        }]);
        response = Response.json({ seeded: true, days: snapshot.product.webDaily.days.length });
      }
    } else if (url.pathname === "/__journey/fetch-failures" && request.method === "POST") {
      // The fixture site's nightly report fetched by the OS, and failing: the
      // site gets a nightly-fetch entry, then the
      // production pull lane runs over this store once a night for `?nights=`
      // nights (default 3) before the fixture's clock. The site answers 503
      // "unconfigured" on the first night and 401 "unauthorized" after it.
      // Nothing leaves this process; the token is a synthetic one.
      if (!(await postgres.current().store.read((tx) => tx.query("SELECT 1 FROM noticeos.assets WHERE asset_id = $1", [JOURNEY_ASSET]))).length || !ingestCode.runPullAdapter) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        const nights = Math.min(7, Math.max(1, Number(url.searchParams.get("nights") ?? 3) || 3));
        const entry = { asset: JOURNEY_ASSET, url: `https://${JOURNEY_ASSET}/api/os/report`, enabled: true, format: "envelope" as const };
        const pull = documents["config/pull.json"] as unknown[];
        if (!pull.some((row) => (row as { asset?: string }).asset === JOURNEY_ASSET)) {
          pull.push(entry);
          versions.set("config/pull.json", (versions.get("config/pull.json") ?? 0) + 1);
        }
        const outcomes: unknown[] = [];
        for (let back = nights; back >= 1; back -= 1) {
          const site: typeof fetch = async (input) => {
            const target = input instanceof Request ? input.url : String(input);
            if (target !== entry.url) throw new Error(`The journey network has no ${target}`);
            return back === nights
              ? Response.json({ error: "unconfigured", message: "Overview unavailable: set CF_ACCOUNT_ID" }, { status: 503 })
              : Response.json({ error: "unauthorized" }, { status: 401 });
          };
          const run = await ingestCode.runPullAdapter({ ...ingestEnv(), ASSET_TOKENS: JSON.stringify({ [JOURNEY_ASSET]: "journey-pull-token" }) }, {
            entries: [entry], fetchImpl: site, nowMs: Date.parse(JOURNEY_NOW) - back * 86_400_000 + 2 * 3_600_000,
          });
          outcomes.push(...run.outcomes);
        }
        response = Response.json({ nights, outcomes });
      }
    } else if (url.pathname === "/__journey/nightly-report" && request.method === "POST") {
      // One nightly report from the fixture site, `?hoursAgo=` before the
      // fixture's clock (default 72: overdue), standing in for the site's own
      // sender: the row POST /api/pulse stores.
      if (!await siteStored(JOURNEY_ASSET)) {
        response = Response.json({ error: "Create the fixture asset first." }, { status: 409 });
      } else {
        const hours = Number(url.searchParams.get("hoursAgo") ?? 72);
        const at = new Date(Date.parse(JOURNEY_NOW) - hours * 3_600_000).toISOString();
        // On Postgres, where the Tower reads reports: a second one for the
        // same day is that day's next revision.
        await postgres.current().store.write((tx) =>
          tx.execute(
            `INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, revision, received_at, envelope)
             SELECT $1::uuid, $2, $3::date, coalesce(max(revision), 0) + 1, $4::timestamptz, '{"metrics":{}}'
               FROM noticeos.pulses WHERE asset_id = $2 AND pulse_date = $3::date`,
            [tx.workspaceId, JOURNEY_ASSET, at.slice(0, 10), at],
          ),
        );
        response = Response.json({ seeded: true, receivedAt: at });
      }
    } else if (url.pathname === "/__journey/wall-feed" && request.method === "POST") {
      // The live feed's stored events: rows, not a payload,
      // so /api/wall/feed runs its real read over them.
      await feedSitesIntoPostgres();
      await seedWallFeedRevenue(postgres.current().store, JOURNEY_NOW);
      await seedWallFeedProviderReports(postgres.current().store, JOURNEY_NOW);
      await seedWallFeedAlertsAndReports(postgres.current().store, JOURNEY_NOW);
      await seedWallFeedTasks(postgres.current().store, JOURNEY_NOW);
      await seedWallFeedRuns(postgres.current().store, JOURNEY_NOW);
      await seedWallFeedChanges(postgres.current().store, JOURNEY_NOW);
      response = Response.json({ seeded: true, now: JOURNEY_NOW });
    } else if (url.pathname === "/__journey/archived-site" && request.method === "POST") {
      // An archived site whose id is not its domain, in the Postgres copy.
      const { id, domain, displayName } = JOURNEY_ARCHIVED_SITE;
      const status = url.searchParams.get('status') === 'live' ? 'live' : 'retired';
      await postgres.current().store.write((tx) =>
        tx.execute(
          `INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $6, true, false, $5::timestamptz, $5::timestamptz)
           ON CONFLICT DO NOTHING`,
          [tx.workspaceId, id, domain, displayName, JOURNEY_NOW, status],
        ),
      );
      response = Response.json({ seeded: true, ...JOURNEY_ARCHIVED_SITE });
    } else if (url.pathname === "/__journey/wall-feed-event" && request.method === "POST") {
      // One new stored event, for the arrival journey.
      await injectWallFeedEvent(postgres.current().store, JOURNEY_NOW);
      response = Response.json({ injected: true, text: WALL_FEED_INJECTED_TEXT });
    } else if (url.pathname === '/__journey/revenue-history' && request.method === 'POST') {
      // Complete reports through the provider's declared Pacific cutoff,
      // separately from the fixture's saved operator clock. The answer carries
      // fixture's day-by-day money for last month and this one, so a journey
      // derives what the Wall must say instead of copying a number that only
      // held on one operator's clock.
      const now = new Date(JOURNEY_NOW);
      const timeZone = savedOsTimeZone(documents['config/constants.json'], JOURNEY_TIME_ZONE);
      const today = revenueCalendarDate(now, timeZone);
      const reportingTimeZone = MEDIAVINE_REPORTING_CLOCK.timeZone;
      const reportingToday = revenueCalendarDate(now, reportingTimeZone);
      const through = revenueExpectedThrough(now, MEDIAVINE_REPORTING_CLOCK);
      // `?traffic=none`: the money alone, for a site whose first source is ad
      // revenue.
      await seedRevenueHistory(postgres.current().store, JOURNEY_ASSET, JOURNEY_NOW, through, 'US', { traffic: url.searchParams.get('traffic') !== 'none' });
      const config = documents['config/integrations.json'] as { assets: Record<string, Record<string, Record<string, unknown>>> };
      config.assets[JOURNEY_ASSET]!['ad-network']!.revenueHolidayCalendar = 'US';
      const holidays = syntheticRevenueHolidays('US', Number(through.slice(0, 4)));
      const from = shiftRevenueDate(`${today.slice(0, 7)}-01`, -1).slice(0, 7) + '-01';
      const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0, 12)).toISOString().slice(0, 10);
      const days: { date: string; amountMinor: number }[] = [];
      for (let date = from; date <= monthEnd; date = shiftRevenueDate(date, 1)) {
        days.push({ date, amountMinor: syntheticRevenueDay(date, holidays).amountMinor });
      }
      response = Response.json({ seeded: true, timeZone, today, reportingTimeZone, reportingToday, through, days });
    } else if (url.pathname === "/api/config" && request.method === "PUT" && await savesTaskProject(request)) {
      // A task project saved (the connect panel's Beads, Settings → Task
      // projects). The Worker refuses these, since a project belongs to the
      // machine its checkout is on, and a local Tower's own write lane takes
      // them, store first (vite/config-write-lane.ts). This is that lane's
      // store write, with no checkout to export to or commit.
      const body = await request.json() as { ops: unknown[]; slug?: string };
      const result = await ingest.applyConfigOps({ ops: body.ops, actor: "operator", ...(body.slug ? { slug: body.slug } : {}), reason: null, expectVersions: null });
      if (result.ok) {
        response = Response.json({ applied: result.applied ?? body.ops.length, archive: null, commit: null });
      } else {
        const { ok: _ok, ...refusal } = result;
        response = Response.json(refusal, { status: configWriteStatus(result.error) });
      }
    } else if (ownsPath(url.pathname)) {
      const reply = await handleTasksRequest({ method: request.method, url: request.url,
        headers: Object.fromEntries(request.headers), body: request.method === "GET" ? "" : await request.text() },
      { repoRoot: fixtureRoot, readProjects, actor: "journey-fixture", now: () => new Date(JOURNEY_NOW), run: runBd });
      response = Response.json(reply.body, { status: reply.status });
    } else if (url.pathname.startsWith("/api/")) {
      response = await worker.fetch(request, { NOTICEOS_WORKSPACE_PROFILE: "standalone", INGEST: ingest, POSTGRES: { connectionString: postgres.current().url } }, CALL_CONTEXT);
    } else {
      response = Response.json({ error: "Unknown fixture control" }, { status: 404 });
    }
    // A photograph a task command filed lands before its answer leaves.
    const filed = publishing;
    publishing = Promise.resolve();
    await filed;
    if (!url.pathname.startsWith("/__journey/")) requests.push({ method: request.method, path: url.pathname, status: response.status });
    return response;
  }
  return {
    fetch: fetchRequest,
    /** Before the first request: this server's own Postgres copy. */
    ready: () => postgres.ready(),
    async close() {
      await postgres.close();
    },
  };
}
