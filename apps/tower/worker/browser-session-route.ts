import { openIdentity, type IdentityOptions, type WorkspaceSummary } from '@noticeos/postgres/identity';
import { readBrowserSession, type BrowserSessionSnapshot } from '@noticeos/postgres/browser-session';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { workspaceEntryOrigin, workspaceProfile, WORKSPACE_SELECTION_HEADER,
  type WorkspaceEntryBindings } from '../../../scripts/workspace-entry.mjs';

export const BROWSER_SESSION_PATH = '/api/session';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const RESPONSE_HEADERS = { 'cache-control': 'no-store', vary: 'Cookie' };
export interface BrowserSessionReaders {
  session(options: IdentityOptions, headers: Headers, selected: string | null, after: string | null): Promise<BrowserSessionSnapshot | null>;
  demo(options: IdentityOptions, workspaceId: string): Promise<WorkspaceSummary | null>;
}
const readers: BrowserSessionReaders = {
  session: readBrowserSession,
  async demo(options, workspaceId) {
    const identity = await openIdentity(options);
    try { return await identity.workspaceSummary(workspaceId); }
    finally { await identity.close(); }
  },
};
function refuse(): never { throw new Error('Browser session unavailable'); }
function uuid(value: string | null): string | null {
  if (value !== null && !UUID.test(value)) refuse();
  return value;
}
function identityOptions(env: WorkspaceEntryBindings, origin: string): IdentityOptions {
  const connectionString = env[PRODUCT_ENV.identityDatabase.name];
  const sessionSecret = env[PRODUCT_ENV.identitySecret.name];
  if (typeof connectionString !== 'string' || typeof sessionSecret !== 'string') refuse();
  return Object.freeze({ connectionString, sessionSecret, trustedOrigin: origin });
}

/** Read-only browser bootstrap. Profiles and readers belong to the server.
 * The returned identifiers select UI state; each subsequent action must still
 * pass its own current workspace admission. No active-org cookie is written. */
export async function handleBrowserSessionRequest(request: Request, env: WorkspaceEntryBindings,
  adapters: BrowserSessionReaders = readers): Promise<Response> {
  try {
    if (!(request instanceof Request) || request.method !== 'GET' || request.url.length > 8192) refuse();
    const url = new URL(request.url);
    if (url.pathname !== BROWSER_SESSION_PATH || url.hash || url.username || url.password) refuse();
    for (const [key] of url.searchParams) if (key !== 'after') refuse();
    if (url.searchParams.getAll('after').length > 1) refuse();
    const selected = uuid(request.headers.get(WORKSPACE_SELECTION_HEADER));
    const after = uuid(url.searchParams.get('after'));
    const mode = workspaceProfile(env);
    if (mode === 'standalone') {
      if (selected !== null || after !== null) refuse();
      return Response.json({ mode }, { headers: RESPONSE_HEADERS });
    }
    const origin = workspaceEntryOrigin(env);
    if (url.origin !== origin) refuse();
    const askedOrigin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if ((askedOrigin !== null && askedOrigin !== origin)
      || (site !== null && site !== 'same-origin')) refuse();
    const options = identityOptions(env, origin);
    if (mode === 'demo') {
      const fixed = env[PRODUCT_ENV.demoWorkspace.name];
      if (typeof fixed !== 'string' || !UUID.test(fixed) || after !== null
        || (selected !== null && selected !== fixed)) refuse();
      // Customer cookies are never passed to this fixed public fact reader.
      const workspace = await adapters.demo(options, fixed);
      if (workspace?.workspaceId !== fixed || workspace.status !== 'active') refuse();
      return Response.json({ mode, workspace: { workspaceId: fixed, displayName: workspace.displayName } },
        { headers: RESPONSE_HEADERS });
    }
    const snapshot = await adapters.session(options, new Headers(request.headers), selected, after);
    return Response.json({ mode, ...(snapshot ?? { session: null, workspaces: [], nextCursor: null, selectedWorkspace: null }) },
      { headers: RESPONSE_HEADERS });
  } catch {
    return Response.json({ error: 'browser_session_unavailable' }, { status: 403, headers: RESPONSE_HEADERS });
  }
}
