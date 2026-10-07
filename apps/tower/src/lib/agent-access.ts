import { AGENT_ACCESS_PATHS } from '../../../../scripts/agent-access.mjs';
import { WORKSPACE_SESSION_HEADER } from '../../../../scripts/browser-request-policy.mjs';
import type { ApiTransport } from './api';

/** What an agent asks for, as its sign-in page shows it (agent-access.mts). */
export type AgentRequest = Readonly<{ client: Readonly<{ name: string; uri: string | null }>; scopes: readonly string[] }>;

async function post(fetch: ApiTransport, path: string, body: unknown, signal: AbortSignal, sessionId?: string): Promise<unknown> {
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
  if (sessionId !== undefined) headers.set(WORKSPACE_SESSION_HEADER, sessionId);
  const response = await fetch(path, { method: 'POST', body: JSON.stringify(body), headers, credentials: 'same-origin',
    mode: 'same-origin', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]) });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Agent request refused.'); }
  return response.json();
}
export async function describeAgent(fetch: ApiTransport, query: string, signal: AbortSignal): Promise<AgentRequest> {
  const value = await post(fetch, AGENT_ACCESS_PATHS.request, { oauth_query: query }, signal);
  if (!value || typeof value !== 'object') throw new Error('Agent request is invalid.');
  const { client, scopes } = value as { client?: { name?: unknown; uri?: unknown }; scopes?: unknown };
  if (!client || typeof client.name !== 'string' || (client.uri !== null && typeof client.uri !== 'string')
    || !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) throw new Error('Agent request is invalid.');
  return Object.freeze({ client: Object.freeze({ name: client.name, uri: client.uri as string | null }), scopes: Object.freeze(scopes as string[]) });
}
/** The person's decision; resolves to where the browser goes next. */
export async function decideAgent(fetch: ApiTransport, input: { query: string; sessionId: string; workspaceId?: string },
  signal: AbortSignal): Promise<string> {
  const value = await post(fetch, AGENT_ACCESS_PATHS.approve, { oauth_query: input.query, accept: input.workspaceId !== undefined,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) }, signal, input.sessionId);
  const url = value && typeof value === 'object' && 'url' in value ? value.url : undefined;
  if (typeof url !== 'string' || !/^https?:\/\//u.test(url)) throw new Error('Agent redirect is invalid.');
  return url;
}
