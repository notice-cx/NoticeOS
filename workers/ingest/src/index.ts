import { GOOGLE_OAUTH_MAINTENANCE_CRON, runOAuthMaintenance } from './oauth-maintenance.js';
import { readIntegrationHealth } from './integration-health-read.js';
import { readCredentialSummaries } from './credential-summaries-read.js';
import { configReadFiles, assetMutationArguments, storedResearchArguments, watchQueryHistoryArguments, configWriteArguments, connectionReadinessArguments, credentialWriteArguments, providerCollectionArguments, googleOAuthArguments, withGoogleWorkspaceEntry, withIntegrationSummaryEntry, withLiveProviderReadEntry, workspaceEntryOrigin, withWorkspaceEntry, workspaceProfile, WorkspaceEntryRefused } from '../../../scripts/workspace-entry.mjs';
import type { WorkspaceStore } from '@noticeos/postgres';
import { integrationProvider } from '@noticeos/contract';
import { ingestOperation } from '../../../scripts/workspace-operations.mjs';

/** The selected store must own every requested portfolio target before
 * opening credentials or asking a provider. Collector mapping rules follow. */
async function assertCollectionAssets(store: WorkspaceStore, assets: readonly string[]): Promise<void> {
  const selected = [...new Set(assets)];
  if (selected.length === 0) return;
  const rows = await store.read(tx => tx.query<{ asset: string }>(
    `SELECT asset_id AS asset FROM noticeos.assets
       WHERE asset_id = ANY($1::text[]) AND NOT is_os AND status <> 'retired'`, [selected]));
  if (rows.length !== selected.length) throw new WorkspaceEntryRefused();
}
// @noticeos/ingest — the pulse ingest + ledger Worker and its self-observing
// crons (docs/02, docs/06, docs/12 build block 3, Phase-0 slice).
//
// Routes:
//   POST /api/pulse         — asset-authed pulse ingest (docs/02)
//   POST /api/revenue       — operator-authed ledger lane v0 (docs/12 #6)
//   POST /api/annotations   — operator-authed timeline events (docs/02 §Annotations)
//   POST /api/watch-windows — operator-authed pre-registered outcome checks (docs/03)
//   POST /api/credentials/rotate-key — operator-authed re-seal of every stored
//                             credential under a new CREDENTIALS_KEY (db/0028)
//   GET  /api/config-documents      — operator-authed read of the stored config (db/0029)
//   POST /api/config-documents/seed — operator-authed load of config/*.json into the store
//   POST /api/config-documents/apply— operator-authed changeset against the stored documents
//   POST /api/beads-snapshot— operator-authed task-hub photograph (db/0017, docs/10 Work)
//   POST /api/job-runs      — operator-authed scheduled-lane firings from the runner (db/0022)
//   GET  /api/job-runs?trigger=manual — operator-authed manual firings, for Workflows' run history
//   POST /api/insight-snapshot — operator-authed executive snapshot publish (db/0008, docs/11)
//   POST /api/asset-state   — operator-authed edit of one sanctioned asset column (db/0001, docs/06)
//   GET  /api/asset-state   — operator-authed read of those columns (the changeset expect guard)
//   POST /api/signal-collect— operator-authed on-demand DataForSEO collection for ONE property (docs/11)
//   POST /api/bing-ai-export— operator-authed import of a downloaded Bing AI Performance export (docs/20)
//   POST /api/research-log/lookup — "has this question already been bought?" (ro-cda6.3)
//   POST /api/research-log        — record a paid provider call
//   GET  /api/provider-spend      — metered provider spend per property per month
//   GET  /api/serp-panel-landings — operator-authed "which panels landed" read (docs/08 §S1b)
//   GET  /api/panel-source  — operator-authed manifest + daily trend for the panel refresh (docs/20)
//   GET  /api/signal-archives — operator-authed filtered archive manifest (docs/11 signals:download)
//   GET  /api/panel-object  — operator-authed single archived response, decompressed (docs/20)
//   GET  /api/os-asset      — operator-authed "which asset is the OS" (assets.is_os), for the runner
//   GET  /api/capacity      — operator-authed store capacity inventory, metadata only (pnpm os:doctor)
//   GET  /healthz           — liveness
// Private Service Binding RPC (the Tower holds the only binding):
//   ga4Realtime()           — bounded realtime read, no Google credential crosses
//   calendarUpcoming()      — the next 48h of meetings, no ICS secret crosses
//   watchQueryHistory()     — one query's bounded provider-final daily archive
//   createAnnotation()      — the operator's timeline write
//   createWatchWindow()     — the operator's pre-registered outcome check
//   readAssetState(asset)   — the editable asset columns, for an expect guard
//   writeAssetColumn(input) — set one of them (stage / automation / name)
//   createAsset(input)      — insert one assets row (the add-asset wizard)
//   backtestRule(input)     — replay one alert rule over the stored pulses (read-only)
//   getConfigDocument(file)  — one config document, store-first, file-fallback
//   getConfigDocuments(files)— several of them in one round trip
//   applyConfigOps(input)    — the deployed config write, with its audit row
//   listCredentialSummaries() — provider connection state: NAMES, never values
//   putCredential(input)    — store one provider credential, encrypted
//   connectCredential(input) — ask the provider first, store only if it accepts
//   putSiteToken(input)     — one site's token into a per-site map (ro-ujb9.96.7.9)
//   setCredentialExpiry(in) — record when one stops working (metadata, no key)
//   deleteCredential(id)    — forget one
//   probeCredential(id)     — one real, cheap, read-only call to the provider
//   beginGoogleOAuth(input) — the Google sign-in URL for one Tower origin
//   completeGoogleOAuth(in) — exchange the code, store the refresh token
//   discoverGoogleProperties() — GA4 properties + GSC sites this account sees
//   discoverSites(provider) — the sites a connected account lists (ro-ujb9.96.7.2)
//   collectNow(input)       — one job step run now for chosen sites (dispatch.ts)
//   runScheduled(cron)      — the local runner's cron fire (scripts/os-up.mjs)
// Crons:
//   0 * * * *    hourly ingest-freshness check (docs/06)
//   30 2 * * *   nightly asset pull + daily Bing Webmaster snapshot (docs/02, docs/11)
//   0 3 * * *    nightly asset-#0 self-pulse (docs/06)
//   30 3 * * *   daily watch-window evaluation (docs/03)
//   0 4 * * *    nightly tech/GEO hygiene guards (docs/08 §S5)
//   15 12 * * *  daily analysis-grade GA4/GSC/BWT archives to local/private R2 (docs/11)
//   45 12 * * 1  weekly DataForSEO rank/backlink/LLM snapshots to R2 (docs/11)
//   */15 * * * * counters + current GA4/GSC snapshots (docs/11)

import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  AssetStateRead,
  AssetStateWriteResult,
  CalendarUpcoming,
  CollectNowInput,
  CollectNowResult,
  ConnectCredentialResult,
  PutSiteTokenInput,
  PutSiteTokenResult,
  CreateAnnotationInput,
  CreateAnnotationResult,
  CreateAssetInput,
  CreateAssetResult,
  CreateWatchWindowInput,
  CreateWatchWindowResult,
  CredentialProbe,
  CredentialStoreState,
  DeleteCredentialResult,
  Ga4RealtimePayload,
  GoogleOAuthCompletion,
  GoogleOAuthStart,
  GooglePropertyDiscovery,
  RuleBacktestInput,
  RuleBacktestResult,
  PutCredentialInput,
  PutCredentialResult,
  SetCredentialExpiryInput,
  SetCredentialExpiryResult,
  WatchQueryHistory,
  WatchQueryHistoryInput,
  WriteAssetColumnInput,
  MoveAssetInput,
  MoveAssetResult,
} from '@noticeos/contract';
import { writeAnnotation } from './annotations.js';
import {
  type ApplyConfigOpsInput,
  type ApplyConfigOpsResult,
  type ConfigDocumentRead,
  applyConfigOps,
  getConfigDocument,
  getConfigDocuments,
} from './config-store.js';
import {
  disconnectCredential,
  discoverGoogleProperties,
  probeCredential,
} from './credential-probes.js';
import { connectCredential } from './credential-connect.js';
import { putSiteToken } from './site-tokens.js';
import { mediavineStatus, saveMediavineSettings, syncMediavine, putMediavineCredential } from './mediavine.js';
import type { MediavineSettings, MediavineSync } from '@noticeos/contract';
import {
  putCredential,
  setCredentialExpiry,
} from './credentials.js';
import {
  type BeginGoogleOAuthInput,
  type CompleteGoogleOAuthInput,
  beginGoogleOAuth,
  completeGoogleOAuth,
  beginStoredGoogleOAuth,
  exchangeStoredGoogleOAuth,
} from './google-oauth.js';
import {
  createAsset,
  readAssetState,
  writeAssetColumn,
  moveAsset,
} from './asset-state.js';
import { backtestRule } from './rule-backtest.js';
import { handleAnnotations } from './routes/annotations.js';
import { handleOpenReclamationTargets, handleReclamationTargets } from './routes/reclamation-targets.js';
import { handleAssetState, handleAssetStateEdit } from './routes/asset-state.js';
import { handleBeadsSnapshot } from './routes/beads-snapshot.js';
import { handleCapacity } from './routes/capacity.js';
import {
  CONFIG_DOCUMENTS_PREFIX,
  handleConfigDocuments,
} from './routes/config-documents.js';
import { handleBingAiExport } from './routes/bing-ai-export.js';
import { handleInsightSnapshot } from './routes/insight-snapshot.js';
import { handleJobRuns, handleManualJobRuns } from './routes/job-runs.js';
import {
  handlePanelObject,
  handlePanelSource,
  handleSignalArchives,
} from './routes/panel-source.js';
import { handlePulse } from './routes/pulse.js';
import { handleRotateCredentialKey } from './routes/rotate-key.js';
import { handleRevenue } from './routes/revenue.js';
import {
  handleResearchLogLookup,
  handleResearchLogRecord,
} from './routes/research-log.js';
import {
  findPriorResearch,
  type PriorResearch,
  type ResearchProvider,
} from './research-log.js';
import { handleProviderSpend } from './routes/provider-spend.js';
import { handleSerpPanelLandings } from './routes/serp-panel-landings.js';
import { handleOsAsset } from './routes/os-asset.js';
import { handleSignalCollect } from './routes/signal-collect.js';
import { handleWatchReadbacks } from './routes/watch-readbacks.js';
import { handleWatchWindows, writeWatchWindow } from './routes/watch-windows.js';
import { json } from './responses.js';
import { runGa4Realtime } from './ga4-realtime.js';
import { calendarUpcoming as readCalendarUpcoming } from './calendar.js';
import { readWatchQueryHistory } from './watch-windows.js';
// The cron dispatch table lives in dispatch.ts, and the cron constants in
// crons.ts, NOT here: workerd requires every named export of the entry module to
// be a handler, so a string export here fails the runtime at boot.
import { runCollectNow, runCron, runScheduledCron } from './dispatch.js';
import { withCallStore } from './call-store.js';
import { discoverSites } from './site-discovery.js';

/** Every HTTP route, run with the call's env (withCallStore). */
async function route(request: Request, env: IngestEnv): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === 'POST' && pathname === '/api/pulse') {
    return handlePulse(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/revenue') {
    return handleRevenue(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/annotations') {
    return handleAnnotations(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/reclamation-targets') {
    return handleReclamationTargets(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/reclamation-targets') {
    return handleOpenReclamationTargets(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/watch-windows') {
    return handleWatchWindows(request, env);
  }
  if (
    (request.method === 'GET' || request.method === 'POST') &&
    pathname === '/api/watch-readbacks'
  ) {
    return handleWatchReadbacks(request, env);
  }
  // Loopback-only in practice (the ingest has no listener of its own; see
  // routes/rotate-key.ts) AND operator-authed. Neither guard is the whole
  // answer on its own.
  if (request.method === 'POST' && pathname === '/api/credentials/rotate-key') {
    return handleRotateCredentialKey(request, env);
  }
  // The config store's own door — how `pnpm config:seed`, `pnpm config:export`
  // and the Tower's local write lane reach it without a second runtime opening
  // the sqlite file (db/0029, epic `ro-syok`). Operator-authed inside.
  if (pathname.startsWith(CONFIG_DOCUMENTS_PREFIX)) {
    return handleConfigDocuments(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/beads-snapshot') {
    return handleBeadsSnapshot(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/job-runs') {
    return handleJobRuns(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/job-runs') {
    return handleManualJobRuns(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/insight-snapshot') {
    return handleInsightSnapshot(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/asset-state') {
    return handleAssetStateEdit(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/asset-state') {
    return handleAssetState(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/signal-collect') {
    return handleSignalCollect(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/bing-ai-export') {
    return handleBingAiExport(request, env);
  }
  // POST for both verbs: the lookup's key is a whole provider request body,
  // which does not survive a query string honestly. Neither call mutates
  // anything the caller can observe except the log itself.
  if (request.method === 'POST' && pathname === '/api/research-log/lookup') {
    return handleResearchLogLookup(request, env);
  }
  if (request.method === 'POST' && pathname === '/api/research-log') {
    return handleResearchLogRecord(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/provider-spend') {
    return handleProviderSpend(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/serp-panel-landings') {
    return handleSerpPanelLandings(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/panel-source') {
    return handlePanelSource(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/signal-archives') {
    return handleSignalArchives(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/panel-object') {
    return handlePanelObject(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/os-asset') {
    return handleOsAsset(request, env);
  }
  if (request.method === 'GET' && pathname === '/api/capacity') {
    return handleCapacity(request, env);
  }
  if (request.method === 'GET' && pathname === '/healthz') {
    return json({ ok: true, service: 'ingest' });
  }
  return json({ error: 'not_found' }, 404);
}

export default class IngestWorker extends WorkerEntrypoint<IngestEnv> {
  // Every way in — a request, a scheduled run, each RPC call below — runs
  // with its own store, opened for the call and closed when it ends
  // (call-store.ts). A module function, never a method: every public method
  // here is callable over the binding, and none may hand out `env`.
  override async fetch(request: Request): Promise<Response> {
    return withCallStore(this.env, this.ctx, (env) => route(request, env));
  }

  // Instance field intentionally has no RPC visibility. Real scheduled events
  // can run platform housekeeping; a service binding cannot select this lane.
  override scheduled = async (controller: ScheduledController): Promise<void> => {
    if (controller.cron === GOOGLE_OAUTH_MAINTENANCE_CRON) {
      await runOAuthMaintenance(this.env);
      return;
    }
    await withCallStore(this.env, this.ctx, (env) => runCron(controller.cron, env));
  };

  /**
   * Private Service Binding RPC: fire one cron lane, the local runner's only way
   * in.
   *
   * Locally the ingest has no listener of its own — it runs as an auxiliary
   * Worker inside the Tower's single workerd runtime, which is what keeps ONE
   * D1DatabaseObject over the central store (ro-mad). So `os:up` can no longer
   * `GET /cdn-cgi/handler/scheduled` at a second process; it knocks on the
   * Tower's loopback-only ingest door, which calls this. Same dispatch table as
   * `scheduled()` above, so the local rehearsal still rehearses production.
   *
   * The Service Binding is the capability: nothing without the binding can call
   * this, and the only path to the binding is the loopback door
   * (apps/tower/vite/runner-door.ts).
   */
  async runScheduled(cron: string) {
    return withCallStore(this.env, this.ctx, (env) => runScheduledCron(cron, env));
  }

  /** Private Service Binding RPC: Tower gets values, never Google credentials. */
  async integrationHealth(proof?: Request) {
    if (workspaceProfile(this.env) !== 'standalone') {
      return withIntegrationSummaryEntry(this.env, 'integrationHealth', proof,
        call => call.withStore(this.ctx, store => readIntegrationHealth({ ...this.env, STORE: store })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => readIntegrationHealth(env));
  }

  async ga4Realtime(proof?: Request): Promise<Ga4RealtimePayload> {
    if (workspaceProfile(this.env) !== 'standalone') {
      return withLiveProviderReadEntry(this.env, 'ga4Realtime', proof,
        call => call.withStore(this.ctx, store => runGa4Realtime({ ...this.env, STORE: store })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, env => runGa4Realtime(env));
  }

  /**
   * Private Service Binding RPC: Tower gets meetings, never calendar credentials.
   *
   * A calendar's secret ICS link reads the whole calendar for anyone holding it,
   * so `CALENDAR_FEEDS` stays here and the Wall — LAN-served, unauthenticated —
   * receives only expanded instants. Ephemeral display state, like
   * `ga4Realtime()`: display payloads are ephemeral; safe health outcomes are retained.
   */
  async calendarUpcoming(proof?: Request): Promise<CalendarUpcoming> {
    if (workspaceProfile(this.env) !== 'standalone') {
      return withLiveProviderReadEntry(this.env, 'calendarUpcoming', proof,
        call => call.withStore(this.ctx, store => readCalendarUpcoming({ ...this.env, STORE: store })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, env => readCalendarUpcoming(env));
  }

  /** Private Service Binding RPC: bounded provider-final history for one query. */
  async watchQueryHistory(input: WatchQueryHistoryInput, originalProof?: Request): Promise<WatchQueryHistory> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(originalProof instanceof Request)) throw new WorkspaceEntryRefused();
      const proof = originalProof.clone(), candidate = structuredClone(input);
      const selected = await watchQueryHistoryArguments(candidate, proof);
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, async store => {
        const owned = await store.read(tx => tx.query('SELECT 1 AS owned FROM noticeos.assets WHERE asset_id = $1', [selected.asset]));
        if (owned.length !== 1) throw new WorkspaceEntryRefused();
        return readWatchQueryHistory({ ...this.env, STORE: store }, selected);
      }));
    }
    if (originalProof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => readWatchQueryHistory(env, input));
  }

  /**
   * Private Service Binding RPC: the Tower's timeline write, same writer and
   * same rules as `POST /api/annotations`. Hosted calls independently admit
   * the original browser request and record fresh maintained person facts;
   * no serialized actor or sender context grants receiver authority.
   */
  async createAnnotation(input: CreateAnnotationInput, originalProof?: Request): Promise<CreateAnnotationResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(originalProof instanceof Request)) throw new WorkspaceEntryRefused();
      const proof = originalProof.clone(), candidate = structuredClone(input);
      await assetMutationArguments(candidate, proof, 'createAnnotation');
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, store => {
        const context = call.context;
        if (context.principalKind !== 'person' || !context.sessionId) throw new WorkspaceEntryRefused();
        const actor = Object.freeze({ workspaceId: context.workspaceId, principalId: context.principalId, sessionId: context.sessionId });
        return writeAnnotation({ ...this.env, STORE: store }, candidate, undefined, actor);
      }));
    }
    if (originalProof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => writeAnnotation(env, input));
  }

  /**
   * Private Service Binding RPC: the Tower's pre-registration, same writer and
   * same rules as `POST /api/watch-windows` (bead `ro-71r`).
   *
   * Pre-registration is docs/03's first defense against choosing the verdict
   * after the numbers arrive, and it was the highest-friction action in the OS
   * — a hand-written curl with an operator bearer — so it got skipped. The
   * Tower can now open one from the property page. What it cannot do is soften
   * anything: this lands on the same validator the bearer lane does, so a
   * baseline overlapping the change or a final check shorter than the baseline
   * is refused whichever door it arrives through.
   */
  async createWatchWindow(input: CreateWatchWindowInput): Promise<CreateWatchWindowResult> {
    return withCallStore(this.env, this.ctx, (env) => writeWatchWindow(env, input));
  }

  /**
   * Private Service Binding RPC: what the store holds for one asset's two
   * editable columns — the Tower's `expect` guard before it writes one.
   *
   * An unknown asset answers `known: false`, not a throw: the Tower turns that
   * into its own 404 and the CLI renders it `(absent)`. Same function the
   * operator-authed `GET /api/asset-state` runs.
   */
  async readAssetState(asset: string, originalProof?: Request): Promise<AssetStateRead> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(originalProof instanceof Request)) throw new WorkspaceEntryRefused();
      const proof = originalProof.clone();
      await assetMutationArguments(asset, proof, 'readAssetState');
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, store => readAssetState({ ...this.env, STORE: store }, asset)));
    }
    if (originalProof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => readAssetState(env, asset));
  }

  /**
   * Private Service Binding RPC: set one sanctioned column on one asset row —
   * the lifecycle stage and the automation mode, written from the asset page
   * (D18, bead `ro-pbzu.5`).
   *
   * Same writer and the same rules as `POST /api/asset-state`, so the column
   * allowlist, the lifecycle enum and the 0/1 check hold whichever door the
   * write arrived at — and the Tower needs no operator bearer for any of it,
   * which is the point: it is served unauthenticated on the LAN, and a bearer
   * there would reach every operator-authed lane (docs/10 build note).
   */
  async writeAssetColumn(input: WriteAssetColumnInput, originalProof?: Request): Promise<AssetStateWriteResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(originalProof instanceof Request)) throw new WorkspaceEntryRefused();
      const proof = originalProof.clone(), candidate = structuredClone(input);
      await assetMutationArguments(candidate, proof, 'writeAssetColumn');
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, store => {
        const context = call.context;
        if (context.principalKind !== 'person' || !context.sessionId) throw new WorkspaceEntryRefused();
        const actor = Object.freeze({ workspaceId: context.workspaceId, principalId: context.principalId, sessionId: context.sessionId });
        return writeAssetColumn({ ...this.env, STORE: store }, candidate, undefined, actor);
      }));
    }
    if (originalProof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => writeAssetColumn(env, input));
  }

  /** Move within the admitted workspace; the receiver verifies the original request. */
  async moveAsset(input: MoveAssetInput, originalProof?: Request): Promise<MoveAssetResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(originalProof instanceof Request)) throw new WorkspaceEntryRefused();
      const proof = originalProof.clone(), candidate = structuredClone(input);
      await assetMutationArguments(candidate, proof, 'moveAsset');
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, store => {
        const context = call.context;
        if (context.principalKind !== 'person' || !context.sessionId) throw new WorkspaceEntryRefused();
        const actor = Object.freeze({ workspaceId: context.workspaceId, principalId: context.principalId, sessionId: context.sessionId });
        return moveAsset({ ...this.env, STORE: store }, candidate, undefined, actor);
      }));
    }
    if (originalProof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, env => moveAsset(env, input));
  }

  /**
   * Private Service Binding RPC: insert one `assets` row — the write under the
   * Tower's add-asset wizard (bead `ro-z349.1`).
   *
   * A ROW, never a migration: the schema stays operator-only (AGENTS.md). What
   * this creates is a join key plus the label and lifecycle stage that hang off
   * it, which is the same class of operator action as moving that stage — and it
   * is what replaces "an asset is born as a seed migration and five hand edits".
   *
   * A duplicate id comes back as `asset_exists` rather than throwing, because a
   * wizard renders that beside the id field and asks for another one.
   */
  async createAsset(input: CreateAssetInput, originalProof?: Request): Promise<CreateAssetResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(originalProof instanceof Request)) throw new WorkspaceEntryRefused();
      const proof = originalProof.clone(), candidate = structuredClone(input);
      await assetMutationArguments(candidate, proof, 'createAsset');
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, store => {
        const context = call.context;
        if (context.principalKind !== 'person' || !context.sessionId) throw new WorkspaceEntryRefused();
        const actor = Object.freeze({ workspaceId: context.workspaceId, principalId: context.principalId, sessionId: context.sessionId });
        return createAsset({ ...this.env, STORE: store }, candidate, undefined, actor);
      }));
    }
    if (originalProof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => createAsset(env, input));
  }

  /**
   * Private Service Binding RPC: "has this provider question already been
   * bought, and where is the answer" (ro-cda6.4, over ro-cda6.3's table).
   *
   * READ-ONLY, and deliberately not the recording half. The Tower's MCP surface
   * exposes this so an agent reasoning about a property can see that a keyword
   * read was bought nine days ago before asking for it again. Recording a
   * purchase stays behind the operator bearer on `POST /api/research-log`,
   * because that lane asserts money was spent and the Tower is served
   * unauthenticated on the LAN — a read of what was spent is not the same
   * capability as a claim about spending.
   */
  /**
   * Private Service Binding RPC: "how often would this alert rule have fired in
   * the last 30 days with these settings?" (bead `ro-u072`, docs/15 principle 1).
   *
   * READ-ONLY, and it belongs here rather than in the Tower for one reason: the
   * answer has to be `evaluatePulse` run against the SAME seasonal baselines the
   * nightly lane uses, and those are assembled from the `pulses` table this
   * Worker owns. A Tower-side preview would have to re-derive them, and a
   * preview computed from a different ruler than the live detector's is a fake
   * number in the one place the operator is being asked to trust one.
   *
   * A rule outside the replayable families comes back `unsupported_rule` rather
   * than as a throw or a zero — "no preview for this rule" is a sentence the
   * panel renders, and a zero would read as "this would never fire".
   */
  async backtestRule(input: RuleBacktestInput, proof?: Request): Promise<RuleBacktestResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const original = proof.clone();
      const selected = await storedResearchArguments(input, original, 'backtestRule');
      return withWorkspaceEntry(this.env, original, call => call.withStore(this.ctx,
        store => backtestRule({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => backtestRule(env, input));
  }

  /**
   * Private Service Binding RPC: one config document, store-first (db/0029,
   * epic `ro-syok`).
   *
   * The Tower asks for a SETTING at request time now instead of reading one
   * compiled into its bundle, which is what lets a deployed Tower show — and
   * save — a value at all. `source` says where the answer came from, so the
   * Settings page can tell the operator whether the store or the file is
   * speaking, and an install that has applied the migration but not seeded gets
   * exactly what it got yesterday.
   */
  async getConfigDocument(file: string): Promise<ConfigDocumentRead> {
    return withCallStore(this.env, this.ctx, (env) => getConfigDocument(env, file));
  }

  /**
   * Private Service Binding RPC: several documents in ONE round trip.
   *
   * A page load resolves a dozen of them. Asking one at a time would be a dozen
   * RPC hops plus a dozen D1 reads on the hot path of the display that has to
   * stay smooth, so the plural is the one the Tower actually calls and the
   * singular above is the readable door.
   */
  async getConfigDocuments(files: string[], proof?: Request): Promise<ConfigDocumentRead[]> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new Error('Workspace request proof is required.');
      const selected = configReadFiles(files);
      await ingestOperation('getConfigDocuments', proof);
      return withWorkspaceEntry(this.env, proof, (call) => call.withStore(this.ctx,
        (store) => getConfigDocuments({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => getConfigDocuments(env, files));
  }

  /**
   * Private Service Binding RPC: the deployed config write (db/0029).
   *
   * ROWS, never a migration, and the same class of operator action as the asset
   * column write above: the schema stays operator-only (AGENTS.md). Every op is
   * re-validated here against the shared register declarations, because an HTTP
   * body is untrusted wherever it entered — and the `expect` guard the Tower
   * rendered its fields under is checked against the stored document, so a stale
   * Save is refused with what is actually there rather than applied over
   * somebody else's.
   *
   * A refusal is an ANSWER, not a throw: the Tower turns each `error` into the
   * status and the sentence a field shows. `store-asset-set` ops are refused by
   * name — those two columns have their own route.
   */
  async applyConfigOps(input: ApplyConfigOpsInput, proof?: Request): Promise<ApplyConfigOpsResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new Error('Workspace request proof is required.');
      const selected = await configWriteArguments(input, proof);
      return withWorkspaceEntry(this.env, proof, (call) => call.withStore(this.ctx,
        (store) => applyConfigOps({ ...this.env, STORE: store }, { ...selected, actor: call.context.principalId })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => applyConfigOps(env, input));
  }

  /**
   * Private Service Binding RPC: every provider's connection state — field
   * NAMES, timestamps and the last verdict, and NEVER a value (bead
   * `ro-vu8d.1`).
   *
   * This return type IS the security boundary. The Tower is served
   * unauthenticated on the LAN, so it must never hold a credential; what it
   * asks for is the ANSWER — is this connected, when did it last work — and the
   * plaintext stays inside this Worker, where it is decrypted at call time and
   * nowhere else.
   */
  async listCredentialSummaries(proof?: Request): Promise<CredentialStoreState> {
    if (workspaceProfile(this.env) !== 'standalone') {
      return withIntegrationSummaryEntry(this.env, 'listCredentialSummaries', proof,
        call => call.withStore(this.ctx, store => readCredentialSummaries({ ...this.env, STORE: store })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    // The whole read lives in credential-summaries-read.ts (with the Google
    // property-map and notification-store facts it carries), so the journey
    // harness serves the Integrations cards from this same code (ro-ujb9.90).
    return withCallStore(this.env, this.ctx, (env) => readCredentialSummaries(env));
  }

  /**
   * Private Service Binding RPC: store one provider's credential, encrypted
   * under `CREDENTIALS_KEY`.
   *
   * A ROW, never a migration, and the same class of operator action as the
   * asset column write beside it: the schema stays operator-only (AGENTS.md).
   * Every field is re-validated here against the shared provider catalog,
   * because an HTTP body is untrusted wherever it entered, and the result
   * carries a SUMMARY rather than an echo — the operator hears what the store
   * holds, never what they typed.
   */
  async putCredential(input: PutCredentialInput, proof?: Request): Promise<PutCredentialResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await credentialWriteArguments(input, proof, 'putCredential');
      if (integrationProvider(selected.provider) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx, store => {
        const env = { ...this.env, STORE: store };
        return selected.provider === 'mediavine' ? putMediavineCredential(env, selected) : putCredential(env, selected);
      }));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    if (input.provider === 'mediavine') return withCallStore(this.env, this.ctx, (env) => putMediavineCredential(env, input));
    return withCallStore(this.env, this.ctx, (env) => putCredential(env, input));
  }

  /**
   * Private Service Binding RPC: the connect panel's one press (bead
   * `ro-ujb9.96.7.1`). The provider is asked FIRST, with its free read-only
   * call, and the credential is stored only if it accepts — so a refused key
   * is never kept and a stored one is never called connected ahead of proof.
   * Answers a verdict plus facts (site count, prepaid credit), never a value.
   */
  async connectCredential(input: PutCredentialInput, proof?: Request): Promise<ConnectCredentialResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await credentialWriteArguments(input, proof, 'connectCredential');
      if (integrationProvider(selected.provider) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => connectCredential({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => connectCredential(env, input));
  }

  /**
   * Private Service Binding RPC: one site's token for a provider that issues
   * one per site (Clarity, bead `ro-ujb9.96.7.9`), merged into its per-site
   * map here — the only place the map can be opened — so a paste on one row
   * never replaces another site's token. Answers the credential write's own
   * summary: field names, never a value.
   */
  async putSiteToken(input: PutSiteTokenInput, proof?: Request): Promise<PutSiteTokenResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await credentialWriteArguments(input, proof, 'putSiteToken');
      if (integrationProvider(selected.provider) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => putSiteToken({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => putSiteToken(env, input));
  }

  /**
   * Private Service Binding RPC: the sites a connected account lists, for the
   * connect panel's second screen (bead `ro-ujb9.96.7.2`). One free read,
   * nothing stored — a listing is not evidence — and only public identities
   * come back.
   */
  async discoverSites(provider: string, proof?: Request) {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await connectionReadinessArguments(provider, proof, 'discoverSites');
      if (integrationProvider(selected) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => discoverSites({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => discoverSites(env, provider));
  }

  /**
   * Private Service Binding RPC: the connect panel's Start collecting — one
   * scheduled job's step, run now for the confirmed sites, through the same
   * dispatch, stored config and lane gates as the cron (`runCollectNow`). It
   * answers when the lane's run has finished, so what it reports was stored.
   */
  async collectNow(input: CollectNowInput, proof?: Request): Promise<CollectNowResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const original = proof.clone();
      const selected = await providerCollectionArguments(input, original, 'collectNow');
      if (integrationProvider(selected.provider) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, original, call => call.withStore(this.ctx, async store => {
        await assertCollectionAssets(store, selected.assets);
        return runCollectNow({ ...this.env, STORE: store }, selected);
      }));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => runCollectNow(env, input));
  }

  async mediavineStatus(asset: string) { return withCallStore(this.env, this.ctx, (env) => mediavineStatus(env, asset)); }
  async saveMediavineSettings(input: MediavineSettings) { return withCallStore(this.env, this.ctx, (env) => saveMediavineSettings(env, input)); }
  async syncMediavine(input: MediavineSync, proof?: Request) {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const original = proof.clone();
      const selected = await providerCollectionArguments(input, original, 'syncMediavine');
      return withWorkspaceEntry(this.env, original, call => call.withStore(this.ctx, async store => {
        await assertCollectionAssets(store, [selected.asset]);
        return syncMediavine({ ...this.env, STORE: store }, selected);
      }));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => syncMediavine(env, input));
  }

  /**
   * Private Service Binding RPC: record when a stored credential stops working
   * (bead `ro-vu8d.8`).
   *
   * Its own RPC rather than a field on `putCredential`, because dating a
   * credential must not mean retyping it: the expiry is a NON-SECRET fact in
   * `fields_json`, so this write needs no bootstrap key, re-seals nothing, and
   * leaves the last verdict standing. A `null` date is the operator saying this
   * one does not expire, and it sticks through the next sign-in.
   */
  async setCredentialExpiry(
    input: SetCredentialExpiryInput,
    proof?: Request,
  ): Promise<SetCredentialExpiryResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await credentialWriteArguments(input, proof, 'setCredentialExpiry');
      if (integrationProvider(selected.provider) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => setCredentialExpiry({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => setCredentialExpiry(env, input));
  }

  /**
   * Private Service Binding RPC: forget one provider's credential.
   *
   * Works without `CREDENTIALS_KEY` on purpose — removing a secret you can no
   * longer read is exactly what a lost key calls for. For Google it also
   * REVOKES the grant at Google first, best effort, so a disconnect leaves
   * nothing live on the operator's own Google account (`ro-vu8d.3`).
   */
  async deleteCredential(provider: string, proof?: Request): Promise<DeleteCredentialResult> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await credentialWriteArguments(provider, proof, 'deleteCredential');
      if (integrationProvider(selected) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => disconnectCredential({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => disconnectCredential(env, provider));
  }

  /**
   * Private Service Binding RPC: where to send the browser to sign in to
   * Google, for a Tower open at `origin` (bead `ro-vu8d.3`).
   *
   * The URL is built HERE because building it needs the client id, and the
   * Tower must never hold one. What crosses the binding is an origin in and a
   * URL out — no secret in either direction, and the state nonce inside that
   * URL is signed with a key derived from `CREDENTIALS_KEY`.
   */
  async beginGoogleOAuth(input: BeginGoogleOAuthInput, proof?: Request): Promise<GoogleOAuthStart> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      await googleOAuthArguments(input, proof, workspaceEntryOrigin(this.env), 'start');
      return withGoogleWorkspaceEntry(this.env, proof, 'start', (call, state) => call.withStore(this.ctx,
        (store) => beginStoredGoogleOAuth({ ...this.env, STORE: store }, workspaceEntryOrigin(this.env), state!)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => beginGoogleOAuth(env, input));
  }

  /**
   * Private Service Binding RPC: turn the authorization code Google put on the
   * callback into a stored refresh token.
   *
   * The code is used ONCE, never persisted and never logged; what comes back is
   * the account address and the granted scopes, which are identities rather
   * than secrets. A grant missing either read scope is refused rather than
   * stored — see `completeGoogleOAuth`.
   */
  async completeGoogleOAuth(
    input: CompleteGoogleOAuthInput & { error?: string | null }, proof?: Request,
  ): Promise<GoogleOAuthCompletion> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = googleOAuthArguments(input, proof, workspaceEntryOrigin(this.env), 'callback');
      if (!('code' in selected)) throw new WorkspaceEntryRefused();
      return withGoogleWorkspaceEntry(this.env, proof, 'callback', (call) => {
        if (selected.error !== null) return Promise.resolve({ ok: false, error: 'denied' } as const);
        return call.withStore(this.ctx, (store) => exchangeStoredGoogleOAuth({ ...this.env, STORE: store },
          { code: selected.code, redirectUri: selected.redirectUri }));
      });
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => completeGoogleOAuth(env, input));
  }

  /**
   * Private Service Binding RPC: the GA4 properties and Search Console sites
   * the connected Google credential can see.
   *
   * Two free, read-only list calls and nothing stored — a discovery is not
   * evidence. The Integrations card renders it so an operator can tell at once
   * whether they signed in with the right account; the per-asset picker
   * (`ro-vu8d.4`) consumes the same payload.
   */
  async discoverGoogleProperties(proof?: Request): Promise<GooglePropertyDiscovery> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      await ingestOperation('discoverGoogleProperties', proof);
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => discoverGoogleProperties({ ...this.env, STORE: store })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => discoverGoogleProperties(env));
  }

  /**
   * Private Service Binding RPC: one real, least-privileged, read-only call to
   * the provider, answering `{ ok, message, checkedAt }`.
   *
   * `ok: false` is an ANSWER, not a throw: "the key is wrong" is what the
   * button asked. Nothing about the provider's response is persisted — a
   * connection test is not evidence — and no message carries a credential.
   */
  async probeCredential(provider: string, proof?: Request): Promise<CredentialProbe> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const selected = await connectionReadinessArguments(provider, proof, 'probeCredential');
      if (integrationProvider(selected) === null) throw new WorkspaceEntryRefused();
      return withWorkspaceEntry(this.env, proof, call => call.withStore(this.ctx,
        store => probeCredential({ ...this.env, STORE: store }, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => probeCredential(env, provider));
  }

  async researchLookup(query: {
    provider: ResearchProvider;
    endpoint: string;
    params: unknown;
    windowDays?: number;
  }, proof?: Request): Promise<PriorResearch | null> {
    if (workspaceProfile(this.env) !== 'standalone') {
      if (!(proof instanceof Request)) throw new WorkspaceEntryRefused();
      const original = proof.clone();
      const selected = await storedResearchArguments(query, original, 'researchLookup');
      return withWorkspaceEntry(this.env, original, call => call.withStore(this.ctx,
        store => findPriorResearch(store, selected)));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    return withCallStore(this.env, this.ctx, (env) => findPriorResearch(env.STORE, query));
  }
}
