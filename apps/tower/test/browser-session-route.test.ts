// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleBrowserSessionRequest, type BrowserSessionReaders } from '../worker/browser-session-route';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { WORKSPACE_SELECTION_HEADER, type WorkspaceEntryBindings } from '../../../scripts/workspace-entry.mjs';

const origin = 'https://fixture.example.test';
const workspaceId = '00000000-0000-4000-8000-000000000001';
const foreign = '00000000-0000-4000-8000-000000000002';
const session = { principalId: '00000000-0000-4000-8000-000000000003',
  sessionId: '00000000-0000-4000-8000-000000000004', expiresAt: '2099-01-01T00:00:00.000Z' };
const workspace = { workspaceId, displayName: 'Fixture workspace', status: 'active' as const, role: 'viewer' as const };
const snapshot = { session, workspaces: [workspace], nextCursor: null, selectedWorkspace: null };
const env = (mode = 'hosted'): WorkspaceEntryBindings => ({
  [PRODUCT_ENV.workspaceProfile.name]: mode,
  [PRODUCT_ENV.workspaceOrigin.name]: origin,
  [PRODUCT_ENV.identityDatabase.name]: 'postgresql://noticeos_identity@127.0.0.1:1/not_contacted',
  [PRODUCT_ENV.identitySecret.name]: 'fixture-session-secret-with-more-than-thirty-two-characters',
  [PRODUCT_ENV.demoWorkspace.name]: workspaceId,
});
function readers(): BrowserSessionReaders {
  return { session: vi.fn(async () => snapshot), demo: vi.fn(async () => workspace) };
}
const request = (suffix = '', headers: HeadersInit = {}, method = 'GET') =>
  new Request(`${origin}/api/session${suffix}`, { method, headers });
async function refused(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'browser_session_unavailable' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.has('set-cookie')).toBe(false);
}

describe('fixed browser session bootstrap', () => {
  it('standalone returns only its explicit mode without calling either identity reader', async () => {
    const adapters = readers();
    const response = await handleBrowserSessionRequest(request('', { cookie: 'ignored', origin: 'https://unrelated.example.test' }), env('standalone'), adapters);
    expect(await response.json()).toEqual({ mode: 'standalone' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(adapters.session).not.toHaveBeenCalled(); expect(adapters.demo).not.toHaveBeenCalled();
    for (const input of [request('', { [WORKSPACE_SELECTION_HEADER]: workspaceId }), request(`?after=${workspaceId}`)]) {
      await refused(await handleBrowserSessionRequest(input, env('standalone'), adapters));
    }
  });
  it('forwards explicit selection and cursor as facts, never selects the sole workspace', async () => {
    const adapters = readers();
    const response = await handleBrowserSessionRequest(request(), env(), adapters);
    expect(await response.json()).toEqual({ mode: 'hosted', ...snapshot });
    expect(adapters.session).toHaveBeenLastCalledWith(expect.any(Object), expect.any(Headers), null, null);
    await handleBrowserSessionRequest(request(`?after=${foreign}`, { [WORKSPACE_SELECTION_HEADER]: workspaceId, cookie: 'captured-cookie' }), env(), adapters);
    expect(adapters.session).toHaveBeenLastCalledWith(expect.objectContaining({ trustedOrigin: origin }), expect.any(Headers), workspaceId, foreign);
    const proof = vi.mocked(adapters.session).mock.calls.at(-1)![1];
    expect(proof.get('cookie')).toBe('captured-cookie');
    expect(adapters.demo).not.toHaveBeenCalled();
  });
  it('returns an honest signed-out snapshot and generic secret-free reader failure', async () => {
    const adapters = readers(); vi.mocked(adapters.session).mockResolvedValueOnce(null);
    const response = await handleBrowserSessionRequest(request(), env(), adapters);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'hosted', session: null, workspaces: [], nextCursor: null, selectedWorkspace: null });
    expect(response.headers.has('set-cookie')).toBe(false);
    vi.mocked(adapters.session).mockRejectedValueOnce(new Error('private connection secret'));
    await refused(await handleBrowserSessionRequest(request(), env(), adapters));
  });
  it('refuses wrong profile, target, origin, metadata, method and parameter grammar before readers', async () => {
    const adapters = readers();
    for (const input of [request('?other=1'), request(`?after=${workspaceId}&after=${workspaceId}`), request('?after=no'),
      request('', { [WORKSPACE_SELECTION_HEADER]: 'bad' }), request('', { origin: 'null' }),
      request('', { origin: 'https://foreign.example.test' }), request('', { 'sec-fetch-site': 'cross-site' }),
      request('', {}, 'POST'), new Request(`${origin}/api/session/extra`), new Request('https://foreign.example.test/api/session'),
      new Request(`${origin}/api/session#fragment`)]) {
      await refused(await handleBrowserSessionRequest(input, env(), adapters));
    }
    for (const bindings of [env('unknown'), { ...env(), [PRODUCT_ENV.workspaceOrigin.name]: '*' },
      { ...env(), [PRODUCT_ENV.identitySecret.name]: undefined }]) {
      await refused(await handleBrowserSessionRequest(request(), bindings, adapters));
    }
    expect(adapters.session).not.toHaveBeenCalled(); expect(adapters.demo).not.toHaveBeenCalled();
  });
  it('fixed demo ignores the customer cookie and refuses conflicting selectors or inactive state', async () => {
    const adapters = readers();
    const response = await handleBrowserSessionRequest(request('', { cookie: 'customer-cookie' }), env('demo'), adapters);
    expect(await response.json()).toEqual({ mode: 'demo', workspace: { workspaceId, displayName: workspace.displayName } });
    expect(adapters.demo).toHaveBeenCalledExactlyOnceWith(expect.any(Object), workspaceId);
    expect(adapters.session).not.toHaveBeenCalled();
    for (const input of [request('', { [WORKSPACE_SELECTION_HEADER]: foreign }), request(`?after=${workspaceId}`)]) {
      await refused(await handleBrowserSessionRequest(input, env('demo'), adapters));
    }
    expect(adapters.demo).toHaveBeenCalledTimes(1);
    vi.mocked(adapters.demo).mockResolvedValueOnce({ ...workspace, status: 'suspended' });
    await refused(await handleBrowserSessionRequest(request(), env('demo'), adapters));
    vi.mocked(adapters.demo).mockResolvedValueOnce({ ...workspace, workspaceId: foreign });
    await refused(await handleBrowserSessionRequest(request(), env('demo'), adapters));
  });
});
