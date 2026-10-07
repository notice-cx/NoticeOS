// Agent sign-in's authorization server (epic ro-cvl9): the identity engine's
// maintained OAuth 2.1 provider behind fixed routes only. MCP clients discover
// it from each protected resource's metadata, register themselves, send the
// person's browser to authorize, and exchange the code for a JWT access token
// bound to one MCP endpoint and one workspace.
//
// The person-facing steps happen on one Tower page (AGENT_ACCESS_PAGE): it
// signs the person in with the ordinary email code, then asks which workspace
// the agent may use and whether to allow it. Approval is one transaction: the
// session row is locked, the chosen workspace is set on it for the library's
// consent step to read as the consent reference, and cleared again before
// commit, so two tabs cannot mix up their choices and no later authorization
// inherits one. Membership and role are checked before anything is granted;
// a viewer's agent never receives a write scope.
import { sql } from 'kysely';
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { isValidIP, normalizeIP } from '@better-auth/core/utils/ip';
import { createBrowserRequestPolicy, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { AGENT_ACCESS_PATHS, AGENT_OAUTH_ROUTES, AGENT_QUERY, AGENT_SCOPES, AUTHORIZATION_SERVER_METADATA_PATH, OFFLINE_ACCESS,
  protectedResourceMetadata, resourceForMetadataPath } from '../../../scripts/agent-access.mjs';
import { readBoundedJsonText } from '../../../scripts/bounded-json-body.mjs';
import { identityEngine, openIdentityDatabase, validateIdentityOptions, UUID, IdentityRefused,
  type IdentityOptions } from './identity-engine.mjs';

export interface AgentSignInOptions extends IdentityOptions {
  /** Supplied by a trusted outer server adapter, never a browser claim. */
  readonly peerAddress: string;
}
export interface AgentSignIn {
  /** Answers one agent sign-in request, or null when the path is not one. */
  handle(request: Request): Promise<Response | null>;
  close(): Promise<void>;
}
/** Every path this adapter answers, for a router choosing where to send it. */
export function isAgentSignInPath(pathname: string): boolean {
  return pathname === AUTHORIZATION_SERVER_METADATA_PATH || resourceForMetadataPath(pathname) !== null
    || Object.hasOwn(AGENT_OAUTH_ROUTES, pathname) || (Object.values(AGENT_ACCESS_PATHS) as string[]).includes(pathname);
}

const BODY_BYTES = 16 * 1024;
function refuse(): never { throw new IdentityRefused('Agent sign-in refused'); }
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
function record(text: string, allowed: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) refuse();
  return value as Record<string, unknown>;
}
/** A registration that omits application_type and redirects only to this
 * machine's loopback is a native app (RFC 8252 §7.3), as MCP's 2026-07-28
 * revision requires clients to say. Older MCP clients leave it out, and the
 * library's OIDC default, web, refuses loopback redirects. */
function nativeByDefault(body: string): string {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return body; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
  const metadata = value as Record<string, unknown>;
  const uris = metadata.redirect_uris;
  if (metadata.application_type !== undefined || !Array.isArray(uris) || uris.length === 0
    || !uris.every(uri => typeof uri === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\//u.test(uri))) return body;
  return JSON.stringify({ ...metadata, application_type: 'native' });
}
function oauthQuery(value: unknown): string {
  if (typeof value !== 'string' || !AGENT_QUERY.test(value)) refuse();
  return value;
}
/** The scopes a role may hand an agent: a viewer's agent only reads. */
function grantable(role: string, requested: readonly string[]): string[] {
  return requested.filter(scope => scope === OFFLINE_ACCESS
    || (Object.hasOwn(AGENT_SCOPES, scope) && (role !== 'viewer' || !AGENT_SCOPES[scope]!.some(action => !action.endsWith('.read')))));
}

export function openAgentSignIn(input: AgentSignInOptions): AgentSignIn {
  const options = Object.freeze({ connectionString: input.connectionString, trustedOrigin: input.trustedOrigin,
    sessionSecret: input.sessionSecret });
  const origin = validateIdentityOptions(options);
  if (typeof input.peerAddress !== 'string' || !isValidIP(input.peerAddress)) refuse();
  const peer = normalizeIP(input.peerAddress);
  const policy = createBrowserRequestPolicy(origin);
  let resources: ReturnType<typeof openIdentityDatabase> | undefined;
  let validated: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  async function database() {
    resources ??= openIdentityDatabase(options);
    const { database } = await resources;
    // Fail closed until migration 0014 is applied.
    validated ??= (async () => {
      const context = await identityEngine(database, options, { transaction: true, agents: true, validateSchema: true }).$context;
      await context.checkSchema?.();
    })();
    await validated;
    return database;
  }
  /** A fresh request carrying only what the library needs, with the trusted peer. */
  function forwarded(request: Request, path: string, body?: string): Request {
    const headers = new Headers();
    for (const name of ['accept', 'authorization', 'content-type', 'cookie', 'origin', 'referer',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'user-agent']) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    headers.set('x-noticeos-trusted-peer', peer);
    return new Request(`${origin}${path}`, { method: request.method, headers, ...(body === undefined ? {} : { body }) });
  }
  async function library(request: Request, url: URL): Promise<Response> {
    if (request.method !== AGENT_OAUTH_ROUTES[url.pathname]) return json({ error: 'method_not_allowed' }, 405);
    let body: string | undefined;
    if (request.method === 'POST') {
      const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/x-www-form-urlencoded' && type !== 'application/json') return json({ error: 'invalid_request' }, 400);
      body = await request.text();
      if (body.length > BODY_BYTES) return json({ error: 'invalid_request' }, 400);
      if (url.pathname === '/api/auth/oauth2/register' && type === 'application/json') body = nativeByDefault(body);
    }
    const engine = identityEngine(await database(), options, { transaction: true, agents: true, validateSchema: false, peer });
    return engine.handler(forwarded(request, url.pathname + url.search, body));
  }
  /** What the page shows: the client's own name and address, and the access
   * it asks for. Never a grant; the query's signature is checked. */
  async function describe(request: Request): Promise<Response> {
    policy.assertEffect(request);
    const body = record(await readBoundedJsonText(request, BODY_BYTES), ['oauth_query']);
    const query = oauthQuery(body.oauth_query);
    if (!await verifyOAuthQueryParams(query, options.sessionSecret)) refuse();
    const params = new URLSearchParams(query);
    const clientId = params.get('client_id');
    if (!clientId || clientId.length > 512) refuse();
    const db = await database();
    const [client] = (await sql<{ name: string | null; uri: string | null; disabled: boolean | null }>`
      SELECT name, uri, disabled FROM noticeos_identity.auth_oauth_client WHERE client_id=${clientId}`.execute(db)).rows;
    if (!client || client.disabled) refuse();
    const engine = identityEngine(db, options, { transaction: true, agents: true, validateSchema: false, readOnlySession: true });
    const session = await engine.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
    return json({ client: { name: client.name ?? clientId, uri: client.uri },
      scopes: (params.get('scope') ?? '').split(' ').filter(scope => Object.hasOwn(AGENT_SCOPES, scope)),
      signedIn: session !== null });
  }
  /** The person's decision. Returns where to send the browser next: the
   * agent's redirect with a code, or with access_denied. */
  async function approve(request: Request): Promise<Response> {
    policy.assertEffect(request);
    const expectedSession = request.headers.get(WORKSPACE_SESSION_HEADER);
    if (!expectedSession || !UUID.test(expectedSession)) refuse();
    const body = record(await readBoundedJsonText(request, BODY_BYTES), ['oauth_query', 'accept', 'workspaceId']);
    const query = oauthQuery(body.oauth_query);
    if (typeof body.accept !== 'boolean' || (body.accept && (typeof body.workspaceId !== 'string' || !UUID.test(body.workspaceId)))
      || (!body.accept && body.workspaceId !== undefined)) refuse();
    if (!await verifyOAuthQueryParams(query, options.sessionSecret)) refuse();
    const accept = body.accept, workspaceId = body.workspaceId as string | undefined;
    const requested = (new URLSearchParams(query).get('scope') ?? '').split(' ').filter(Boolean);
    const db = await database();
    const url = await db.transaction().execute(async trx => {
      const engine = identityEngine(trx, options, { transaction: false, agents: true, validateSchema: false, peer });
      const session = await engine.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
      if (!session || session.session.id !== expectedSession) refuse();
      const [locked] = (await sql<{ id: string }>`SELECT id FROM noticeos_identity.auth_session
        WHERE id=${session.session.id}::uuid AND user_id=${session.user.id}::uuid AND expires_at>clock_timestamp() FOR UPDATE`.execute(trx)).rows;
      if (!locked) refuse();
      let scopes: string[] | undefined;
      if (accept) {
        const [member] = (await sql<{ role: string; status: string }>`SELECT m.role, w.status
          FROM noticeos_identity.auth_member m
          JOIN LATERAL noticeos_identity.workspace_summary(m.organization_id) w ON w.workspace_id=m.organization_id
          WHERE m.user_id=${session.user.id}::uuid AND m.organization_id=${workspaceId!}::uuid FOR SHARE OF m`.execute(trx)).rows;
        if (!member || member.status !== 'active') refuse();
        scopes = grantable(member.role, requested);
        if (!scopes.some(scope => scope !== OFFLINE_ACCESS)) refuse();
        await sql`UPDATE noticeos_identity.auth_session SET active_organization_id=${workspaceId!}
          WHERE id=${session.session.id}::uuid`.execute(trx);
      }
      const response = await engine.handler(forwarded(new Request(request.url, { method: 'POST', headers: new Headers({
        accept: 'application/json', 'content-type': 'application/json', cookie: request.headers.get('cookie') ?? '', origin }) }),
        '/api/auth/oauth2/consent', JSON.stringify({ accept, oauth_query: query, ...(scopes ? { scope: scopes.join(' ') } : {}) })));
      if (accept) await sql`UPDATE noticeos_identity.auth_session SET active_organization_id=NULL
        WHERE id=${session.session.id}::uuid`.execute(trx);
      const result: unknown = response.status === 200 ? await response.json() : null;
      const next = result && typeof result === 'object' && 'url' in result ? result.url : undefined;
      if (typeof next !== 'string') refuse();
      return next;
    });
    return json({ url });
  }
  async function operation(request: Request): Promise<Response | null> {
    if (!(request instanceof Request) || request.url.length > 16384) refuse();
    const url = new URL(request.url);
    if (url.origin !== origin || url.username || url.password || url.hash) refuse();
    const resource = resourceForMetadataPath(url.pathname);
    if (resource) {
      if (request.method !== 'GET' || url.search) return json({ error: 'not_found' }, 404);
      return Response.json(protectedResourceMetadata(origin, resource), { headers: { 'cache-control': 'public, max-age=300' } });
    }
    if (url.pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
      if (request.method !== 'GET' || url.search) return json({ error: 'not_found' }, 404);
      const engine = identityEngine(await database(), options, { transaction: true, agents: true, validateSchema: false });
      return oauthProviderAuthServerMetadata(engine as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0])(
        new Request(`${origin}/api/auth/.well-known/oauth-authorization-server`));
    }
    if (Object.hasOwn(AGENT_OAUTH_ROUTES, url.pathname)) return library(request, url);
    if (request.method !== 'POST' || url.search) return null;
    if (url.pathname === AGENT_ACCESS_PATHS.request) return describe(request);
    if (url.pathname === AGENT_ACCESS_PATHS.approve) return approve(request);
    return null;
  }
  return Object.freeze({
    handle(request: Request): Promise<Response | null> {
      if (closing) return Promise.reject(new IdentityRefused('Agent sign-in is closed'));
      const work = operation(request).catch((error: unknown) => {
        if (error instanceof IdentityRefused) return json({ error: 'refused' }, 403);
        throw new IdentityRefused('Agent sign-in failed');
      });
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        await Promise.allSettled([...pending]);
        if (resources) { const opened = await resources.catch(() => undefined); await opened?.database.destroy(); }
      })();
      return closing;
    },
  });
}
