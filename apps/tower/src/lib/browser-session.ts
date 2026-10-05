import { WORKSPACE_SELECTION_HEADER } from '../../../../scripts/browser-request-policy.mjs';
import type { ApiTransport } from './api';
import { responseInstant, responseJson } from './response-value';

export interface WorkspaceChoice {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly status: 'active' | 'provisioning' | 'suspended';
  readonly role: 'owner' | 'operator' | 'viewer';
}
export type BrowserSession =
  | Readonly<{ mode: 'standalone' }>
  | Readonly<{ mode: 'demo'; workspace: Readonly<{ workspaceId: string; displayName: string }> }>
  | Readonly<{ mode: 'hosted'; session: Readonly<{ principalId: string; sessionId: string; expiresAt: string }> | null;
      workspaces: readonly WorkspaceChoice[]; nextCursor: string | null; selectedWorkspace: WorkspaceChoice | null }>;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function invalid(): never { throw new Error('Browser session returned an invalid response.'); }
function choice(value: unknown): WorkspaceChoice {
  if (!record(value) || !exact(value, ['workspaceId', 'displayName', 'status', 'role']) || !uuid(value.workspaceId)
    || typeof value.displayName !== 'string' || value.displayName.trim().length === 0 || value.displayName.length > 200
    || !['active', 'provisioning', 'suspended'].includes(String(value.status)) || !['owner', 'operator', 'viewer'].includes(String(value.role))) invalid();
  return Object.freeze({ workspaceId: value.workspaceId, displayName: value.displayName,
    status: value.status as WorkspaceChoice['status'], role: value.role as WorkspaceChoice['role'] });
}

/** Bootstrap facts choose a UI lifetime; they never grant an operation. */
export function decodeBrowserSession(value: unknown): BrowserSession {
  if (!record(value)) invalid();
  if (value.mode === 'standalone' && exact(value, ['mode'])) return Object.freeze({ mode: 'standalone' });
  if (value.mode === 'demo') {
    const workspace = value.workspace;
    if (!exact(value, ['mode', 'workspace']) || !record(workspace) || !exact(workspace, ['workspaceId', 'displayName'])
      || !uuid(workspace.workspaceId) || typeof workspace.displayName !== 'string' || !workspace.displayName.trim() || workspace.displayName.length > 200) invalid();
    return Object.freeze({ mode: 'demo', workspace: Object.freeze({ workspaceId: workspace.workspaceId, displayName: workspace.displayName }) });
  }
  if (value.mode !== 'hosted' || !exact(value, ['mode', 'session', 'workspaces', 'nextCursor', 'selectedWorkspace'])
    || !Array.isArray(value.workspaces) || value.workspaces.length > 100 || (value.nextCursor !== null && !uuid(value.nextCursor))) invalid();
  const workspaces = Object.freeze(value.workspaces.map(choice));
  if (new Set(workspaces.map(item => item.workspaceId)).size !== workspaces.length) invalid();
  let session: Extract<BrowserSession, { mode: 'hosted' }>['session'] = null;
  if (value.session !== null) {
    if (!record(value.session) || !exact(value.session, ['principalId', 'sessionId', 'expiresAt']) || !uuid(value.session.principalId)
      || !uuid(value.session.sessionId) || typeof value.session.expiresAt !== 'string'
      || !responseInstant(value.session.expiresAt)) invalid();
    session = Object.freeze({ principalId: value.session.principalId, sessionId: value.session.sessionId, expiresAt: value.session.expiresAt });
  }
  const selectedWorkspace = value.selectedWorkspace === null ? null : choice(value.selectedWorkspace);
  if ((session === null && (workspaces.length !== 0 || value.nextCursor !== null || selectedWorkspace !== null))
    || (selectedWorkspace !== null && selectedWorkspace.status !== 'active')) invalid();
  const listed = workspaces.find(item => item.workspaceId === selectedWorkspace?.workspaceId);
  if (listed && JSON.stringify(listed) !== JSON.stringify(selectedWorkspace)) invalid();
  return Object.freeze({ mode: 'hosted', session, workspaces, nextCursor: value.nextCursor, selectedWorkspace });
}

/** Session reads precede the workspace runtime. No expected-session header,
 * automatic workspace choice, cookie inspection or local identity fallback. */
export async function fetchBrowserSession(fetch: ApiTransport, options: {
  base?: string; selected?: string; after?: string; signal?: AbortSignal;
} = {}): Promise<BrowserSession> {
  const base = options.base ?? '';
  if (base !== '' && !/^\/visit\/[a-f0-9]{32}$/u.test(base)) throw new Error('Browser session address is invalid.');
  if ((options.selected !== undefined && !uuid(options.selected)) || (options.after !== undefined && !uuid(options.after))) throw new Error('Browser selection is invalid.');
  const headers = new Headers({ accept: 'application/json' });
  if (options.selected !== undefined) headers.set(WORKSPACE_SELECTION_HEADER, options.selected);
  const response = await fetch(`${base}/api/session${options.after ? `?after=${options.after}` : ''}`, {
    headers, signal: options.signal, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Browser session could not be verified.');
  }
  const body = await responseJson(response, 'Browser session');
  options.signal?.throwIfAborted();
  const session = decodeBrowserSession(body);
  if (options.selected !== undefined && session.mode === 'hosted' && session.session !== null
    && session.selectedWorkspace?.workspaceId !== options.selected) invalid();
  return session;
}

/** Per-tab memory is indexed only after the server has verified this session. */
export function tabSelectionKey(session: { principalId: string; sessionId: string }): string {
  if (!uuid(session.principalId) || !uuid(session.sessionId)) throw new Error('Browser session is invalid.');
  return `noticeos:tab-workspace:${JSON.stringify([session.principalId, session.sessionId])}`;
}
