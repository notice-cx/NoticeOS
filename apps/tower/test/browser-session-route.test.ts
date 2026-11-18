// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleBrowserSessionRequest, handlePersonalProfileRequest, type BrowserSessionReaders } from '../worker/browser-session-route';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
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

it('distinguishes a refused profile, unavailable identity storage and invalid input', async () => {
  const read = vi.fn(async () => null);
  const profileRequest = (body?: unknown) => new Request(`${origin}/api/profile`, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { origin, [WORKSPACE_SESSION_HEADER]: session.sessionId, [WORKSPACE_SELECTION_HEADER]: workspaceId,
      'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const refusedProfile = await handlePersonalProfileRequest(profileRequest(), env(), read);
  expect(refusedProfile.status).toBe(403);
  expect(await refusedProfile.json()).toEqual({ error: 'profile_unavailable' });
  read.mockRejectedValueOnce(new Error('private connection detail'));
  const unavailable = await handlePersonalProfileRequest(profileRequest(), env(), read);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: 'profile_unavailable' });
  const tooLong = await handlePersonalProfileRequest(profileRequest({ displayName: 'A'.repeat(1024) }), env(), read);
  expect(tooLong.status).toBe(400);
  expect(await tooLong.json()).toEqual({ error: 'invalid_profile_request' });
  const invalidName = await handlePersonalProfileRequest(profileRequest({ displayName: ' ' }), env(), read);
  expect(invalidName.status).toBe(400);
  expect(await invalidName.json()).toEqual({ error: 'invalid_display_name' });
  expect(read).toHaveBeenCalledTimes(2);
});

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
  it('attaches backup preview status from the deployment only', async () => {
    const forged = request('', { 'x-noticeos-customer-shadow': 'true' });
    const ordinary = await handleBrowserSessionRequest(forged, env(), readers());
    expect(await ordinary.json()).toEqual({ mode: 'hosted', ...snapshot });
    const backup = await handleBrowserSessionRequest(request(), { ...env(), NOTICEOS_CUSTOMER_SHADOW: true }, readers());
    expect(await backup.json()).toEqual({ mode: 'hosted', ...snapshot, backupPreview: true });
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
