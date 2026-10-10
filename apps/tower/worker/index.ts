import { CLOUDFLARE_D1_BACKUP_PATH } from '@noticeos/contract/cloudflare-d1';
import { withAppRelease } from '../shared/app-release';
import { snapshotRpcData } from "./rpc-data";
// Tower API Worker over the ONE central store. Reads dominate; the only direct
// writes are two narrow operator lanes — a disposition/resolution on an
// existing flag, and the operator's own decisions about one asset's queries
// and findings. Neither rewrites a row of provider evidence. Four further
// operator writes are not made here at all — the timeline annotation, the
// pre-registered outcome check, an asset's editable settings columns, and the
// birth of an asset row itself — but proxied over the private INGEST
// Service Binding to the worker that owns those tables (annotation-route.ts,
// watch-window-route.ts, asset-column-route.ts, asset-lifecycle-route.ts). None
// of them is a MIGRATION: the schema stays operator-only (AGENTS.md). One READ
// takes the same binding for the same reason — the alert-rule replay
// (rule-backtest-route.ts) needs the seasonal baselines ingest assembles.
// Configuration saves also use the private INGEST binding: the guarded write
// lands in the store without a changeset file or Git commit (D22).
// /api/tasks/* and /api/gates/* use a host-only lane for the Dolt task hub
// on the operator's Mac (D19, tasks-route.ts). Only /api/*
// reaches here (run_worker_first in wrangler.jsonc); every other path is served
// as a static asset with SPA fallback and never costs a Worker invocation.

import { BROWSER_SESSION_PATH, handleBrowserSessionRequest } from './browser-session-route';
import { handleAuthRequest, type AuthEntryBindings } from './auth-route';
import { handleAgentSignInRequest, isAgentSignInPath } from './agent-sign-in-route';
import { bearerChallenge, bearerToken } from '../../../scripts/agent-access.mjs';
import { handleMembershipRequest } from './membership-route';
import { MEMBERSHIP_PATH, ACCEPT_INVITATION_PATH } from '../../../scripts/identity-protocol.mjs';
import { demoViewer } from '../shared/demo-viewer';
import { demoViewerReadResponse, demoViewerResponse } from './demo-viewer-route';
import { requireStandaloneWorkspace, withWorkspaceEntry, workspaceEntryOrigin, workspaceProfile, type WorkspaceEntryBindings } from '../../../scripts/workspace-entry.mjs';
import { isCloudflareD1Request, cloudflareD1Request } from '../../../scripts/workspace-operations.mjs';
import { crossOrigin } from './http';
import { GOOGLE_INTEGRATION_START, GOOGLE_INTEGRATION_CALLBACK, isHostedStoredRead, isHostedGoogleDiscovery, connectionReadinessRequest, credentialWriteRequest, providerCollectionRequest, liveProviderReadRequest, storedResearchReadRequest, watchQueryHistoryRequest } from '../../../scripts/workspace-operations.mjs';
import { type AnnotationWriter, handleAnnotationRequest } from "./annotation-route";
import { type AssetColumnWriter, handleAssetColumnRequest } from "./asset-column-route";
import { type AssetOrderWriter, handleAssetOrderRequest } from './asset-order-route';
import { type AssetLifecycleWriter, handleCreateAssetRequest } from "./asset-lifecycle-route";
import { type CalendarReader, handleCalendarUpcomingRequest } from "./calendar-upcoming-route";
import { handleConfigRequest } from "./config-route";
import { handleStoredRead } from "./stored-read-route";
import { handleIntegrationSummaryRead } from './integration-summary-route';
import { handleHostedWorkflowRead } from './hosted-workflow-read';
import { handleDemoPresentationRead, type DemoPresentationBindings } from './demo-presentation-route';
import { DEMO_PRESENTATION_PATH } from '../shared/demo-presentation';
import { compiledConfig } from "./compiled-config";
import {
  type ConfigDocumentReader,
  towerConfigResolver,
} from "./config-source";
import { handleIntegrationHealthRequest } from "./connection-status-daily";
import { type CallContext, type StoreBinding, type WorkspaceStore, withWorkspaceStore } from "@noticeos/postgres";
import { handleDecisionsRequest } from "./decision-route";
import { handleFlagRequest } from "./flag-route";
import { handleHostedAssetMutation } from './hosted-asset-mutation-route';
import { JSON_HEADERS } from "./http";
import {
  INTEGRATION_PROVIDERS_PATH,
  type IntegrationCredentialWriter,
  handleEnvImportRequest,
  handleIntegrationConnectRequest,
  handleIntegrationSiteTokenRequest,
  handleIntegrationCredentialRequest,
  handleIntegrationExpiryRequest,
  handleIntegrationProvidersRequest,
  handleIntegrationTestRequest,
} from "./integrations-route";
import { handleMediavineRequest, type MediavineBinding } from './mediavine-route';
import { loadProviderMeter, loadSpendPreview } from "./metered-spend";
import { SITES_PATH, handleSitesRequest, handleCollectRequest, type SiteDiscoveryIngest } from "./site-discovery-route";
import { handleGa4RealtimeRequest } from './ga4-realtime-route';
import { SITE_NAME_PATH, handleSiteNameRequest } from "./site-name-route";
import { ENV_IMPORT_PATH } from "../shared/env-import";
import {
  type GoogleOAuthIngest,
  handleGoogleOAuthCallbackRequest,
  handleGoogleOAuthStartRequest,
  handleGooglePropertiesRequest,
} from "./integrations-oauth-route";
import { type McpIngest, handleMcpRequest, mcpDependencies } from "./mcp-route";
import { type RuleBacktester, handleRuleBacktestRequest } from "./rule-backtest-route";
import { type RunnerIngest, handleRunnerRequest } from "./runner-route";
import { runTowerCron } from "./tower-cron";
import { handleTasksRequest, isTasksPath } from "./tasks-route";
import { type WatchWindowWriter, handleWatchWindowRequest } from "./watch-window-route";
import {
  type WatchQueryHistoryReader,
  handleWatchQueryHistoryRequest,
} from "./watch-query-history-route";
import { RUNNER_PATH_PREFIX } from "../shared/runner-lane";
import {
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_OAUTH_START_PATH,
  GOOGLE_PROPERTIES_PATH,
  integrationProvider,
} from "@noticeos/contract";

// The settings compiled into this bundle, the fallback under every stored
// setting, are gathered in compiled-config.ts.
//
// True only for `vite` (dev), false for `vite build` — so the local runner's
// lane is compiled OUT of every deployed bundle rather than merely guarded in
// it. See shared/runner-lane.ts.
declare const __RUNNER_LANE__: boolean;

/**
 * The bindings this switch actually reaches for, declared STRUCTURALLY — the
 * same structural boundary every route file beside this one uses, for the
 * same two reasons: it keeps the module free of the Workers ambient globals (so
 * the test project, which excludes them, can typecheck and drive it — bead
 * `ro-ap7n`), and it lets a test bind a double instead of a Worker RPC stub no
 * unit test can construct.
 *
 * `INGEST` is the INTERSECTION of the slices the routes below declare for
 * themselves, so it stays derived rather than restated: a route that starts
 * calling a new RPC widens its own interface and this one follows. `ASSETS` is
 * absent because nothing here touches it — static assets never reach the Worker
 * (`run_worker_first`, see the file header).
 *
 * The real `Env` still has to satisfy it: `satisfies ExportedHandler<Env>` at
 * the bottom is the deployment contract, and it is what fails if a binding is
 * renamed in wrangler.jsonc.
 */
export interface TowerEnv extends WorkspaceEntryBindings, AuthEntryBindings, DemoPresentationBindings {
  /** The operational store's Hyperdrive binding (wrangler.jsonc; the port
   * pattern). Absent only where nothing reads the store — a test driving a
   * route that never does; every unit of work then refuses, naming it. */
  POSTGRES?: StoreBinding;
  INGEST: AnnotationWriter &
    ConfigDocumentReader &
    AssetColumnWriter &
    AssetOrderWriter &
    AssetLifecycleWriter &
    CalendarReader &
    GoogleOAuthIngest &
    IntegrationCredentialWriter &
    MediavineBinding &
    McpIngest &
    SiteDiscoveryIngest &
    RuleBacktester &
    RunnerIngest &
    WatchQueryHistoryReader &
    WatchWindowWriter & {
      /** The live-visitors read; its payload is passed straight through. */
      ga4Realtime(originalProof?: Request): Promise<unknown>;
      integrationHealth?(originalProof?: Request): Promise<unknown>;
      cloudflareD1?(original: Request): Promise<Response>;
      backupCloudflareD1?(original: Request): Promise<Response>;
    };
}

/** One call's env: the bindings, and the store opened for this call alone. */
export type CallEnv = TowerEnv & { readonly STORE: WorkspaceStore };

/** Every route, run with this call's env: the bindings and this call's own
 * store (`withWorkspaceStore`, below). */
async function route(request: Request, env: CallEnv): Promise<Response> {
  const url = new URL(request.url);

  // Every setting this request reads, resolved once (epic `ro-syok`). Eleven
  // routes below read the same documents; a resolver per request is what stops
  // one page load becoming eleven store reads. Nothing is asked for until a
  // route actually awaits it, so the paths that read no config — the runner
  // lane, the proxied ingest RPCs — still cost nothing.
  const config = towerConfigResolver(env.INGEST, compiledConfig());
  const storedRead = await handleStoredRead(request, { store: env.STORE, config, compiledTimeZone: compiledConfig().osTimeZone });
  if (storedRead !== null) return storedRead;

  // The local runner's private lane into the ingest Worker, which locally has
  // no listener of its own: both Workers share the runner's runtime.
  // First, and behind a compile-time flag: nothing below should ever have to
  // wonder whether a `/api/runner/…` path might mean something else.
  if (__RUNNER_LANE__ && url.pathname.startsWith(RUNNER_PATH_PREFIX)) {
    return handleRunnerRequest(request, url, env.INGEST, (cron) => runTowerCron(cron, { STORE: env.STORE, INGEST: env.INGEST, config }));
  }

  if (url.pathname === "/api/ga4/realtime" && request.method === "GET") {
    return handleGa4RealtimeRequest(request, env.INGEST);
  }

  if (url.pathname === "/api/calendar/upcoming") {
    return handleCalendarUpcomingRequest(request, env.INGEST);
  }

  // Save availability and per-document sources come from the configuration
  // store. The local lane answers this path before the Worker; deployed saves
  // use the private INGEST binding. Both paths guard the saved value (D22).
  if (url.pathname === "/api/config") {
    return handleConfigRequest(request, { ingest: env.INGEST, config });
  }

  // The task hub, which this runtime cannot reach: a Dolt server on the
  // operator's Mac, spoken to by a `bd` binary there is no process here to
  // spawn. Locally these paths never arrive — the task lane answers them in
  // the dev server (apps/tower/vite/task-lane.ts, `enforce: "pre"`) and the
  // operator creates, claims, closes and answers work for real (D19). What is
  // left here is the deployed answer: `live: false` with the reason, and 501
  // on everything else, so the board falls back to the `/api/work` snapshot
  // instead of offering actions that cannot land.
  if (isTasksPath(url.pathname)) {
    return handleTasksRequest(url);
  }

  // The asset COLLECTION: creating one. `/api/assets` with no id is the only
  // path that means "all of them", and POST is the only verb it answers —
  // anything else falls through to the 404 at the bottom rather than being
  // mistaken for a drill-down with an empty id (bead ro-z349.1).
  if (url.pathname === "/api/assets" && request.method === "POST") {
    return handleCreateAssetRequest(request, url, env.INGEST);
  }

  // The name a site gives itself, for the add screen (bead
  // `ro-ujb9.96.7.5`). Reads no store and no config: a public page's title.
  if (url.pathname === SITE_NAME_PATH) {
    return handleSiteNameRequest(request, url);
  }

  // ONE asset, two verbs on one URL, because it is one resource and D20
  // makes `/api/assets/:id` its name:
  //
  //   PATCH  — the STORE-owned settings (lifecycle stage, automation mode,
  //            display name), written over the ingest Service Binding so they
  //            save in every deployment (D18).
  //   GET    — answered by the shared stored-read dispatcher above.
  //
  // No DELETE: a site is never deleted, only archived (bead `ro-ujb9.76.4.5`).
  // Any other verb is refused, never read as the GET: a page loaded before the
  // Delete card went must not take a 200 for "deleted".
  //
  // So the method is part of the match. Matched BEFORE the sub-path routes is
  // safe because this pattern rejects a slash in the id, and ids contain dots,
  // never slashes — `/api/assets/x/decisions` cannot land here.
  const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  const orderMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/order$/);
  if (orderMatch) return handleAssetOrderRequest(request, url, env.INGEST, orderMatch[1]!);
  if (assetMatch && request.method === "PATCH") {
    return handleAssetColumnRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(assetMatch[1]!),
    );
  }
  if (assetMatch && request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET, PATCH" } });
  }

  const flagMatch = url.pathname.match(/^\/api\/flags\/([1-9]\d*)$/);
  if (flagMatch && request.method === "PATCH") {
    return handleFlagRequest(
      request,
      url,
      env.STORE,
      Number(flagMatch[1]),
      new Date().toISOString(),
    );
  }

  // Operator decisions on this asset's queries and findings. Matched
  // BEFORE the drill-down read below, which treats the whole path remainder
  // as the asset id (ids contain dots, never slashes).
  const decisionsMatch = url.pathname.match(/^\/api\/assets\/(.+)\/decisions$/);
  if (decisionsMatch) {
    return handleDecisionsRequest(
      request,
      url,
      env.STORE,
      decodeURIComponent(decisionsMatch[1]!),
      new Date().toISOString(),
    );
  }

  // Timeline events the operator records from the asset page, written by
  // ingest over the Service Binding. Same ordering rule as the decisions
  // route above.
  const annotationsMatch = url.pathname.match(
    /^\/api\/assets\/(.+)\/annotations$/,
  );
  if (annotationsMatch) {
    return handleAnnotationRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(annotationsMatch[1]!),
    );
  }

  // Pre-registered outcome checks the operator opens from the asset page
  // (bead `ro-71r`) — proxied to ingest over the same Service Binding, and
  // validated by the same writer the operator-bearer lane uses.
  const watchWindowsMatch = url.pathname.match(
    /^\/api\/assets\/(.+)\/watch-windows$/,
  );
  if (watchWindowsMatch) {
    return handleWatchWindowRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(watchWindowsMatch[1]!),
    );
  }

  // One exact query's retained daily history, read only while a query-scoped
  // composer is open. Match before the general asset drill-down below.
  const watchQueryHistoryMatch = url.pathname.match(
    /^\/api\/assets\/(.+)\/watch-query-history$/,
  );
  if (watchQueryHistoryMatch) {
    return handleWatchQueryHistoryRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(watchQueryHistoryMatch[1]!),
    );
  }

  // The explicit standalone adapter uses the ordinary stored MCP builders.
  if (url.pathname === "/api/mcp") {
    return handleMcpRequest(request, env.STORE,
      mcpDependencies(await config(), env.INGEST ?? null), demoViewer());
  }

  // "How often would this rule have fired in the last 30 days with these
  // settings?" (bead `ro-u072`) — the preview docs/15 principle 1 asks a rule
  // edit to show before it saves. READ-ONLY despite the POST: the question's
  // key is a whole settings object the operator is still typing, and the
  // replay writes no flag, no disposition and no config. It is proxied to
  // ingest because the seasonal baseline it must be judged against is
  // assembled from the `pulses` table that Worker owns.
  if (url.pathname === "/api/alerts/backtest") {
    return handleRuleBacktestRequest(request, url, env.INGEST);
  }

  // Portfolio integration matrix (desk-only surface; the Wall never links here).
  if (url.pathname === "/api/integrations/health") {
    // Reads only: the hourly tick records the strip's four counts
    // (tower-cron.ts, bead ro-ujb9.96.7.29).
    return handleIntegrationHealthRequest(request, env.INGEST, env.STORE, new Date());
  }

  // The Integrations page's own surface: which providers the OS holds a
  // credential for, and connecting / testing / disconnecting one (epic
  // `ro-vu8d`). Deliberately its own paths under the same noun — the exact
  // match above is the lane MATRIX the Health page renders, which answers a
  // different question and must not change shape because a credential did.
  //
  // Matched BEFORE the `:provider` patterns below, because "providers" is a
  // path segment here and would otherwise read as a provider id.
  // Signing in to Google (bead `ro-vu8d.3`). Matched BEFORE the `:provider`
  // patterns below, because `google` is a provider id and
  // `/api/integrations/google/oauth/start` would otherwise read as one of
  // them with a nonsense tail.
  if (url.pathname === GOOGLE_OAUTH_START_PATH) {
    return handleGoogleOAuthStartRequest(request, url, env.INGEST);
  }
  if (url.pathname === GOOGLE_OAUTH_CALLBACK_PATH) {
    return handleGoogleOAuthCallbackRequest(request, url, env.INGEST);
  }
  if (url.pathname === GOOGLE_PROPERTIES_PATH) {
    return handleGooglePropertiesRequest(request, env.INGEST);
  }
  if (/^\/api\/integrations\/mediavine\/(status|settings|sync)$/.test(url.pathname)) {
    return handleMediavineRequest(request, url, env.INGEST);
  }

  // Moving the legacy env credentials into the store (bead `ro-vu8d.7`).
  // Matched BEFORE the `:provider` patterns for the same reason as
  // "providers": `import-env` is a path segment here, not a provider id.
  // Locally this never arrives — the import lane answers it in the dev server
  // (apps/tower/vite/env-import-lane.ts, `enforce: "pre"`), where the
  // operator's secrets file actually is. What is left here is the deployed
  // answer: `importable: false` with the reason, so the card keeps the command.
  if (url.pathname === ENV_IMPORT_PATH) {
    return handleEnvImportRequest(request);
  }

  if (url.pathname === INTEGRATION_PROVIDERS_PATH) {
    const cfg = await config();
    return handleIntegrationProvidersRequest(
      request,
      env.INGEST,
      cfg.integrations,
      new Date(),
      // What is left of a metered provider's ceiling, from the manifest rows
      // this OS wrote (beads `ro-vu8d.25`, `ro-qpas`) — never a fresh provider
      // call, which on a ten-a-day cap would spend the thing it measures. The
      // dollar cap is the operator's own setting, so it is passed in from the
      // same constants `/settings` edits rather than declared in the catalog.
      (meter, now) => loadProviderMeter(env.STORE, meter, now, cfg.monthlyCaps.dataUsd),
    );
  }
  // The connect panel's site list and Start collecting (bead
  // `ro-ujb9.96.7.2`), Mediavine's included since it joined the panel
  // (`ro-ujb9.96.7.6`).
  const sitesMatch = url.pathname.match(SITES_PATH);
  if (sitesMatch) {
    return handleSitesRequest(
      request,
      url,
      {
        ingest: env.INGEST,
        store: env.STORE,
        config: async () => {
          const cfg = await config();
          return { integrations: cfg.integrations, capUsd: cfg.monthlyCaps.dataUsd };
        },
        spend: (now, capUsd) => loadSpendPreview(env.STORE, now, capUsd),
      },
      decodeURIComponent(sitesMatch[1]!),
      sitesMatch[2] === "collect" ? "collect" : "sites",
    );
  }
  const credentialMatch = url.pathname.match(
    /^\/api\/integrations\/([^/]+)\/credential$/,
  );
  if (credentialMatch) {
    return handleIntegrationCredentialRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(credentialMatch[1]!),
    );
  }
  const credentialExpiryMatch = url.pathname.match(
    /^\/api\/integrations\/([^/]+)\/expiry$/,
  );
  if (credentialExpiryMatch) {
    return handleIntegrationExpiryRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(credentialExpiryMatch[1]!),
    );
  }
  const credentialConnectMatch = url.pathname.match(
    /^\/api\/integrations\/([^/]+)\/connect$/,
  );
  if (credentialConnectMatch) {
    return handleIntegrationConnectRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(credentialConnectMatch[1]!),
    );
  }
  const siteTokenMatch = url.pathname.match(/^\/api\/integrations\/([^/]+)\/site-token$/);
  if (siteTokenMatch) {
    return handleIntegrationSiteTokenRequest(request, url, env.INGEST, decodeURIComponent(siteTokenMatch[1]!));
  }
  const credentialTestMatch = url.pathname.match(
    /^\/api\/integrations\/([^/]+)\/test$/,
  );
  if (credentialTestMatch) {
    return handleIntegrationTestRequest(
      request,
      url,
      env.INGEST,
      decodeURIComponent(credentialTestMatch[1]!),
    );
  }

  if (url.pathname === "/api/health") {
    return Response.json({ ok: true }, { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: JSON_HEADERS,
  });
}

const towerHandler = {
  // Every way in — a request, a scheduled tick — runs with a store of its
  // own, opened for the call and closed when it ends (the ingest does the same).
  async fetch(request: Request, env: TowerEnv, ctx: CallContext): Promise<Response> {
    if ([MEMBERSHIP_PATH, ACCEPT_INVITATION_PATH].includes(new URL(request.url).pathname)) {
      return handleMembershipRequest(request, env);
    }
    // Agent sign-in's discovery documents and OAuth routes come before the
    // email-code entry, which answers only its own three paths.
    if (isAgentSignInPath(new URL(request.url).pathname)) {
      return handleAgentSignInRequest(request, env);
    }
    if (new URL(request.url).pathname.startsWith('/api/auth/')) {
      return handleAuthRequest(request, env);
    }
    // Session facts do not select the sole workspace or open an operational
    // store. Every later workspace action performs its own fresh admission.
    if (new URL(request.url).pathname === BROWSER_SESSION_PATH) {
      return handleBrowserSessionRequest(request, env);
    }
    const viewer = demoViewer();
    const answer = demoViewerResponse(request, viewer);
    if (answer !== null) return answer;
    let profile: ReturnType<typeof workspaceProfile>;
    try { profile = workspaceProfile(env); }
    catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
    if (new URL(request.url).pathname === CLOUDFLARE_D1_BACKUP_PATH) {
      if (profile !== 'standalone' || request.headers.has('origin')) return Response.json({ error: 'forbidden' }, { status: 403 });
      if (!env.INGEST.backupCloudflareD1) return Response.json({ error: 'unavailable' }, { status: 503 });
      try { return await env.INGEST.backupCloudflareD1(request.clone()); }
      catch { return Response.json({ error: 'unavailable' }, { status: 503 }); }
    }
    if (isCloudflareD1Request(request)) {
      try {
        if (profile === 'standalone' && crossOrigin(request, new URL(request.url))) return Response.json({ error: 'forbidden' }, { status: 403 });
        await cloudflareD1Request(request);
        if (!env.INGEST.cloudflareD1) return Response.json({ error: 'unavailable' }, { status: 503 });
        const call = () => env.INGEST.cloudflareD1!(request.clone());
        return profile === 'standalone' ? await call() : await withWorkspaceEntry(env, request.clone(), call);
      } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
    }
    if (profile !== 'standalone') {
      const pathname = new URL(request.url).pathname;
      if (profile === 'hosted' && pathname === GOOGLE_INTEGRATION_CALLBACK) {
        try { return await handleGoogleOAuthCallbackRequest(request, new URL(request.url), env.INGEST, workspaceEntryOrigin(env)); }
        catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      if (profile === 'hosted' && pathname === GOOGLE_INTEGRATION_START && request.method === 'POST') {
        try {
          return await withWorkspaceEntry(env, request.clone(), async () =>
            handleGoogleOAuthStartRequest(request, new URL(request.url), env.INGEST, workspaceEntryOrigin(env)));
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      if (profile === 'hosted' && isHostedGoogleDiscovery(request)) {
        try {
          const proof = request.clone();
          return await withWorkspaceEntry(env, proof, async () => {
            let receiverFailed = false;
            const response = await handleGooglePropertiesRequest(request, {
              async discoverGoogleProperties() {
                try { return await snapshotRpcData(env.INGEST.discoverGoogleProperties(proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
            });
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      const panel = liveProviderReadRequest(request);
      if (profile === 'hosted' && panel) {
        try {
          const proof = request.clone();
          return await withWorkspaceEntry(env, proof, async () => {
            if (panel.method === 'siteName') return handleSiteNameRequest(request, new URL(request.url));
            let receiverFailed = false;
            const ingest = {
              async ga4Realtime() {
                try { return await snapshotRpcData(env.INGEST.ga4Realtime(proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async calendarUpcoming() {
                try { return await snapshotRpcData(env.INGEST.calendarUpcoming(proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
            };
            const response = panel.method === 'ga4Realtime'
              ? await handleGa4RealtimeRequest(request, ingest)
              : await handleCalendarUpcomingRequest(request, ingest);
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      const collection = providerCollectionRequest(request);
      if (profile === 'hosted' && collection && integrationProvider(collection.provider) !== null) {
        try {
          const proof = request.clone();
          return await withWorkspaceEntry(env, proof, async () => {
            let receiverFailed = false;
            const ingest = {
              async collectNow(input: Parameters<SiteDiscoveryIngest['collectNow']>[0]) {
                try { return await snapshotRpcData(env.INGEST.collectNow(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async syncMediavine(input: Parameters<MediavineBinding['syncMediavine']>[0]) {
                try { return await snapshotRpcData(env.INGEST.syncMediavine(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
            };
            const response = collection.method === 'collectNow'
              ? await handleCollectRequest(request, new URL(request.url), ingest, collection.provider)
              : await handleMediavineRequest(request, new URL(request.url), ingest);
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      const credentialWrite = credentialWriteRequest(request);
      if (profile === 'hosted' && credentialWrite && integrationProvider(credentialWrite.provider) !== null) {
        try {
          const proof = request.clone();
          return await withWorkspaceEntry(env, proof, async () => {
            let receiverFailed = false;
            const ingest = {
              async putCredential(input: Parameters<IntegrationCredentialWriter['putCredential']>[0]) {
                try { return await snapshotRpcData(env.INGEST.putCredential(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async deleteCredential(provider: string) {
                try { return await snapshotRpcData(env.INGEST.deleteCredential(provider, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async setCredentialExpiry(input: Parameters<IntegrationCredentialWriter['setCredentialExpiry']>[0]) {
                try { return await snapshotRpcData(env.INGEST.setCredentialExpiry(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async connectCredential(input: Parameters<IntegrationCredentialWriter['connectCredential']>[0]) {
                try { return await snapshotRpcData(env.INGEST.connectCredential(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async putSiteToken(input: Parameters<IntegrationCredentialWriter['putSiteToken']>[0]) {
                try { return await snapshotRpcData(env.INGEST.putSiteToken(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
            };
            const url = new URL(request.url);
            const response = credentialWrite.method === 'setCredentialExpiry'
              ? await handleIntegrationExpiryRequest(request, url, ingest, credentialWrite.provider)
              : credentialWrite.method === 'connectCredential'
                ? await handleIntegrationConnectRequest(request, url, ingest, credentialWrite.provider)
                : credentialWrite.method === 'putSiteToken'
                  ? await handleIntegrationSiteTokenRequest(request, url, ingest, credentialWrite.provider)
                  : await handleIntegrationCredentialRequest(request, url, ingest, credentialWrite.provider);
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      const readiness = connectionReadinessRequest(request);
      if (profile === 'hosted' && readiness && integrationProvider(readiness.provider) !== null) {
        try {
          const proof = request.clone();
          return await withWorkspaceEntry(env, proof, async call => {
            let receiverFailed = false;
            const ingest = {
              async probeCredential(provider: string) {
                try { return await snapshotRpcData(env.INGEST.probeCredential(provider, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async discoverSites(provider: string) {
                try { return await snapshotRpcData(env.INGEST.discoverSites(provider, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async getConfigDocuments(files: string[]) {
                try { return await snapshotRpcData(env.INGEST.getConfigDocuments(files, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async collectNow() { throw new Error('Collection is not available through readiness.'); },
            };
            const response = readiness.method === 'probeCredential'
              ? await handleIntegrationTestRequest(request, new URL(request.url), ingest, readiness.provider)
              : await call.withStore(ctx, async store => {
                  const resolve = towerConfigResolver(ingest, compiledConfig());
                  return handleSitesRequest(request, new URL(request.url), {
                    ingest, store,
                    config: async () => {
                      const cfg = await resolve();
                      if (receiverFailed) throw new Error('Workspace receiver refused.');
                      return { integrations: cfg.integrations, capUsd: cfg.monthlyCaps.dataUsd };
                    },
                    spend: (now, capUsd) => loadSpendPreview(store, now, capUsd),
                  }, readiness.provider, 'sites');
                });
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      // An agent with no credential is told where to sign in (agent-access.mts).
      const agentBearer = pathname === '/api/mcp' && profile === 'hosted' ? bearerToken(request.headers) : null;
      if (pathname === '/api/mcp' && profile === 'hosted' && (agentBearer === false || agentBearer === null && !request.headers.has('cookie'))) {
        return bearerChallenge(workspaceEntryOrigin(env), agentBearer === false ? { error: 'invalid_token' } : undefined);
      }
      if (['/api/mcp', '/api/alerts/backtest'].includes(pathname)) {
        try {
          const proof = request.clone();
          const research = await storedResearchReadRequest(proof);
          if (!research) throw new Error('Stored question unavailable.');
          return await withWorkspaceEntry(env, proof, async call => {
            let receiverFailed = false;
            const ingest = {
              async getConfigDocuments(files: string[]) {
                try { return await snapshotRpcData(env.INGEST.getConfigDocuments(files, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async researchLookup(query: Parameters<McpIngest['researchLookup']>[0]) {
                try { return await snapshotRpcData(env.INGEST.researchLookup(query, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
              async backtestRule(input: Parameters<RuleBacktester['backtestRule']>[0]) {
                try { return await snapshotRpcData(env.INGEST.backtestRule(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
            };
            const response = research.method === 'backtestRule'
              ? await handleRuleBacktestRequest(request, new URL(request.url), ingest)
              : await call.withStore(ctx, async store => {
                const cfg = await towerConfigResolver(ingest, compiledConfig())();
                if (receiverFailed) throw new Error('Workspace receiver refused.');
                return handleMcpRequest(request, store, mcpDependencies(cfg, ingest), viewer);
              });
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch {
          // A refused agent token is a 401, so its client signs in again.
          if (typeof agentBearer === 'string') return bearerChallenge(workspaceEntryOrigin(env), { error: 'invalid_token' });
          return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 });
        }
      }
      const watchHistory = watchQueryHistoryRequest(request);
      if (watchHistory) {
        try {
          const proof = request.clone();
          return await withWorkspaceEntry(env, proof, async () => {
            let receiverFailed = false;
            const ingest: WatchQueryHistoryReader = {
              async watchQueryHistory(input) {
                try { return await snapshotRpcData(env.INGEST.watchQueryHistory(input, proof.clone())); }
                catch (error) { receiverFailed = true; throw error; }
              },
            };
            const response = await handleWatchQueryHistoryRequest(request, new URL(request.url), ingest, watchHistory.asset);
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return response;
          });
        } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
      }
      const mutation = await handleHostedAssetMutation(request, env, ctx);
      if (mutation !== null) return mutation;
      // Only reviewed stored reads and configuration operations enter here;
      // the broad standalone dispatcher never receives hosted capabilities.
      const storedRead = isHostedStoredRead(request);
      if (pathname === DEMO_PRESENTATION_PATH && profile !== 'demo') {
        return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403, headers: JSON_HEADERS });
      }
      if (!storedRead && (pathname !== '/api/config' || !['GET', 'PUT'].includes(request.method))) {
        return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 });
      }
      try {
        // Snapshot the original message before asynchronous authority reads.
        const proof = request.clone();
        return await withWorkspaceEntry(env, proof, async (call) => {
          let receiverFailed = false;
          const ingest: ConfigDocumentReader & {
            listCredentialSummaries(): ReturnType<IntegrationCredentialWriter['listCredentialSummaries']>;
            integrationHealth(): Promise<unknown>;
          } = {
            async getConfigDocuments(files) {
              try { return await snapshotRpcData(env.INGEST.getConfigDocuments(files, proof.clone())); }
              catch (error) { receiverFailed = true; throw error; }
            },
            async applyConfigOps(input) {
              try { return await snapshotRpcData(env.INGEST.applyConfigOps(input, proof.clone())); }
              catch (error) { receiverFailed = true; throw error; }
            },
            async listCredentialSummaries() {
              try { return await snapshotRpcData(env.INGEST.listCredentialSummaries(proof.clone())); }
              catch (error) { receiverFailed = true; throw error; }
            },
            async integrationHealth() {
              try {
                if (!env.INGEST.integrationHealth) throw new Error('Monitoring unavailable');
                return await snapshotRpcData(env.INGEST.integrationHealth(proof.clone()));
              } catch (error) { receiverFailed = true; throw error; }
            },
          };
          const fallbacks = compiledConfig();
          const resolveConfig = towerConfigResolver(ingest, fallbacks);
          const config = async () => {
            const value = await resolveConfig();
            if (receiverFailed) throw new Error('Workspace receiver refused.');
            return value;
          };
          const response = storedRead
            ? await call.withStore(ctx, async store =>
                await handleDemoPresentationRead(request, store, env)
                ?? await handleHostedWorkflowRead(request, store)
                ?? await handleIntegrationSummaryRead(request, { store, config, ingest, now: new Date() })
                ?? handleStoredRead(request, { store, config, compiledTimeZone: fallbacks.osTimeZone }))
            : await handleConfigRequest(request, { ingest, config });
          // Hosted receiver denial never becomes the resolver's standalone
          // compiled-default fallback or a successful tenant response.
          if (receiverFailed || response === null) throw new Error('Workspace receiver refused.');
          // Existing payload builders carry detailed standalone diagnostics.
          // A hosted failure exposes no query, connection or internal detail.
          if (storedRead) {
            if (response.status >= 500) return Response.json({ error: 'workspace_read_unavailable' }, { status: 503, headers: JSON_HEADERS });
            return response;
          }
          if (request.method !== 'GET' || call.context.allowedActions.includes('settings.write')) return response;
          // The ordinary GET exposes only source/version summaries, never raw
          // host documents. An anonymous demo may read them but cannot save.
          const summary = await response.json() as Record<string, unknown>;
          return Response.json({ ...summary, writable: false, reason: profile === 'demo' ? 'Demo is read-only.' : 'Settings are read-only.' }, { status: response.status, headers: response.headers });
        });
      } catch { return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }); }
    }
    const response = await withWorkspaceStore(env.POSTGRES, ctx, (store) => route(request, { ...env, STORE: store }));
    return demoViewerReadResponse(request, viewer, response);
  },

  /** A deployed Tower's cron trigger (wrangler.jsonc): its own steps of a
   * tick, the ones that count with its models (tower-cron.ts, bead
   * `ro-ujb9.96.7.29`). Locally the runner reaches the same function through
   * the ingest door, and the LAN never reaches this handler (runner-door.ts
   * refuses `/cdn-cgi/`). */
  async scheduled(controller: { readonly cron: string }, env: TowerEnv, ctx: CallContext): Promise<void> {
    if (demoViewer() !== null) return;
    requireStandaloneWorkspace(env);
    await withWorkspaceStore(env.POSTGRES, ctx, (store) =>
      runTowerCron(controller.cron, { STORE: store, INGEST: env.INGEST, config: towerConfigResolver(env.INGEST, compiledConfig()) }),
    );
  },
} satisfies ExportedHandler<Env>;

export default {
  ...towerHandler,
  fetch(request: Request, env: TowerEnv, ctx: CallContext): Promise<Response> {
    return withAppRelease(request, () => towerHandler.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
