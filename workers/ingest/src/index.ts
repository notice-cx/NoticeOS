import { CLOUDFLARE_D1_BACKUP_PATH, CLOUDFLARE_D1_PATH } from '@noticeos/contract/cloudflare-d1';
import { authenticateOperator } from './auth.js';
import { GOOGLE_OAUTH_MAINTENANCE_CRON, runOAuthMaintenance } from './oauth-maintenance.js';
import { readIntegrationHealth } from './integration-health-read.js';
import { readCredentialSummaries } from './credential-summaries-read.js';
import { configReadFiles, assetMutationArguments, storedResearchArguments, watchQueryHistoryArguments, configWriteArguments, connectionReadinessArguments, credentialWriteArguments, providerCollectionArguments, googleOAuthArguments, withGoogleWorkspaceEntry, withIntegrationSummaryEntry, withLiveProviderReadEntry, workspaceEntryOrigin, withWorkspaceEntry, workspaceProfile, WorkspaceEntryRefused } from '../../../scripts/workspace-entry.mjs';
import type { WorkspaceStore } from '@noticeos/postgres';
import { integrationProvider } from '@noticeos/contract';
import { ingestOperation } from '../../../scripts/workspace-operations.mjs';
import { cloudflareD1Request } from '../../../scripts/workspace-operations.mjs';
import { handleD1Request } from './cloudflare-d1.js';

/** The selected store must own every requested portfolio target before
 * opening credentials or asking a provider. */
async function assertCollectionAssets(store: WorkspaceStore, assets: readonly string[]): Promise<void> {
  const selected = [...new Set(assets)];
  if (selected.length === 0) return;
  const rows = await store.read(tx => tx.query<{ asset: string }>(
    `SELECT asset_id AS asset FROM noticeos.assets
       WHERE asset_id = ANY($1::text[]) AND NOT is_os AND status <> 'retired'`, [selected]));
  if (rows.length !== selected.length) throw new WorkspaceEntryRefused();
}
// @noticeos/ingest: the pulse ingest + ledger Worker and its self-observing
// crons. HTTP routes are dispatched in `route` below; the private Service
// Binding RPCs (the Tower holds the only binding) are the methods of
// `IngestWorker`; the cron table lives in dispatch.ts and crons.ts.

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
// The cron dispatch table and cron constants are not here: workerd requires
// every named export of the entry module to be a handler.
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
  // Loopback-only in practice (routes/rotate-key.ts) and operator-authed;
  // neither guard is the whole answer on its own.
  if (request.method === 'POST' && pathname === '/api/credentials/rotate-key') {
    return handleRotateCredentialKey(request, env);
  }
  // The config store's own door for `pnpm config:seed`, `pnpm config:export`
  // and the Tower's local write lane. Operator-authed inside.
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
  // which does not survive a query string honestly.
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
  // Every way in runs with its own store, opened for the call and closed when
  // it ends (call-store.ts). A module function, never a method: every public
  // method here is callable over the binding, and none may hand out `env`.
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
   * Fire one cron lane: the local runner's only way in, since the ingest has
   * no listener of its own. Same dispatch table as `scheduled()`. The Service
   * Binding is the capability, and the only path to it is the loopback door
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
   * The Tower gets meetings, never calendar credentials: a secret ICS link
   * reads the whole calendar for anyone holding it. Ephemeral display state.
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
   * The Tower's timeline write, same writer and rules as `POST /api/annotations`.
   * Hosted calls independently admit the original browser request; no
   * serialized actor or sender context grants receiver authority.
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
   * The Tower's pre-registration, same writer and rules as
   * `POST /api/watch-windows`: a baseline overlapping the change or a final
   * check shorter than the baseline is refused whichever door it arrives through.
   */
  async createWatchWindow(input: CreateWatchWindowInput): Promise<CreateWatchWindowResult> {
    return withCallStore(this.env, this.ctx, (env) => writeWatchWindow(env, input));
  }

  /**
   * What the store holds for one asset's editable columns: the Tower's
   * `expect` guard before it writes one. An unknown asset answers
   * `known: false`, not a throw.
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
   * Set one sanctioned column on one asset row, with the same rules as
   * `POST /api/asset-state`, so the Tower needs no operator bearer: it is
   * served unauthenticated on the LAN, and a bearer there would reach every
   * operator-authed lane.
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
   * Insert one `assets` row, the write under the add-asset wizard. A row,
   * never a migration. A duplicate id comes back as `asset_exists` rather than
   * throwing, because the wizard renders that beside the id field.
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
   * How often would this alert rule have fired in the last 30 days with these
   * settings? Read-only, and here rather than in the Tower because the answer
   * has to be `evaluatePulse` against the same seasonal baselines the nightly
   * lane uses. A rule outside the replayable families comes back
   * `unsupported_rule` rather than a throw or a zero.
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
   * One config document, store-first. `source` says where the answer came
   * from, so the Settings page can tell whether the store or the file is
   * speaking.
   */
  async getConfigDocument(file: string): Promise<ConfigDocumentRead> {
    return withCallStore(this.env, this.ctx, (env) => getConfigDocument(env, file));
  }

  /** Several documents in one round trip: a page load resolves a dozen. */
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
   * The deployed config write: rows, never a migration. Every op is
   * re-validated against the shared register declarations, and the `expect`
   * guard is checked against the stored document so a stale Save is refused.
   * A refusal is an answer, not a throw. `store-asset-set` ops are refused by
   * name; those columns have their own route.
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
   * Every provider's connection state: field names, timestamps and the last
   * verdict, never a value. This return type is the security boundary: the
   * Tower is served unauthenticated on the LAN and must never hold a credential.
   */
  async listCredentialSummaries(proof?: Request): Promise<CredentialStoreState> {
    if (workspaceProfile(this.env) !== 'standalone') {
      return withIntegrationSummaryEntry(this.env, 'listCredentialSummaries', proof,
        call => call.withStore(this.ctx, store => readCredentialSummaries({ ...this.env, STORE: store })));
    }
    if (proof !== undefined) throw new WorkspaceEntryRefused();
    // The whole read lives in credential-summaries-read.ts so the journey
    // harness serves the Integrations cards from this same code.
    return withCallStore(this.env, this.ctx, (env) => readCredentialSummaries(env));
  }

  /**
   * Store one provider's credential, encrypted under `CREDENTIALS_KEY`. Every
   * field is re-validated against the shared provider catalog, and the result
   * carries a summary rather than an echo.
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
   * The connect panel's one press: the provider is asked first, with its free
   * read-only call, and the credential is stored only if it accepts. Answers a
   * verdict plus facts, never a value.
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

  /** Fixed Request-only receiver; hosted authority is resolved again here. */
  async cloudflareD1(original: Request): Promise<Response> {
    const selected = await cloudflareD1Request(original);
    await ingestOperation('cloudflareD1', original);
    if (workspaceProfile(this.env) !== 'standalone') {
      return withWorkspaceEntry(this.env, original, call => call.withStore(this.ctx,
        store => handleD1Request({ ...this.env, STORE: store }, selected, original.signal)));
    }
    return withCallStore(this.env, this.ctx, env => handleD1Request(env, selected, original.signal));
  }

  /** Fixed standalone backup transport. The bootstrap bearer authorizes only
   * these saved-target operations; it never selects a workspace or provider URL. */
  async backupCloudflareD1(original: Request): Promise<Response> {
    if (workspaceProfile(this.env) !== 'standalone' || original.headers.has('origin')) return Response.json({ error: 'forbidden' }, { status: 403 });
    if (!this.env.OPERATOR_TOKEN || !await authenticateOperator(original, this.env.OPERATOR_TOKEN)) return Response.json({ error: 'forbidden' }, { status: 403 });
    try {
      const url = new URL(original.url);
      if (url.pathname !== CLOUDFLARE_D1_BACKUP_PATH) throw new Error('Invalid backup route');
      url.pathname = CLOUDFLARE_D1_PATH;
      const selected = await cloudflareD1Request(new Request(url.href, original.clone()));
      if (selected.kind === 'select' || selected.kind === 'databases') throw new Error('Invalid backup operation');
      return withCallStore(this.env, this.ctx, env => handleD1Request(env, selected, original.signal));
    } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
  }

  /**
   * One site's token for a provider that issues one per site, merged into its
   * per-site map here, the only place the map can be opened, so a paste on one
   * row never replaces another site's token. Answers field names, never a value.
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
   * The sites a connected account lists. One free read, nothing stored, and
   * only public identities come back.
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
   * The connect panel's Start collecting: one scheduled job's step, run now for
   * the confirmed sites, through the same dispatch, config and lane gates as the
   * cron. It answers when the run has finished, so what it reports was stored.
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
   * Record when a stored credential stops working. Its own RPC rather than a
   * field on `putCredential`: the expiry is a non-secret fact, so this needs no
   * bootstrap key, re-seals nothing and leaves the last verdict standing. A
   * `null` date is the operator saying this one does not expire.
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
   * Forget one provider's credential. Works without `CREDENTIALS_KEY`. For
   * Google it also revokes the grant at Google first, best effort.
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
   * Where to send the browser to sign in to Google. Built here because it
   * needs the client id, which the Tower must never hold; the state nonce is
   * signed with a key derived from `CREDENTIALS_KEY`.
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
   * Turn the authorization code on the callback into a stored refresh token.
   * The code is used once, never persisted and never logged; a grant missing
   * either read scope is refused rather than stored.
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
   * The GA4 properties and Search Console sites the connected credential can
   * see. Two free, read-only list calls and nothing stored.
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
   * One real, least-privileged, read-only call to the provider. `ok: false` is
   * an answer, not a throw; nothing is persisted and no message carries a
   * credential.
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
