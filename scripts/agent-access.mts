/** Agent sign-in (epic ro-cvl9): OAuth 2.1 for the hosted MCP endpoints, as
 * MCP's authorization specification defines it. These are the protocol facts
 * every side shares: the protected resources, the scopes an agent may hold and
 * the workspace actions each one grants, the discovery documents, and the
 * bearer challenges. The authorization server is the identity engine's
 * maintained OAuth provider (packages/postgres/src/agent-sign-in.mts); the
 * resource side is workspace admission, which rechecks membership on every
 * request. Nothing here grants anything by itself.
 *
 * A token names one workspace, the one its person chose when approving the
 * agent, and acts as that person within it. No scope reaches a human
 * decision, membership or a protected operation.
 */

/** The identity engine's base path; the issuer is the origin plus this. */
export const AGENT_AUTH_BASE = '/api/auth';
/** The one Tower page for every person-facing step: sign in, choose the
 * workspace, approve or deny. */
export const AGENT_ACCESS_PAGE = '/agent-access';
/** That page's two server calls. */
export const AGENT_ACCESS_PATHS = Object.freeze({
  request: '/api/agent-access/request',
  approve: '/api/agent-access/approve',
});
/** The maintained library endpoints a deployment exposes, and their methods.
 * Every other library route stays private. */
export const AGENT_OAUTH_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  '/api/auth/oauth2/authorize': 'GET',
  '/api/auth/oauth2/token': 'POST',
  '/api/auth/oauth2/register': 'POST',
  '/api/auth/oauth2/revoke': 'POST',
  '/api/auth/jwks': 'GET',
});

/** The signed authorization query the provider hands the page; the page
 * passes it back unread. Never authority: the server checks its signature. */
export const AGENT_QUERY = /^[A-Za-z0-9\-._~*%+=&]{1,8192}$/u;
export type AgentAccessLanding = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'agent'; query: string }>;
/** Capture at document entry: an agent page landing and its signed query. */
export function parseAgentAccessLanding(input: string): AgentAccessLanding {
  try {
    if (input.length > 9000) return Object.freeze({ kind: 'none' });
    const url = new URL(input);
    const query = url.search.slice(1);
    if (url.pathname !== AGENT_ACCESS_PAGE || !AGENT_QUERY.test(query) || url.username || url.password) return Object.freeze({ kind: 'none' });
    return Object.freeze({ kind: 'agent', query });
  } catch { return Object.freeze({ kind: 'none' }); }
}

export type AgentResource = 'tasks' | 'evidence';
export const AGENT_RESOURCES: Readonly<Record<AgentResource, Readonly<{ path: string; name: string; scopes: readonly string[] }>>> = Object.freeze({
  tasks: Object.freeze({ path: '/api/tasks/mcp', name: 'NoticeOS tasks', scopes: Object.freeze(['tasks:read', 'tasks:write']) }),
  evidence: Object.freeze({ path: '/api/mcp', name: 'NoticeOS read models', scopes: Object.freeze(['evidence:read']) }),
});
/** The workspace actions each scope grants. Write implies read: a token that
 * may change tasks may also see them. */
export const AGENT_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'tasks:read': Object.freeze(['tasks.read']),
  'tasks:write': Object.freeze(['tasks.read', 'tasks.write']),
  'evidence:read': Object.freeze(['evidence.read']),
});
/** Requested by clients that want a refresh token; it grants no action. */
export const OFFLINE_ACCESS = 'offline_access';
/** The access-token claim naming the token's workspace. */
export const WORKSPACE_CLAIM = 'noticeos_workspace';
export const AGENT_ACCESS_SECONDS = 3600;
export const AGENT_REFRESH_SECONDS = 30 * 86_400;

export function agentIssuer(origin: string): string { return origin + AGENT_AUTH_BASE; }
export function agentResourceUri(origin: string, resource: AgentResource): string {
  return origin + AGENT_RESOURCES[resource].path;
}
/** RFC 8414 path insertion for an issuer with a path. */
export const AUTHORIZATION_SERVER_METADATA_PATH = `/.well-known/oauth-authorization-server${AGENT_AUTH_BASE}`;
/** RFC 9728 path insertion for each protected resource. */
export function protectedResourceMetadataPath(resource: AgentResource): string {
  return `/.well-known/oauth-protected-resource${AGENT_RESOURCES[resource].path}`;
}
export function resourceForPath(pathname: string): AgentResource | null {
  for (const [key, value] of Object.entries(AGENT_RESOURCES)) if (value.path === pathname) return key as AgentResource;
  return null;
}
export function resourceForMetadataPath(pathname: string): AgentResource | null {
  for (const key of Object.keys(AGENT_RESOURCES) as AgentResource[]) if (protectedResourceMetadataPath(key) === pathname) return key;
  return null;
}
export function protectedResourceMetadata(origin: string, resource: AgentResource): Record<string, unknown> {
  return {
    resource: agentResourceUri(origin, resource),
    authorization_servers: [agentIssuer(origin)],
    scopes_supported: [...AGENT_RESOURCES[resource].scopes],
    bearer_methods_supported: ['header'],
    resource_name: AGENT_RESOURCES[resource].name,
  };
}

/** The bearer credential a request carries: none, one token, or a malformed
 * Authorization header (refused, never ignored). */
export function bearerToken(headers: Headers): string | null | false {
  const value = headers.get('authorization');
  if (value === null) return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]{16,4096}=*)$/iu.exec(value);
  return match ? match[1]! : false;
}
/** The actions a set of granted scopes allows, before the person's role is
 * applied. Unknown scopes grant nothing. */
export function agentActions(scopes: readonly string[]): readonly string[] {
  const actions = new Set<string>();
  for (const scope of scopes) for (const action of AGENT_SCOPES[scope] ?? []) actions.add(action);
  return Object.freeze([...actions].sort());
}
/** The scopes an MCP request needs. */
export function requiredScopes(resource: AgentResource, write: boolean): readonly string[] {
  return resource === 'tasks' ? [write ? 'tasks:write' : 'tasks:read'] : ['evidence:read'];
}
export function scopesSatisfy(granted: readonly string[], required: readonly string[]): boolean {
  const actions = agentActions(granted);
  return required.every(scope => (AGENT_SCOPES[scope] ?? ['(none)']).every(action => actions.includes(action)));
}

function quoted(value: string): string { return `"${value.replace(/["\\]/gu, '')}"`; }
/** RFC 6750 §3 and MCP's scope challenge: 401 when a token is missing or
 * invalid, 403 when it lacks a scope. The body is JSON for humans; clients
 * read the header. */
export function bearerChallenge(origin: string, resource: AgentResource,
  failure?: { readonly error: 'invalid_token' | 'insufficient_scope'; readonly scopes?: readonly string[] }): Response {
  const scope = (failure?.scopes ?? AGENT_RESOURCES[resource].scopes).join(' ');
  const parts = [
    ...(failure ? [`error=${quoted(failure.error)}`] : []),
    `resource_metadata=${quoted(origin + protectedResourceMetadataPath(resource))}`,
    `scope=${quoted(scope)}`,
  ];
  return new Response(JSON.stringify({ error: failure?.error ?? 'unauthorized' }), {
    status: failure?.error === 'insufficient_scope' ? 403 : 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': `Bearer ${parts.join(', ')}` },
  });
}
