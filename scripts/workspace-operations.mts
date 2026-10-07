/** Server request classification (ro-ujb9.289.8.3.3.1).
 * Results are not authority. Every receiver classifies the original Request and
 * its own fixed method; never accept a serialized result, action, actor or profile.
 * Admission, identity, capabilities and standalone compatibility live elsewhere.
 */
import { WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import type { WorkspaceAction } from './workspace-admission.mjs';
import { parsePointer, validateSchemaAndSafety } from './config-documents.mjs';
import { fieldOf, isRowToken, matchKnob, matchRegister } from './config-registers.mjs';
import { MCP_METHODS, parseMcpMessage, type McpMessage } from './mcp-protocol.mjs';
import type { RuleBacktestInput } from '../packages/contract/src/rule-backtest.js';
import { WATCH_QUERY_MAX_CHARS, WATCH_SERIES } from '../packages/contract/src/watch-series.mjs';
import { CLOUDFLARE_D1_PATH, cloudflareAccountId, d1DatabaseId, d1Selection, type D1Request } from '../packages/contract/src/cloudflare-d1.mjs';
export { watchQueryHistoryRange } from '../packages/contract/src/watch-series.mjs';

export interface WorkspaceOperation {
  /** Classification only: neither caller authorization nor RPC argument,
   * asset-selector or workspace binding. Receivers retain those validators. */
  readonly kind: 'workspace' | 'protocol' | 'standalone-only' | 'public';
  readonly action: WorkspaceAction | null;
  readonly rpcMethods: readonly string[];
}
export class OperationRefused extends Error {
  override name = 'OperationRefused';
  constructor() { super('Workspace operation is not supported.'); }
}
function refuse(): never { throw new OperationRefused(); }
export function isCloudflareD1Request(request: Request): boolean {
  return request instanceof Request && new URL(request.url).pathname === CLOUDFLARE_D1_PATH;
}
/** The original request is the only selector supplied to either receiver. */
export async function cloudflareD1Request(request: Request): Promise<D1Request> {
  if (!isCloudflareD1Request(request) || request.url.length > 2048) refuse();
  const url = new URL(request.url);
  if (url.hash || url.username || url.password) refuse();
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) refuse();
  if (request.method === 'GET' && request.body === null) {
    if (keys.length === 0) return { kind: 'status' };
    if (keys.length === 1 && url.searchParams.get('view') === 'databases') return { kind: 'databases' };
    if (keys.length !== 4 || !keys.every(key => ['view', 'accountId', 'databaseId', 'runId'].includes(key)) || url.searchParams.get('view') !== 'artifact') refuse();
    const accountId = url.searchParams.get('accountId'), databaseId = url.searchParams.get('databaseId'), runId = url.searchParams.get('runId');
    if (!cloudflareAccountId(accountId) || !d1DatabaseId(databaseId) || !d1DatabaseId(runId)) refuse();
    return { kind: 'artifact', accountId, databaseId, runId };
  }
  if (keys.length || !['PUT', 'POST'].includes(request.method)) refuse();
  const body = await jsonBody(request);
  if (request.method === 'PUT') {
    const selection = d1Selection(body);
    if (!selection) refuse();
    return { kind: 'select', selection };
  }
  onlyKeys(body, ['accountId', 'databaseId']);
  if (!cloudflareAccountId(body.accountId) || !d1DatabaseId(body.databaseId)) refuse();
  return { kind: 'export', accountId: body.accountId, databaseId: body.databaseId };
}
export const GOOGLE_INTEGRATION_START = '/api/integrations/google/oauth/start';
export const GOOGLE_INTEGRATION_CALLBACK = '/api/integrations/google/oauth/callback';
export const GOOGLE_INTEGRATION_PROPERTIES = '/api/integrations/google/properties';
export interface WatchQueryRead {
  readonly asset: string;
  readonly metric: string;
  readonly query: string;
}
/** One retained GSC query, never a caller-selected archive key or time window. */
export function watchQueryHistoryRequest(request: Request): WatchQueryRead | null {
  if (!(request instanceof Request) || request.method !== 'GET' || request.body !== null
    || request.url.length > 12288) return null;
  const url = new URL(request.url);
  const match = /^\/api\/assets\/([^/]+)\/watch-query-history$/u.exec(url.pathname);
  if (!match || /%|\\/u.test(url.pathname) || url.hash || url.username || url.password
    || match[1]!.length > 255 || /[\u0000-\u0020\u007f]/u.test(match[1]!)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes('query') || !keys.includes('metric')) return null;
  const query = url.searchParams.get('query')?.trim() ?? '';
  const metric = url.searchParams.get('metric')?.trim() ?? '';
  if (!query || query.length > WATCH_QUERY_MAX_CHARS
    || !WATCH_SERIES.some(series => series.integration === 'gsc' && series.metric === metric)) return null;
  return Object.freeze({ asset: match[1]!, metric, query });
}
export type AssetMutationMethod = 'createAsset' | 'readAssetState' | 'writeAssetColumn' | 'moveAsset' | 'createAnnotation';
export type AssetMutationRoute =
  | { readonly kind: 'create' }
  | { readonly kind: 'column'; readonly asset: string }
  | { readonly kind: 'order'; readonly asset: string }
  | { readonly kind: 'decision'; readonly asset: string }
  | { readonly kind: 'annotation'; readonly asset: string }
  | { readonly kind: 'flag'; readonly number: number };
/** Fixed existing mutation routes. Protected watch registration is deliberately
 * absent; query/archive reads need their own reviewed entry. */
export function assetMutationRequest(request: Request): AssetMutationRoute | null {
  if (!(request instanceof Request) || request.url.length > 12288) return null;
  const url = new URL(request.url);
  if (url.search || url.hash || url.username || url.password || /%|\\/u.test(url.pathname)) return null;
  if (url.pathname === '/api/assets' && request.method === 'POST') return Object.freeze({ kind: 'create' });
  const flag = /^\/api\/flags\/([1-9]\d*)$/u.exec(url.pathname);
  if (flag && request.method === 'PATCH' && Number.isSafeInteger(Number(flag[1])))
    return Object.freeze({ kind: 'flag', number: Number(flag[1]) });
  const asset = /^\/api\/assets\/([^/]+)(?:\/(decisions|annotations|order))?$/u.exec(url.pathname);
  if (!asset) return null;
  const kind = asset[2] === 'decisions' && ['POST', 'DELETE'].includes(request.method) ? 'decision'
    : asset[2] === 'annotations' && request.method === 'POST' ? 'annotation'
    : asset[2] === 'order' && request.method === 'PATCH' ? 'order'
    : asset[2] === undefined && request.method === 'PATCH' ? 'column' : null;
  return kind ? Object.freeze({ kind, asset: asset[1]! }) : null;
}
/** Exact public envelope, bounded by the same catalog parser as other hosted
 * families. Ordinary writers retain field/domain validation and error results. */
export async function assetMutationInput(request: Request): Promise<{
  readonly route: AssetMutationRoute; readonly body: Readonly<Record<string, unknown>>;
}> {
  const route = assetMutationRequest(request);
  if (!route) refuse();
  const body = await jsonBody(request);
  if (route.kind === 'create') onlyKeys(body, ['id', 'displayName', 'domain', 'status', 'senseOnly']);
  else if (route.kind === 'column') {
    onlyKeys(body, ['column', 'value', 'expect']);
    if (!Object.hasOwn(body, 'expect')) refuse();
  }
  else if (route.kind === 'order') onlyKeys(body, ['to', 'expectRevision']);
  else if (route.kind === 'annotation') onlyKeys(body, ['kind', 'at', 'ref', 'note']);
  else if (route.kind === 'decision') onlyKeys(body, request.method === 'POST' ? ['kind', 'key', 'status', 'note'] : ['kind', 'key', 'note']);
  else onlyKeys(body, body.action === 'snooze' ? ['action', 'until'] : body.action === 'tune' ? ['action', 'tuned'] : ['action']);
  return Object.freeze({ route, body: Object.freeze(body) });
}
/** One fixed provider read, with no body or caller-selected discovery scope. */
export function isHostedGoogleDiscovery(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === 'GET' && url.pathname === GOOGLE_INTEGRATION_PROPERTIES
    && request.url.length <= 2048 && !request.url.includes('?') && !url.hash && request.body === null;
}
export type LiveProviderRead = { readonly method: 'ga4Realtime' | 'calendarUpcoming' }
  | { readonly method: 'siteName'; readonly domain: string };
/** Fixed panel reads. Property/feed selection remains in the selected store;
 * only the existing public-page name lookup accepts a bounded domain. */
export function liveProviderReadRequest(request: Request): LiveProviderRead | null {
  if (!(request instanceof Request) || request.method !== 'GET' || request.body !== null
    || request.url.length > 2048) return null;
  const url = new URL(request.url);
  if (url.hash || url.username || url.password) return null;
  if (['/api/ga4/realtime', '/api/calendar/upcoming'].includes(url.pathname)) {
    if (request.url.includes('?')) return null;
    return Object.freeze({ method: url.pathname === '/api/ga4/realtime' ? 'ga4Realtime' : 'calendarUpcoming' });
  }
  if (url.pathname !== '/api/site-name') return null;
  const keys = [...url.searchParams.keys()];
  const domain = url.searchParams.get('domain');
  if (keys.length !== 1 || keys[0] !== 'domain' || typeof domain !== 'string'
    || domain.length === 0 || domain.length > 512 || domain.trim() !== domain
    || /[\u0000-\u0020\u007f]/u.test(domain)) return null;
  return Object.freeze({ method: 'siteName', domain });
}
/** The existing connection-readiness family, not a general provider dispatcher.
 * Provider catalog validation remains with the ordinary route and receiver. */
export function connectionReadinessRequest(request: Request): {
  readonly provider: string;
  readonly method: 'discoverSites' | 'probeCredential';
} | null {
  if (!(request instanceof Request) || request.url.length > 2048) return null;
  const url = new URL(request.url);
  const match = /^\/api\/integrations\/([a-z][a-z0-9-]{0,63})\/(sites|test)$/u.exec(url.pathname);
  if (!match || request.url.includes('?') || url.hash || url.username || url.password) return null;
  if (match[2] === 'sites' && request.method === 'GET' && request.body === null)
    return Object.freeze({ provider: match[1]!, method: 'discoverSites' });
  if (match[2] === 'test' && request.method === 'POST')
    return Object.freeze({ provider: match[1]!, method: 'probeCredential' });
  return null;
}
export type CredentialWriteMethod = 'putCredential' | 'deleteCredential' |
  'setCredentialExpiry' | 'connectCredential' | 'putSiteToken';
export type ProviderCollectionMethod = 'collectNow' | 'syncMediavine';
/** These existing workflow effects have fixed paths and bounded asset inputs;
 * the original message, never a caller's lane/service claim, selects the edge. */
export function providerCollectionRequest(request: Request): {
  readonly provider: string; readonly method: ProviderCollectionMethod;
} | null {
  if (!(request instanceof Request) || request.url.length > 2048) return null;
  const url = new URL(request.url);
  if (request.method !== 'POST' || request.url.includes('?') || url.hash || url.username || url.password) return null;
  const match = /^\/api\/integrations\/([a-z][a-z0-9-]{0,63})\/collect$/u.exec(url.pathname);
  if (match) return Object.freeze({ provider: match[1]!, method: 'collectNow' });
  return url.pathname === '/api/integrations/mediavine/sync'
    ? Object.freeze({ provider: 'mediavine', method: 'syncMediavine' }) : null;
}
type ProviderCollectionInput =
  | { readonly method: 'collectNow'; readonly input: { provider: string; assets: readonly string[] } }
  | { readonly method: 'syncMediavine'; readonly input: { asset: string; start?: string; end?: string } };
/** Snapshot exact public fields before any identity, credential or provider I/O.
 * Ordinary collectors retain their mapping, date, lease and budget validation. */
export async function providerCollectionInput(request: Request): Promise<ProviderCollectionInput> {
  const parsed = providerCollectionRequest(request);
  if (!parsed) refuse();
  const body = await jsonBody(request);
  const asset = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= 253 && value.trim() === value;
  if (parsed.method === 'collectNow') {
    onlyKeys(body, ['assets']);
    if (!Array.isArray(body.assets) || body.assets.length > 100 || !body.assets.every(asset)) refuse();
    return Object.freeze({ method: 'collectNow', input: Object.freeze({
      provider: parsed.provider, assets: Object.freeze([...body.assets]),
    }) });
  }
  onlyKeys(body, ['asset', 'start', 'end']);
  if (!asset(body.asset)) refuse();
  for (const key of ['start', 'end']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(body[key]))) refuse();
  }
  return Object.freeze({ method: 'syncMediavine', input: Object.freeze({ asset: body.asset,
    ...(typeof body.start === 'string' ? { start: body.start } : {}),
    ...(typeof body.end === 'string' ? { end: body.end } : {}),
  }) });
}
/** Fixed existing credential operations; no provider, actor or action comes
 * from the body. Provider field rules remain in the ordinary credential store. */
export function credentialWriteRequest(request: Request): {
  readonly provider: string; readonly method: CredentialWriteMethod;
} | null {
  if (!(request instanceof Request) || request.url.length > 2048) return null;
  const url = new URL(request.url);
  const match = /^\/api\/integrations\/([a-z][a-z0-9-]{0,63})\/(credential|expiry|connect|site-token)$/u.exec(url.pathname);
  if (!match || request.url.includes('?') || url.hash || url.username || url.password) return null;
  const method = match[2] === 'credential' && request.method === 'PUT' ? 'putCredential'
    : match[2] === 'credential' && request.method === 'DELETE' ? 'deleteCredential'
    : match[2] === 'expiry' && request.method === 'PUT' ? 'setCredentialExpiry'
    : match[2] === 'connect' && request.method === 'POST' ? 'connectCredential'
    : match[2] === 'site-token' && request.method === 'PUT' ? 'putSiteToken' : null;
  return method ? Object.freeze({ provider: match[1]!, method }) : null;
}
type CredentialWriteInput =
  | { readonly method: 'putCredential' | 'connectCredential'; readonly input: { provider: string; fields: Record<string, string> } }
  | { readonly method: 'deleteCredential'; readonly input: string }
  | { readonly method: 'setCredentialExpiry'; readonly input: { provider: string; expiresAt: string | null } }
  | { readonly method: 'putSiteToken'; readonly input: { provider: string; asset: string; token: string } };
/** A bounded snapshot of the original body, shared with the fixed receiver's
 * duplicate-argument check. Secrets are neither logged nor returned to HTTP. */
export async function credentialWriteInput(request: Request): Promise<CredentialWriteInput> {
  const parsed = credentialWriteRequest(request);
  if (!parsed) refuse();
  const { provider, method } = parsed;
  if (method === 'deleteCredential') {
    await emptyRequestBody(request);
    return Object.freeze({ method, input: provider });
  }
  const body = await jsonBody(request);
  if (method === 'putCredential' || method === 'connectCredential') {
    onlyKeys(body, ['fields']);
    const raw = record(body.fields);
    if (Object.values(raw).some(value => typeof value !== 'string')) refuse();
    const fields = Object.freeze(Object.fromEntries(Object.entries(raw))) as Record<string, string>;
    return Object.freeze({ method, input: Object.freeze({ provider, fields }) });
  }
  if (method === 'setCredentialExpiry') {
    onlyKeys(body, ['expiresAt']);
    if (body.expiresAt !== null && typeof body.expiresAt !== 'string') refuse();
    return Object.freeze({ method, input: Object.freeze({ provider, expiresAt: body.expiresAt }) });
  }
  onlyKeys(body, ['asset', 'token']);
  if (typeof body.asset !== 'string' || typeof body.token !== 'string') refuse();
  return Object.freeze({ method, input: Object.freeze({ provider, asset: body.asset, token: body.token }) });
}
export interface GoogleCallbackInput { readonly state: string; readonly code: string | null; readonly error: string | null; }
/** Fixed protocol grammar, not identity or authority. Consumers pass the real
 * original Request and their server-declared origin, never serialized results. */
export function googleOAuthRequest(request: Request, trustedOrigin: string, phase: 'start'): Promise<{ readonly workspaceId: string }>;
export function googleOAuthRequest(request: Request, trustedOrigin: string, phase: 'callback'): GoogleCallbackInput;
export function googleOAuthRequest(request: Request, trustedOrigin: string, phase: 'start' | 'callback'):
  Promise<{ readonly workspaceId: string }> | GoogleCallbackInput {
  if (!(request instanceof Request) || request.url.length > 12288 || !['start', 'callback'].includes(phase)) refuse();
  const url = new URL(request.url);
  if (url.origin !== trustedOrigin || url.username || url.password || url.hash
    || request.method !== (phase === 'start' ? 'POST' : 'GET')
    || url.pathname !== (phase === 'start' ? GOOGLE_INTEGRATION_START : GOOGLE_INTEGRATION_CALLBACK)) refuse();
  if (phase === 'start') {
    const workspaceId = request.headers.get(WORKSPACE_SELECTION_HEADER);
    if (url.search || !workspaceId
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(workspaceId)) refuse();
    return emptyRequestBody(request).then(() => Object.freeze({ workspaceId }));
  }
  if (request.headers.has(WORKSPACE_SELECTION_HEADER)) refuse();
  const allowed = ['state', 'code', 'error', 'scope', 'authuser', 'prompt', 'hd', 'error_description', 'error_uri'];
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key) || value.length > 4096) refuse();
    seen.add(key);
  }
  const state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error');
  if (!state || !/^[A-Za-z0-9_-]{43}$/u.test(state) || (code === null) === (error === null)
    || (code !== null && code.length === 0) || (error !== null && (error.length === 0 || error.length > 128))) refuse();
  return Object.freeze({ state, code, error });
}
/** HTTP can represent an empty POST as a stream. Read a clone to completion:
 * Content-Length never proves emptiness, and even zero-byte chunks need a
 * whole-read deadline. The handler retains ownership of the original body. */
async function emptyRequestBody(request: Request): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = request.clone().body;
    if (request.signal.aborted) refuse();
    if (!body) return;
    reader = body.getReader();
  } catch { refuse(); }
  const deadline = Date.now() + 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationRefused()), 2000);
  });
  let emptyChunks = 0;
  try {
    for (;;) {
      if (request.signal.aborted || Date.now() >= deadline) refuse();
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) return;
      if (chunk.value.byteLength !== 0 || ++emptyChunks > 64) refuse();
    }
  } catch { refuse(); }
  finally {
    clearTimeout(timer);
    // Tee cancellation may await the handler's original branch. Observe it
    // without delaying refusal; only this clone's lock belongs to the parser.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
const operation = (action: WorkspaceAction | null, methods: readonly string[] = [],
  kind: WorkspaceOperation['kind'] = 'workspace'): WorkspaceOperation =>
  Object.freeze({ kind, action, rpcMethods: Object.freeze([...methods]) });
const configRead = 'getConfigDocuments';
const evidence = operation('evidence.read', [configRead]);
const publicRead = operation(null, [], 'public');
const standalone = operation(null, [], 'standalone-only');
const ingestHttp: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '/api/pulse': ['POST'], '/api/revenue': ['POST'], '/api/annotations': ['POST'],
  '/api/reclamation-targets': ['GET', 'POST'], '/api/watch-windows': ['POST'],
  '/api/watch-readbacks': ['GET', 'POST'], '/api/credentials/rotate-key': ['POST'],
  '/api/config-documents': ['GET'], '/api/config-documents/seed': ['POST'], '/api/config-documents/apply': ['POST'],
  '/api/beads-snapshot': ['POST'], '/api/job-runs': ['GET', 'POST'], '/api/insight-snapshot': ['POST'],
  '/api/asset-state': ['GET', 'POST'], '/api/signal-collect': ['POST'], '/api/bing-ai-export': ['POST'],
  '/api/research-log/lookup': ['POST'], '/api/research-log': ['POST'], '/api/provider-spend': ['GET'],
  '/api/serp-panel-landings': ['GET'], '/api/panel-source': ['GET'], '/api/signal-archives': ['GET'],
  '/api/panel-object': ['GET'], '/api/os-asset': ['GET'], '/api/capacity': ['GET'], '/healthz': ['GET'],
});
const hostedStoredRoutes: Readonly<Record<string, WorkspaceOperation>> = Object.freeze({
  '/api/demo/presentation': operation('evidence.read'),
  '/api/wall': evidence,
  '/api/wall/feed': evidence,
  '/api/financials': evidence,
  '/api/alerts/history': operation('evidence.read'),
  '/api/alerts/rules': operation('evidence.read'),
  '/api/work': operation('tasks.read'),
  '/api/task-source': operation('tasks.read', [configRead]),
  '/api/settings': operation('settings.read', [configRead]),
  '/api/integrations': operation('integrations.summary.read', [configRead]),
  '/api/integrations/health': operation('integrations.summary.read', ['integrationHealth']),
  '/api/integrations/providers': operation('integrations.summary.read', [configRead, 'listCredentialSummaries']),
  '/api/workflows': operation('workflows.read'),
  '/api/scheduled-jobs': operation('workflows.read'),
});
/** Reviewed store-only dispatch. Provider, credential and native reads have
 * separate entry work even when the semantic catalog classifies them. */
export function isHostedStoredRead(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return request.method === 'GET' && (Object.hasOwn(hostedStoredRoutes, path) || /^\/api\/assets\/[^/]+$/u.test(path));
}
const storedRoutes = hostedStoredRoutes;
const bodyLimit = 256 * 1024;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) refuse();
}
/** Read only a capped clone. Original bodies remain available to real handlers.
 * Byte and whole-read deadlines bound allocation and slow/incomplete streams.
 */
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.signal.aborted) refuse();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) refuse();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > bodyLimit)) refuse();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { const body = request.clone().body; if (!body) refuse(); reader = body.getReader(); } catch { refuse(); }
  let size = 0, emptyChunks = 0;
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationRefused()), 2000);
    abort = () => reject(new OperationRefused());
  });
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (request.signal.aborted || Date.now() >= deadline) refuse();
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) {
        if (++emptyChunks > 64) refuse();
        continue;
      }
      size += chunk.value.byteLength;
      if (size > bodyLimit) refuse();
      chunks.push(chunk.value);
    }
    if (request.signal.aborted || Date.now() >= deadline) refuse();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown);
  } catch { refuse(); }
  finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    // A clone cancellation can wait for the untouched original tee branch.
    // Observe rejection without waiting on that unrelated handler body.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
const ordinaryRegisters = new Set([
  'asset-lane', 'asset-counters', 'asset-pull', 'domain-costs',
  'recurring-costs', 'serp-panel-queries', 'serp-panel-assets', 'signal-panels', 'entities',
]);
/** Classify semantics only; existing schema/field/concurrency validation stays
 * in config-documents and the writer. New targets never inherit admission.
 */
function configAction(ops: unknown): WorkspaceAction {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 256) refuse();
  try { validateSchemaAndSafety({ version: 1, slug: 'classification', createdAt: '2026-10-01T00:00:00Z', ops }); }
  catch { refuse(); }
  let protectedOp = false;
  for (const value of ops) {
    const op = record(value);
    if (!['file-json-set', 'file-json-insert', 'file-json-delete'].includes(op.kind as string)
      || typeof op.file !== 'string' || typeof op.pointer !== 'string') refuse();
    onlyKeys(op, ['kind', 'file', 'pointer', 'value', 'expect', 'expectAbsent']);
    const tokens = parsePointer(op.pointer);
    if (op.file === 'config/constants.json') {
      if (['flag_defaults', 'monthly_caps', 'explore_sleeve'].includes(tokens[0] ?? '')) protectedOp = true;
      else if (tokens.length === 1 && ['os_time_zone', 'operator_rate_usd_per_min'].includes(tokens[0]!)) { /* ordinary */ }
      else if (tokens[0] === 'schedules' && tokens.length <= 2) { /* ordinary schedule override */ }
      else refuse();
      continue;
    }
    if (['config/value-events.json', 'config/ga4-custom-dimensions.json'].includes(op.file)) {
      if (op.file === 'config/value-events.json') {
        const match = matchRegister(op.file, op.pointer);
        if (match?.key === 'product-use-stages') { continue; }
        // One absent-holder INSERT may introduce presentation alone. The
        // writer's transactional absence guard forbids neighboring clobber.
        if (op.kind === 'file-json-insert' && match?.key === 'value-events-assets' &&
          match.rest.length === 1 && isRowToken(match.register, match.rest[0]!) &&
          op.value !== null && typeof op.value === 'object' && !Array.isArray(op.value)) {
          const entry = op.value as Record<string, unknown>;
          if (Object.keys(entry).length === 1 && Object.hasOwn(entry, 'productUseStages') &&
            productUseStagesRefusal(entry.productUseStages) === null) continue;
        }
      }
      protectedOp = true; continue;
    }
    if (op.file === 'config/tower.json') {
      if (tokens.length !== 1 || !['wall', 'countdown'].includes(tokens[0]!)) refuse();
      continue;
    }
    const knob = matchKnob(op.file, op.pointer);
    if (knob) {
      if (knob.key === 'panel-freshness-bar') protectedOp = true;
      else if (knob.key !== 'panel-refresh-window') refuse();
      continue;
    }
    const match = matchRegister(op.file, op.pointer);
    if (!match || !ordinaryRegisters.has(match.key)) {
      // An asset integration replacement can remove unknown existing funnels.
      if (match?.key === 'asset-integrations' && match.rest.length === 1
        && isRowToken(match.register, match.rest[0]!)) { protectedOp = true; continue; }
      refuse();
    }
    // Longest-container matching represents a whole asset at the lane
    // container itself; replacing it can remove the existing PostHog funnels.
    if (match.key === 'asset-lane' && match.rest.length === 0) { protectedOp = true; continue; }
    if (match.rest.length < 1 || match.rest.length > 2) refuse();
    const [row, field] = match.rest;
    if (!(row === '-' && op.kind === 'file-json-insert') && !isRowToken(match.register, row!)) refuse();
    if (field !== undefined && !fieldOf(match.register, field)) refuse();
    if (match.key === 'asset-lane' && row === 'posthog' && (field === undefined || field === 'funnels')) protectedOp = true;
  }
  return protectedOp ? 'measurement.write' : 'settings.write';
}
export type StoredResearchRead =
  | { readonly method: 'mcp'; readonly body: Record<string, unknown>; readonly tool: string | null }
  | { readonly method: 'backtestRule'; readonly input: RuleBacktestInput };
/** Only the existing stored tools and candidate-rule replay. No provider call,
 * arbitrary RPC, threshold write or request-selected authority is inferred. */
export async function storedResearchReadRequest(request: Request): Promise<StoredResearchRead | null> {
  const url = new URL(request.url);
  if (!['/api/mcp', '/api/alerts/backtest'].includes(url.pathname)) return null;
  if (request.method !== 'POST' || request.url.length > 2048 || request.url.includes('?')
    || url.hash || url.username || url.password) refuse();
  const body = await jsonBody(request);
  if (url.pathname === '/api/alerts/backtest') {
    onlyKeys(body, ['asset', 'ruleId', 'config', 'metric', 'through']);
    if (typeof body.asset !== 'string' || body.asset.length === 0 || body.asset.length > 128
      || typeof body.ruleId !== 'string' || body.ruleId.length === 0 || body.ruleId.length > 128
      || (body.metric !== undefined && body.metric !== null && (typeof body.metric !== 'string' || body.metric.length > 120))
      || (body.through !== undefined && (typeof body.through !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(body.through)))) refuse();
    const config = record(body.config);
    onlyKeys(config, ['alpha', 'minBaselinePerDay', 'lowVolumeWindowHours']);
    if (!['alpha', 'minBaselinePerDay', 'lowVolumeWindowHours'].every(key => typeof config[key] === 'number' && Number.isFinite(config[key]))) refuse();
    return Object.freeze({ method: 'backtestRule', input: {
      asset: body.asset, ruleId: body.ruleId, config: { alpha: config.alpha as number, minBaselinePerDay: config.minBaselinePerDay as number, lowVolumeWindowHours: config.lowVolumeWindowHours as number },
      metric: (body.metric as string | null | undefined) ?? null,
      ...(typeof body.through === 'string' ? { through: body.through } : {}),
    } });
  }
  // The one MCP message shape both protocol eras share (mcp-protocol): only
  // its own methods, each with only its own params.
  let message: McpMessage;
  try { message = parseMcpMessage(body); } catch { refuse(); }
  if (!MCP_METHODS.includes(message.method)) refuse();
  if (message.method !== 'tools/call') return Object.freeze({ method: 'mcp', body, tool: null });
  const params = message.params;
  if (!['list_properties', 'property_report', 'research_lookup'].includes(params.name as string)) refuse();
  const args = params.arguments === undefined ? {} : record(params.arguments);
  const allowed = params.name === 'list_properties' ? [] : params.name === 'property_report' ? ['asset'] : ['endpoint', 'params', 'windowDays'];
  onlyKeys(args, allowed);
  if (params.name === 'property_report' && (typeof args.asset !== 'string' || args.asset.length === 0 || args.asset.length > 128)) refuse();
  if (params.name === 'research_lookup' && (typeof args.endpoint !== 'string' || args.endpoint.length === 0
    || args.endpoint.length > 2048 || !args.params || typeof args.params !== 'object' || Array.isArray(args.params)
    || (args.windowDays !== undefined && (typeof args.windowDays !== 'number' || !Number.isFinite(args.windowDays) || args.windowDays <= 0)))) refuse();
  return Object.freeze({ method: 'mcp', body, tool: params.name as string });
}
async function mcp(request: Request): Promise<WorkspaceOperation> {
  const read = await storedResearchReadRequest(request);
  if (read?.method !== 'mcp') refuse();
  return read.tool === 'research_lookup' ? operation('evidence.read', [configRead, 'researchLookup']) : evidence;
}
/** Classify an actual Tower request; no request field selects an entry profile. */
export async function towerOperation(request: Request): Promise<WorkspaceOperation> {
  if (!(request instanceof Request)) refuse();
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (/%|\\/u.test(pathname)) refuse();
  if (pathname === CLOUDFLARE_D1_PATH) {
    const selected = await cloudflareD1Request(request);
    return operation(selected.kind === 'status' ? 'integrations.summary.read' : selected.kind === 'databases' ? 'provider.read'
      : selected.kind === 'select' ? 'integrations.write' : 'workflows.run', ['cloudflareD1']);
  }
  if (method === 'GET' && pathname === '/api/health') return publicRead;
  if (pathname === '/api/runner/scheduled' && method === 'GET') return operation(null, ['runScheduled'], 'standalone-only');
  if (pathname.startsWith('/api/runner/ingest/')) {
    const target = pathname.slice('/api/runner/ingest'.length);
    if (Object.hasOwn(ingestHttp, target) && ingestHttp[target]!.includes(method)) return operation(null, ['fetch'], 'standalone-only');
    refuse();
  }
  if (pathname === '/api/integrations/import-env' && ['GET', 'POST'].includes(method)) return standalone;
  if (method === 'GET' && Object.hasOwn(storedRoutes, pathname)) return storedRoutes[pathname]!;
  if (pathname === '/api/config') {
    if (method === 'GET') return operation('settings.read', [configRead]);
    if (method !== 'PUT') refuse();
    const body = await jsonBody(request);
    onlyKeys(body, ['ops', 'slug', 'reason', 'expectVersions']);
    return operation(configAction(body.ops), ['applyConfigOps']);
  }
  if (pathname === '/api/mcp' && method === 'POST') return mcp(request);
  if (pathname === '/api/alerts/backtest') {
    if ((await storedResearchReadRequest(request))?.method !== 'backtestRule') refuse();
    return operation('evidence.read', ['backtestRule']);
  }
  if (['/api/ga4/realtime', '/api/calendar/upcoming', '/api/site-name'].includes(pathname)) {
    const panel = liveProviderReadRequest(request);
    if (!panel) refuse();
    return operation('provider.read', panel.method === 'siteName' ? [] : [panel.method]);
  }
  const mutation = assetMutationRequest(request);
  if (mutation) {
    const { body } = await assetMutationInput(request);
    if (mutation.kind === 'create') return operation('assets.write', ['createAsset']);
    if (mutation.kind === 'column') return operation('assets.write', ['readAssetState', 'writeAssetColumn']);
    if (mutation.kind === 'order') return operation('assets.write', ['moveAsset']);
    if (mutation.kind === 'annotation') return operation('annotations.write', ['createAnnotation']);
    return operation(mutation.kind === 'flag' && body.action === 'tune' ? 'measurement.write' : 'findings.write');
  }
  if (/^\/api\/assets\/[^/]+$/u.test(pathname)) {
    if (method === 'GET') return evidence;
    refuse();
  }
  const asset = /^\/api\/assets\/[^/]+\/(decisions|annotations|watch-windows|watch-query-history)$/u.exec(pathname);
  if (asset) {
    if (asset[1] === 'watch-windows' && method === 'POST') return operation('measurement.write', ['createWatchWindow']);
    if (asset[1] === 'watch-query-history') {
      if (!watchQueryHistoryRequest(request)) refuse();
      return operation('evidence.read', ['watchQueryHistory']);
    }
    refuse();
  }
  if (pathname.startsWith('/api/tasks') || pathname.startsWith('/api/gates/')) {
    if ((pathname === '/api/tasks' || /^\/api\/tasks\/[^/]+$/u.test(pathname)) && method === 'GET') return operation('tasks.read');
    if (pathname === '/api/tasks' && method === 'POST') return operation('tasks.write');
    if (/^\/api\/tasks\/[^/]+$/u.test(pathname) && method === 'PATCH') return operation('tasks.write');
    if (/^\/api\/tasks\/[^/]+\/(close|comments)$/u.test(pathname) && method === 'POST') return operation('tasks.write');
    if (/^\/api\/tasks\/[^/]+\/(respond|dismiss)$/u.test(pathname) && method === 'POST') return standalone;
    if (/^\/api\/gates\/[^/]+\/resolve$/u.test(pathname) && method === 'POST') return standalone;
    refuse();
  }
  if (pathname === GOOGLE_INTEGRATION_START && ['GET', 'POST'].includes(method)) return operation('integrations.write', ['beginGoogleOAuth']);
  if (pathname === GOOGLE_INTEGRATION_CALLBACK && method === 'GET') return operation(null, ['completeGoogleOAuth'], 'protocol');
  if (pathname === GOOGLE_INTEGRATION_PROPERTIES) {
    if (!isHostedGoogleDiscovery(request)) refuse();
    return operation('provider.read', ['discoverGoogleProperties']);
  }
  const integration = /^\/api\/integrations\/[^/]+\/(sites|collect|credential|expiry|connect|site-token|test|status|settings|sync)$/u.exec(pathname);
  if (integration) {
    const end = integration[1];
    if (end === 'sites' || end === 'test') {
      const readiness = connectionReadinessRequest(request);
      if (!readiness) refuse();
      if (readiness.method === 'probeCredential') onlyKeys(await jsonBody(request), []);
      return operation('provider.read', readiness.method === 'discoverSites'
        ? [configRead, 'discoverSites'] : ['probeCredential']);
    }
    if ((end === 'collect' || end === 'sync') && method === 'POST') {
      const collection = await providerCollectionInput(request);
      return operation('workflows.run', [collection.method]);
    }
    if (['credential', 'expiry', 'connect', 'site-token'].includes(end!)) {
      const write = await credentialWriteInput(request);
      return operation('integrations.write', [write.method]);
    }
    if (pathname.startsWith('/api/integrations/mediavine/')) {
      if (end === 'status' && method === 'GET') return operation('integrations.summary.read', ['mediavineStatus']);
      if (end === 'settings' && method === 'PUT') return operation('integrations.write', ['saveMediavineSettings']);
    }
  }
  refuse();
}
/** Receiver code supplies its fixed method. This never consumes a forwarded
 * classification. Fresh identity/admission is still required in this realm.
 * The receiver separately validates payload selectors against the admitted
 * workspace; matching this edge does not prove forwarded arguments intact.
 */
export async function ingestOperation(method: string, originalRequest: Request): Promise<WorkspaceOperation> {
  if (typeof method !== 'string') refuse();
  const selected = await towerOperation(originalRequest);
  if (!selected.rpcMethods.includes(method)) refuse();
  return selected;
}
import { productUseStagesRefusal } from '../packages/contract/src/product-use.mjs';
