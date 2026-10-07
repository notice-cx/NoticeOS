/** Server composition for the first hosted settings entry. No ambient address,
 * request-selected profile, sole-workspace fallback or serialized authority.
 * Additional routes need their own reviewed entry integration. */
import { openIdentity, type Identity, type IdentityOptions } from '../packages/postgres/src/identity.mjs';
import { openIntegrationOAuthCustody, type IntegrationOAuthCustody } from '../packages/postgres/src/integration-oauth-custody.mjs';
import { withHostedWorkspaceStore, type CallContext, type WorkspaceStore } from '../packages/postgres/src/store.mjs';
import { PRODUCT_ENV, workspaceProfile, type WorkspaceProfile } from './product-env.mjs';
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { createWorkspaceAdmission, type WorkspaceAdmission, type WorkspaceContext } from './workspace-admission.mjs';
import { AGENT_RESOURCE_PATH, bearerToken } from './agent-access.mjs';
import { towerOperation, isHostedStoredRead, isHostedGoogleDiscovery, liveProviderReadRequest, connectionReadinessRequest,
  credentialWriteRequest, credentialWriteInput, type CredentialWriteMethod,
  providerCollectionRequest, providerCollectionInput, type ProviderCollectionMethod, storedResearchReadRequest,
  assetMutationRequest, assetMutationInput, type AssetMutationMethod,
  watchQueryHistoryRequest, watchQueryHistoryRange } from './workspace-operations.mjs';
import { ingestOperation } from './workspace-operations.mjs';
import { isCloudflareD1Request } from './workspace-operations.mjs';
import { googleOAuthRequest, GOOGLE_INTEGRATION_START } from './workspace-operations.mjs';
import type { RuleBacktestInput } from '../packages/contract/src/rule-backtest.js';
import type { WatchQueryHistoryInput } from '../packages/contract/src/create-watch-window.js';
import { deepEqual } from './config-documents.mjs';
import { TOWER_CONFIG_FILES, type ApplyConfigOpsInput, type ChangesetOp } from '../packages/contract/src/configuration.mjs';

export { WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
export { workspaceProfile, type WorkspaceProfile };
export type WorkspaceEntryBindings = Partial<Record<
  typeof PRODUCT_ENV.workspaceProfile.name | typeof PRODUCT_ENV.workspaceOrigin.name |
  typeof PRODUCT_ENV.workspaceDatabase.name | typeof PRODUCT_ENV.identityDatabase.name |
  typeof PRODUCT_ENV.identitySecret.name | typeof PRODUCT_ENV.demoWorkspace.name, string>>;
export class WorkspaceEntryRefused extends Error {
  override name = 'WorkspaceEntryRefused';
  constructor() { super('Workspace entry is unavailable or unauthorized.'); }
}
function refuse(): never { throw new WorkspaceEntryRefused(); }
function binding(env: object, key: keyof typeof PRODUCT_ENV): string {
  const value = (env as Record<string, unknown>)[PRODUCT_ENV[key].name];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) refuse();
  return value;
}
export function workspaceEntryOrigin(env: object): string {
  return createBrowserRequestPolicy(binding(env, 'workspaceOrigin')).origin;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) refuse();
  return value;
}
function database(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { refuse(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
    || !url.username || url.pathname.length < 2 || url.hash) refuse();
  return value;
}
/** All legacy RPC/HTTP/cron entries call this before opening their old store. */
export function requireStandaloneWorkspace(env: object): void {
  if (workspaceProfile(env) !== 'standalone') refuse();
}
/** The private reader accepts exactly the server's declared Tower inventory,
 * including its order, not a tenant-controlled file/path selection. */
export function configReadFiles(input: unknown): string[] {
  const files = Object.values(TOWER_CONFIG_FILES);
  if (!Array.isArray(input) || !deepEqual(files, input)) refuse();
  return [...files];
}
/** The catalog has bounded/validated this exact original body before parsing.
 * Compare every duplicate admitted field semantically; actor is discarded and
 * replaced only after fresh receiver admission. Extra RPC keys are refused. */
export async function configWriteArguments(input: unknown, request: Request): Promise<Omit<ApplyConfigOpsInput, 'actor'>> {
  await ingestOperation('applyConfigOps', request);
  let body: Record<string, unknown>;
  try { body = await request.clone().json() as Record<string, unknown>; } catch { refuse(); }
  if (body.slug !== undefined && typeof body.slug !== 'string') refuse();
  const expected = {
    ops: body.ops as ChangesetOp[],
    ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
    reason: typeof body.reason === 'string' ? body.reason : null,
    expectVersions: body.expectVersions !== null && typeof body.expectVersions === 'object' && !Array.isArray(body.expectVersions)
      ? body.expectVersions as Record<string, number | null> : null,
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  const forwarded = input as Record<string, unknown>;
  if (Object.keys(forwarded).some(key => !['ops', 'slug', 'reason', 'expectVersions', 'actor'].includes(key))) refuse();
  const { actor: _claimedActor, ...duplicate } = forwarded;
  if (!deepEqual(expected, duplicate)) refuse();
  return expected;
}
export interface WorkspaceEntryCall {
  readonly context: WorkspaceContext;
  /** Available only during this same admitted operation, fixed to its workspace. */
  withStore<T>(ctx: CallContext, work: (store: WorkspaceStore) => Promise<T>): Promise<T>;
}
/** Explicit server adapters allow local fixtures; no request may supply them. */
export interface WorkspaceEntryDependencies {
  openIdentity(options: IdentityOptions): Promise<Identity>;
  withStore: typeof withHostedWorkspaceStore;
}
const dependencies: WorkspaceEntryDependencies = { openIdentity, withStore: withHostedWorkspaceStore };

/** Two fixed no-payload receiver reads. Method/path correspondence is checked
 * before fresh receiver admission; the sender's earlier context is not authority. */
export async function withIntegrationSummaryEntry<T>(env: object,
  method: 'integrationHealth' | 'listCredentialSummaries', request: Request | undefined,
  work: (call: WorkspaceEntryCall) => Promise<T>): Promise<T> {
  if (!['integrationHealth', 'listCredentialSummaries'].includes(method)
    || !(request instanceof Request)) refuse();
  const proof = request.clone();
  await ingestOperation(method, proof);
  return withWorkspaceEntry(env, proof, work);
}

/** Two no-payload live-panel receiver reads: selection belongs to the fixed
 * store, and fresh admission follows method/original-path correspondence. */
export async function withLiveProviderReadEntry<T>(env: object,
  method: 'ga4Realtime' | 'calendarUpcoming', request: Request | undefined,
  work: (call: WorkspaceEntryCall) => Promise<T>): Promise<T> {
  if (!['ga4Realtime', 'calendarUpcoming'].includes(method) || !(request instanceof Request)) refuse();
  const proof = request.clone();
  if (liveProviderReadRequest(proof)?.method !== method) refuse();
  await ingestOperation(method, proof);
  return withWorkspaceEntry(env, proof, work);
}

/** A duplicated provider argument must correspond to this exact original
 * request. This is grammar only; fresh receiver admission still follows. */
export async function connectionReadinessArguments(provider: unknown, request: Request,
  method: 'discoverSites' | 'probeCredential'): Promise<string> {
  if (!(request instanceof Request)) refuse();
  const parsed = connectionReadinessRequest(request);
  if (!parsed || parsed.method !== method || parsed.provider !== provider) refuse();
  await ingestOperation(method, request);
  return parsed.provider;
}

export function credentialWriteArguments(input: unknown, request: Request, method: 'putCredential' | 'connectCredential'): Promise<{ provider: string; fields: Record<string, string> }>;
export function credentialWriteArguments(input: unknown, request: Request, method: 'deleteCredential'): Promise<string>;
export function credentialWriteArguments(input: unknown, request: Request, method: 'setCredentialExpiry'): Promise<{ provider: string; expiresAt: string | null }>;
export function credentialWriteArguments(input: unknown, request: Request, method: 'putSiteToken'): Promise<{ provider: string; asset: string; token: string }>;
/** Exact duplicate input, not a caller's authority. The canonical snapshot
 * excludes OAuth-only metadata and is followed by fresh receiver admission. */
export async function credentialWriteArguments(input: unknown, request: Request, method: CredentialWriteMethod) {
  if (!(request instanceof Request)) refuse();
  const parsed = await credentialWriteInput(request);
  if (parsed.method !== method || !deepEqual(input, parsed.input)) refuse();
  await ingestOperation(method, request);
  return parsed.input;
}

export function providerCollectionArguments(input: unknown, request: Request, method: 'collectNow'): Promise<{ provider: string; assets: string[] }>;
export function providerCollectionArguments(input: unknown, request: Request, method: 'syncMediavine'): Promise<{ asset: string; start?: string; end?: string }>;
/** Method and every selector must match the original message. Fresh receiver
 * admission and actual asset ownership still precede collector effects. */
export async function providerCollectionArguments(input: unknown, request: Request, method: ProviderCollectionMethod) {
  if (!(request instanceof Request)) refuse();
  const parsed = await providerCollectionInput(request);
  if (parsed.method !== method || !deepEqual(input, parsed.input)) refuse();
  await ingestOperation(method, request);
  return parsed.method === 'collectNow'
    ? { provider: parsed.input.provider, assets: [...parsed.input.assets] }
    : { ...parsed.input };
}

/** Fixed mutation RPC correspondence. Snapshot the candidate before any await;
 * callers use that same owned snapshot in the writer after fresh admission.
 * Actor/workspace/action fields never come from the public envelope. */
export async function assetMutationArguments(input: unknown, request: Request, method: AssetMutationMethod): Promise<void> {
  if (!(request instanceof Request)) refuse();
  const duplicate = structuredClone(input);
  const { route, body } = await assetMutationInput(request);
  let expected: unknown;
  if (method === 'createAsset' && route.kind === 'create') expected = body;
  else if (method === 'readAssetState' && route.kind === 'column') expected = route.asset;
  else if (method === 'writeAssetColumn' && route.kind === 'column')
    expected = { asset: route.asset, column: body.column, value: body.value, expect: body.expect };
  else if (method === 'moveAsset' && route.kind === 'order')
    expected = { asset: route.asset, to: body.to, ...(body.expectRevision === undefined ? {} : { expectRevision: body.expectRevision }) };
  else if (method === 'createAnnotation' && route.kind === 'annotation') {
    const blank = (value: unknown) => typeof value === 'string' && value.trim().length === 0 ? null : value;
    expected = { asset: route.asset, kind: body.kind, at: body.at, ref: blank(body.ref), note: blank(body.note) };
  } else refuse();
  if (method === 'createAnnotation') {
    if (!duplicate || typeof duplicate !== 'object' || Array.isArray(duplicate)
      || Object.keys(duplicate).some(key => !['asset', 'kind', 'at', 'ref', 'note'].includes(key))) refuse();
    // Ordinary optional fields may be absent or undefined after JSON fixture
    // transport. Every supplied value and unexpected key still counts.
    const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
    if (!deepEqual(defined(expected as object), defined(duplicate))) refuse();
  } else if (!deepEqual(expected, duplicate)) refuse();
  await ingestOperation(method, request);
}

/** Exact stored question correspondence. These reads cannot select a provider
 * call, another RPC, a workspace, an actor or a saved rule change. */
export function storedResearchArguments(input: unknown, request: Request, method: 'backtestRule'): Promise<RuleBacktestInput>;
export function storedResearchArguments(input: unknown, request: Request, method: 'researchLookup'): Promise<{ provider: 'dataforseo'; endpoint: string; params: unknown; windowDays?: number }>;
export async function storedResearchArguments(input: unknown, request: Request,
  method: 'researchLookup' | 'backtestRule') {
  if (!(request instanceof Request)) refuse();
  const parsed = await storedResearchReadRequest(request);
  let expected: RuleBacktestInput | { provider: 'dataforseo'; endpoint: string; params: unknown; windowDays?: number };
  if (method === 'backtestRule' && parsed?.method === 'backtestRule') expected = parsed.input;
  else if (method === 'researchLookup' && parsed?.method === 'mcp' && parsed.tool === 'research_lookup') {
    const args = (parsed.body.params as { arguments: Record<string, unknown> }).arguments;
    expected = { provider: 'dataforseo', endpoint: args.endpoint as string, params: args.params,
      ...(typeof args.windowDays === 'number' ? { windowDays: args.windowDays } : {}) };
  } else refuse();
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  // The ordinary MCP handler includes its optional windowDays as undefined.
  // Undefined is absence, but every supplied value and unexpected key counts.
  if (Object.keys(input).some(key => !(method === 'backtestRule'
    ? ['asset', 'ruleId', 'config', 'metric', 'through'] : ['provider', 'endpoint', 'params', 'windowDays']).includes(key))) refuse();
  const duplicate = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  if (!deepEqual(expected, duplicate)) refuse();
  await ingestOperation(method, request);
  return expected;
}

/** Original request selectors plus the server's fixed current range. The
 * duplicate RPC input cannot select another asset, query, metric or archive. */
export async function watchQueryHistoryArguments(input: unknown, request: Request,
  nowMs: number = Date.now()): Promise<WatchQueryHistoryInput> {
  const parsed = watchQueryHistoryRequest(request);
  if (!parsed) refuse();
  const expected = { ...parsed, ...watchQueryHistoryRange(nowMs) };
  if (!deepEqual(input, expected)) refuse();
  await ingestOperation('watchQueryHistory', request);
  return expected;
}

/** Await the complete operation. Both sides of a private RPC use this with
 * the original Request; a prior caller's context is not accepted here. */
export async function withWorkspaceEntry<T>(env: object, request: Request,
  work: (call: WorkspaceEntryCall) => Promise<T>, adapters = dependencies): Promise<T> {
  const kind = workspaceProfile(env);
  if (kind === 'standalone' || !(request instanceof Request) || typeof work !== 'function') refuse();
  let proof: Request;
  try { proof = request.clone(); } catch { refuse(); }
  const selected = await towerOperation(proof);
  const pathname = new URL(proof.url).pathname;
  const settings = pathname === '/api/config' && ['GET', 'PUT'].includes(proof.method);
  const googleStart = pathname === GOOGLE_INTEGRATION_START && proof.method === 'POST';
  const storedResearch = ['/api/mcp', '/api/alerts/backtest'].includes(pathname) && proof.method === 'POST';
  if ((!settings && !googleStart && !storedResearch && !isHostedStoredRead(proof) && !isHostedGoogleDiscovery(proof)
      && !connectionReadinessRequest(proof) && !credentialWriteRequest(proof)
      && !providerCollectionRequest(proof) && !liveProviderReadRequest(proof) && !assetMutationRequest(proof)
      && !watchQueryHistoryRequest(proof) && !isCloudflareD1Request(proof))
    || selected.kind !== 'workspace' || selected.action === null) refuse();
  const origin = binding(env, 'workspaceOrigin');
  const browser = createBrowserRequestPolicy(origin);
  if (new URL(proof.url).origin !== browser.origin) refuse();
  // An agent's bearer token (agent-access.mts) reaches only the MCP endpoint
  // and carries no ambient browser credential; the call still names its workspace.
  const bearer = bearerToken(proof.headers);
  const agent = bearer !== null;
  if (agent && (bearer === false || kind !== 'hosted' || pathname !== AGENT_RESOURCE_PATH)) refuse();
  if (!agent && (proof.method === 'PUT' || googleStart || storedResearch || assetMutationRequest(proof)
    || (isCloudflareD1Request(proof) && proof.method === 'POST'))) browser.assertEffect(proof);
  if (googleStart) await googleOAuthRequest(proof, origin, 'start');
  const requested = proof.headers.get(WORKSPACE_SELECTION_HEADER);
  const workspaceId = kind === 'demo' ? uuid(binding(env, 'demoWorkspace')) : uuid(requested);
  if (requested !== null && uuid(requested) !== workspaceId) refuse();
  const transport = Object.freeze({ kind: 'direct' as const, connectionString: database(binding(env, 'workspaceDatabase')) });
  const options: IdentityOptions = {
    connectionString: database(binding(env, 'identityDatabase')),
    trustedOrigin: origin,
    sessionSecret: binding(env, 'identitySecret'),
  };
  if (options.sessionSecret.length < 32) refuse();
  // Open lazily inside the shared policy's fresh fact lookup. Demo mutations,
  // malformed selection and browser evidence are refused without any I/O.
  let identity: Promise<Identity> | undefined;
  const reader = () => identity ??= adapters.openIdentity(options);
  const admission: WorkspaceAdmission = createWorkspaceAdmission(kind === 'hosted' ? {
    kind, profile: Symbol('hosted-workspace'), trustedOrigin: origin,
    membership: async (headers, workspace) => (await reader()).admissionMembership(headers, workspace),
    agent: async (request, workspace) => new URL(request.url).pathname === AGENT_RESOURCE_PATH
      ? (await reader()).agentAuthority(request, workspace) : null,
  } : {
    kind, profile: Symbol('demo-workspace'), workspaceId,
    workspaceStatus: async (workspace) => (await (await reader()).workspaceSummary(workspace))?.status ?? null,
  });
  const action = selected.action;
  try {
    return await admission.withAdmission(action, {
      requestedWorkspaceId: workspaceId, correlationId: crypto.randomUUID(),
    }, proof, async (context) => work(Object.freeze({
      context,
      withStore<U>(ctx: CallContext, use: (store: WorkspaceStore) => Promise<U>): Promise<U> {
        admission.assertContext(context, action);
        return adapters.withStore({ transport, workspace: { workspaceId: context.workspaceId } }, ctx, use);
      },
    })));
  } catch { return refuse(); }
  finally {
    if (identity) {
      let opened: Identity | undefined;
      try { opened = await identity; } catch { /* openIdentity already closes a refused pool. */ }
      if (opened) { try { await opened.close(); } catch { refuse(); } }
    }
  }
}

/** Fixed receiver entry. Durable protocol custody is consumed only here, never
 * in Tower and never from a supplied context, actor, action or verified flag. */
export async function withGoogleWorkspaceEntry<T>(env: object, request: Request,
  phase: 'start' | 'callback',
  work: (call: WorkspaceEntryCall, state?: string) => Promise<T>,
  adapters: { openCustody: typeof openIntegrationOAuthCustody; withStore: typeof withHostedWorkspaceStore } = {
    openCustody: openIntegrationOAuthCustody, withStore: withHostedWorkspaceStore,
  }): Promise<T> {
  if (workspaceProfile(env) !== 'hosted' || !(request instanceof Request)
    || !['start', 'callback'].includes(phase) || typeof work !== 'function') refuse();
  const origin = binding(env, 'workspaceOrigin');
  let proof: Request;
  try { proof = request.clone(); } catch { refuse(); }
  if (phase === 'start') await googleOAuthRequest(proof, origin, 'start');
  else googleOAuthRequest(proof, origin, 'callback');
  const options: IdentityOptions = { connectionString: database(binding(env, 'identityDatabase')),
    trustedOrigin: origin, sessionSecret: binding(env, 'identitySecret') };
  const transport = Object.freeze({ kind: 'direct' as const, connectionString: database(binding(env, 'workspaceDatabase')) });
  let custody: IntegrationOAuthCustody | undefined;
  const reader = () => custody ??= adapters.openCustody(options);
  const admission: WorkspaceAdmission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol('hosted-google'), trustedOrigin: origin,
    membership: async () => refuse(),
    googleOAuth: {
      issue: (original, workspace, authorize) => reader().issueGoogle(original, workspace, authorize),
      claim: (original, authorize) => reader().claimGoogleCallback(original, authorize),
    },
  });
  const admitted = (context: WorkspaceContext, state?: string) => work(Object.freeze({ context,
    withStore<U>(callContext: CallContext, use: (store: WorkspaceStore) => Promise<U>): Promise<U> {
      admission.assertContext(context, 'integrations.write');
      return adapters.withStore({ transport, workspace: { workspaceId: context.workspaceId } }, callContext, use);
    },
  }), state);
  try {
    return phase === 'start'
      ? await admission.withGoogleStart(crypto.randomUUID(), proof, admitted)
      : await admission.withGoogleCallback(crypto.randomUUID(), proof, admitted);
  } catch { return refuse(); }
  finally { if (custody) { try { await custody.close(); } catch { refuse(); } } }
}

/** Compare only the fixed RPC's duplicate inputs with the actual callback.
 * Classification/argument equality is not authority; the receiver still claims. */
export function googleOAuthArguments(input: unknown, request: Request, trustedOrigin: string, phase: 'start'): Promise<{ origin: string }>;
export function googleOAuthArguments(input: unknown, request: Request, trustedOrigin: string, phase: 'callback'): { code: string; state: string; redirectUri: string; error: string | null };
export function googleOAuthArguments(input: unknown, request: Request, trustedOrigin: string,
  phase: 'start' | 'callback'): Promise<{ origin: string }> | { code: string; state: string; redirectUri: string; error: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  if (phase === 'start') {
    const expected = { origin: trustedOrigin };
    if (!deepEqual(input, expected)) refuse();
    return googleOAuthRequest(request, trustedOrigin, 'start').then(() => expected);
  }
  const parsed = googleOAuthRequest(request, trustedOrigin, 'callback');
  const expected = { code: parsed.code ?? '', state: parsed.state,
    redirectUri: `${trustedOrigin}/api/integrations/google/oauth/callback`, error: parsed.error };
  if (!deepEqual(input, expected)) refuse();
  return expected;
}
