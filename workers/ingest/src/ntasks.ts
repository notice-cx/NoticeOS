// The task service: an Ntasks Worker that holds this installation's tasks
// (docs/11-integrations.md#ntasks). Its service credential is used only in
// this Worker; routes/task-service.ts is how the Node side reaches it.

import type { ConnectionFailure, ProbeResult } from '@noticeos/contract';
import { isLocalAddress } from './local-model.js';
import { NTASKS_BACKUP_SCOPE_QUERY, NTASKS_BACKUP_TOKEN, ntasksBackupAccess, ntasksBackupCredential, ntasksEndpoint } from '../../../scripts/ntasks-backup-access.mjs';

export const NTASKS_URL = 'NTASKS_URL';
export const NTASKS_TOKEN = 'NTASKS_TOKEN';
export const NTASKS_WORKSPACE_ID = 'NTASKS_WORKSPACE_ID';
const WORKSPACE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
declare global {
  interface IngestEnv {
    NOTICEOS_NTASKS_ORIGIN?: string;
  }
}

/** Hosted connections share a deployment-selected origin, never a destination
 * supplied by the workspace alone. Validate before any request or save. */
export function hostedNtasksAddress(env: IngestEnv, fields: Record<string, unknown>): { origin: string; workspaceId: string } {
  const origin = ntasksOrigin(env.NOTICEOS_NTASKS_ORIGIN ?? '');
  const workspaceId = fields[NTASKS_WORKSPACE_ID];
  if (typeof fields[NTASKS_URL] !== 'string' || ntasksOrigin(fields[NTASKS_URL]) !== origin
    || typeof workspaceId !== 'string' || !WORKSPACE.test(workspaceId)
    || typeof fields[NTASKS_TOKEN] !== 'string' || !/^ntasks_service\.[A-Za-z0-9._~-]+$/u.test(fields[NTASKS_TOKEN])) {
    throw new TaskServiceError({ kind: 'configuration' });
  }
  return { origin, workspaceId };
}
/** The Tower's client id as a connected app of this Ntasks: public, and what
 * a person's browser signs in with (docs/guides/keep-tasks-in-ntasks.md). */
export const NTASKS_APP_CLIENT_ID = 'NTASKS_APP_CLIENT_ID';
const CLIENT_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

/** The saved client id, or null when none is saved or it is not one. */
export function ntasksAppClientId(fields: Readonly<Record<string, string>>): string | null {
  const value = fields[NTASKS_APP_CLIENT_ID]?.trim() ?? '';
  return CLIENT_ID.test(value) ? value : null;
}
/** The name the Tower registers under as a connected app; Ntasks shows it when a person allows it. */
export const NTASKS_APP_NAME = 'NoticeOS Tower';
/** What the Tower's page asks for when it signs a person in (apps/tower/src/lib/ntasks-sign-in.ts). */
const NTASKS_APP_SCOPE = 'tasks:read tasks:write tasks:decide offline_access';
/** Ntasks's own refusal codes, as RFC 7591 names them; nothing else of its answer is passed on. */
const REFUSAL_CODE = /^[a-z_]{1,64}$/u;

/** Ntasks's answer to registering the Tower: its client id and whether Ntasks
 * holds the address until a workspace owner allows it, or the code and status
 * it refused with. */
export type NtasksAppRegistration =
  | { readonly registered: true; readonly clientId: string; readonly held: boolean }
  | { readonly registered: false; readonly status: number; readonly error: string };

/**
 * Registers the Tower's page, returning to `redirectUri`, as a connected app
 * of the credential's Ntasks workspace: RFC 7591 registration with the
 * service credential as the initial access token (Ntasks docs/sign-in.md,
 * "Registering an app from a service"). Ntasks answers the app it already has
 * for the same name and address. Throws TaskServiceError when Ntasks gave no
 * answer, or answered 429 or 5xx, which says nothing about the registration.
 */
export async function registerNtasksApp(fields: Record<string, string>, redirectUri: string,
  fetchImpl: typeof fetch = fetch): Promise<NtasksAppRegistration> {
  const { status, body } = await callNtasks(fields, { method: 'POST', path: '/api/auth/oauth2/register',
    body: JSON.stringify({ client_name: NTASKS_APP_NAME, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: NTASKS_APP_SCOPE }) }, fetchImpl);
  if (status === 429 || status >= 500) throw new TaskServiceError({ kind: status === 429 ? 'rate-limited' : 'http', status });
  const answer = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const clientId = typeof answer.client_id === 'string' ? answer.client_id : '';
  if (status === 200 || status === 201) {
    if (!CLIENT_ID.test(clientId)) throw new TaskServiceError({ kind: 'invalid-response', status });
    // An Ntasks older than home-network addresses sends no held_redirect_uris and holds none.
    const held = Array.isArray(answer.held_redirect_uris) && answer.held_redirect_uris.includes(redirectUri);
    return { registered: true, clientId, held };
  }
  const error = typeof answer.error === 'string' && REFUSAL_CODE.test(answer.error) ? answer.error : 'refused';
  return { registered: false, status, error };
}

/** One Ntasks answer, at most: a board of a large project fits well inside it. */
const RESPONSE_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export class TaskServiceError extends Error {
  constructor(readonly failure: ConnectionFailure) { super(`Ntasks: ${failure.kind}.`); this.name = 'TaskServiceError'; }
}

/** HTTPS, or HTTP to a local address; no password, path, query or fragment. */
export function ntasksOrigin(value: string): string {
  const url = ntasksEndpoint(value);
  if (!url || (url.protocol === 'http:' && !isLocalAddress(url.hostname))) {
    throw new TaskServiceError({ kind: 'configuration' });
  }
  return url.origin;
}

export interface TaskServiceCall {
  readonly method: string;
  /** A server-owned selection, absent from the standalone operator API. */
  readonly workspaceId?: string;
  /** An Ntasks path with its query, such as `/api/tasks?project=…`. */
  readonly path: string;
  readonly body?: string;
  /** Statuses whose response body this caller does not consume. */
  readonly statusOnly?: readonly number[];
  readonly idempotencyKey?: string;
  /** The agent the call is for: Ntasks records it as `service:<credential>/<name>`. */
  readonly onBehalfOf?: string;
}

/** `x-ntasks-on-behalf-of`'s grammar, Ntasks's own. */
export const ON_BEHALF_OF = /^[A-Za-z0-9._:/-]{1,128}$/u;

/** What the caller learns: Ntasks's own status and JSON body, or why it did not answer. */
export type TaskServiceAnswer =
  | { readonly answered: true; readonly status: number; readonly body: unknown }
  | { readonly answered: false; readonly reason: 'not-connected' | ConnectionFailure['kind']; readonly status?: number };

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTES) { await response.body?.cancel(); throw new TaskServiceError({ kind: 'too-large' }); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > RESPONSE_BYTES) { await reader.cancel(); throw new TaskServiceError({ kind: 'too-large' }); }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

/** One call to Ntasks with these connection fields. Throws TaskServiceError
 * when Ntasks gave no answer this caller can read. */
export async function callNtasks(fields: Record<string, string>, call: TaskServiceCall,
  fetchImpl: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  const origin = ntasksOrigin(fields[NTASKS_URL] ?? '');
  const token = fields[NTASKS_TOKEN]?.trim();
  if (!token) throw new TaskServiceError({ kind: 'configuration' });
  const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` });
  if (call.workspaceId !== undefined) headers.set('x-ntasks-workspace', call.workspaceId);
  if (call.body !== undefined) headers.set('content-type', 'application/json');
  if (call.idempotencyKey !== undefined) headers.set('idempotency-key', call.idempotencyKey);
  if (call.onBehalfOf !== undefined) headers.set('x-ntasks-on-behalf-of', call.onBehalfOf);
  // Stateless MCP: every call names the protocol version instead of a handshake.
  if (call.path === '/api/mcp') { headers.set('mcp-protocol-version', '2025-06-18'); headers.set('accept', 'application/json, text/event-stream'); }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let response: Response;
    try {
      // workerd does not support redirect: 'error'; manual keeps the credential off a redirect's target.
      response = await fetchImpl(`${origin}${call.path}`, { method: call.method, headers, redirect: 'manual', signal: controller.signal,
        ...(call.body === undefined ? {} : { body: call.body }) });
    } catch { throw new TaskServiceError({ kind: timedOut ? 'timeout' : 'network' }); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TaskServiceError({ kind: 'redirect', status: response.status });
    }
    if (call.statusOnly?.includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      return { status: response.status, body: null };
    }
    let text: string;
    try { text = await boundedText(response); } catch (error) {
      if (error instanceof TaskServiceError) throw error;
      throw new TaskServiceError({ kind: timedOut ? 'timeout' : 'network' });
    }
    let body: unknown = null;
    if (text !== '') {
      try { body = JSON.parse(text); } catch { throw new TaskServiceError({ kind: 'invalid-response', status: response.status }); }
    }
    return { status: response.status, body };
  } finally { clearTimeout(timer); }
}

/** The workspaces Ntasks lists for the current credential. */
async function credentialWorkspaces(fields: Record<string, string>, fetchImpl: typeof fetch) {
  const { status, body } = await callNtasks(fields, { method: 'POST', path: '/api/mcp', body: NTASKS_BACKUP_SCOPE_QUERY }, fetchImpl);
  const result = (body as { result?: { isError?: boolean; structuredContent?: { workspaces?: unknown } } } | null)?.result;
  const workspaces = result?.structuredContent?.workspaces;
  return status === 200 && result?.isError !== true && Array.isArray(workspaces)
    ? workspaces as ({ status?: unknown; workspaceId?: unknown; access?: unknown } | null)[] : null;
}

async function checkBackupOnlyCredential(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<boolean> {
  const backup = ntasksBackupCredential(fields);
  if (!backup) return false;
  const reply = await callNtasks({ ...fields, [NTASKS_TOKEN]: backup.token },
    { method: 'POST', path: '/api/mcp', workspaceId: backup.workspaceId, body: NTASKS_BACKUP_SCOPE_QUERY }, fetchImpl);
  return ntasksBackupAccess(reply.status, reply.body, backup.workspaceId);
}

/** The connection test and the connect panel's proof: the projects the
 * credential reaches, and that it was made with the backup choice, without
 * which the nightly backup cannot read the store. */
export async function checkNtasks(fields: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const { status, body } = await callNtasks(fields, { method: 'GET', path: '/api/tasks/projects' }, fetchImpl);
    if (status === 401 || status === 403) return { outcome: 'refused', fix: { kind: 'replace' }, failure: { kind: 'access', status } };
    const projects = (body as { projects?: unknown } | null)?.projects;
    if (status !== 200 || !Array.isArray(projects)) return { outcome: 'unreachable', failure: { kind: status === 200 ? 'invalid-response' : 'http', status } };
    const facts = { projects: projects.length };
    const workspaces = await credentialWorkspaces(fields, fetchImpl);
    if (!workspaces) return { outcome: 'unreachable', facts, failure: { kind: 'invalid-response' } };
    const refused = { outcome: 'refused', facts, fix: { kind: 'replace' }, failure: { kind: 'backup-missing' } } as const;
    if (fields[NTASKS_BACKUP_TOKEN] !== undefined) {
      const active = workspaces.filter(workspace => workspace?.status === 'active');
      if (active.length !== 1 || active[0]?.workspaceId !== fields[NTASKS_WORKSPACE_ID] || !await checkBackupOnlyCredential(fields, fetchImpl)) {
        return refused;
      }
      return { outcome: 'answered', facts };
    }
    if (!workspaces.some(workspace => Array.isArray(workspace?.access) && workspace.access.includes('tasks:backup'))) return refused;
    return { outcome: 'answered', facts };
  } catch (error) {
    if (error instanceof TaskServiceError && error.failure.kind === 'configuration') return { outcome: 'invalid', failing: ['Ntasks address'], failure: error.failure };
    return { outcome: 'unreachable', ...(error instanceof TaskServiceError ? { failure: error.failure } : {}) };
  }
}

/** Ntasks reports the grant's current projects and their owning workspace.
 * A hosted connection uses a project-granted service credential. */
export async function readHostedNtasksProjects(env: IngestEnv, fields: Record<string, string>, fetchImpl: typeof fetch = fetch) {
  const { origin, workspaceId } = hostedNtasksAddress(env, fields);
  const [account, catalog] = await Promise.all(['/api/access/me', '/api/tasks/projects']
    .map(path => callNtasks(fields, { method: 'GET', path, workspaceId }, fetchImpl)));
  for (const reply of [account!, catalog!]) {
    if (reply.status === 401 || reply.status === 403) throw new TaskServiceError({ kind: 'access', status: reply.status });
    if (reply.status !== 200) throw new TaskServiceError({ kind: 'http', status: reply.status });
  }
  const grants = account!.body as { kind?: unknown; projects?: { workspaceId?: unknown; projectId?: unknown; access?: unknown }[] } | null;
  const projects = (catalog!.body as { projects?: readonly (Record<string, unknown> & {
    projectId: string; logicalKey: string; displayName: string; prefix: string;
  })[] } | null)?.projects;
  if (grants?.kind !== 'service' || !Array.isArray(grants.projects) || !Array.isArray(projects) || projects.length === 0 || projects.length > 64
    || grants.projects.length !== projects.length || grants.projects.some(grant => grant?.workspaceId !== workspaceId
      || typeof grant.projectId !== 'string' || !['read', 'write'].includes(String(grant.access)))
    || projects.some(project => !project || typeof project.projectId !== 'string' || typeof project.logicalKey !== 'string'
      || typeof project.displayName !== 'string' || typeof project.prefix !== 'string'
      || !grants.projects!.some(grant => grant.projectId === project.projectId))
    || new Set(projects.map(project => project.projectId)).size !== projects.length
    || new Set(projects.map(project => project.prefix)).size !== projects.length) {
    throw new TaskServiceError({ kind: 'access' });
  }
  return { origin, workspaceId, projects, writable: grants.projects.some(grant => grant.access === 'write') };
}

export async function checkHostedNtasks(env: IngestEnv, fields: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const { projects } = await readHostedNtasksProjects(env, fields, fetchImpl);
    const facts = { projects: projects.length };
    return fields[NTASKS_BACKUP_TOKEN] === undefined || await checkBackupOnlyCredential(fields, fetchImpl)
      ? { outcome: 'answered', facts }
      : { outcome: 'refused', facts, fix: { kind: 'replace' }, failure: { kind: 'backup-missing' } };
  } catch (error) {
    if (error instanceof TaskServiceError && error.failure.kind === 'configuration') {
      return { outcome: 'invalid', failing: ['Ntasks connection'], failure: error.failure };
    }
    if (error instanceof TaskServiceError && error.failure.kind === 'access') {
      return { outcome: 'refused', fix: { kind: 'replace' }, failure: error.failure };
    }
    return { outcome: 'unreachable', ...(error instanceof TaskServiceError ? { failure: error.failure } : {}) };
  }
}
