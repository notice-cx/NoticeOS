import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureBrowserLanding, createBrowserEntry, type BrowserEntry } from '@/lib/browser-entry';
import { decodeBrowserSession, tabSelectionKey } from '@/lib/browser-session';
import { createBrowserAuth } from '@/lib/browser-auth';
import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, emailEnrollmentUrl, parseEmailEnrollmentLanding } from '../../../scripts/identity-protocol.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import type { ApiTransport } from '@/lib/api';
import { settingsResponse } from './critical-response-fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SA = '33333333-3333-4333-8333-333333333333';
const SB = '44444444-4444-4444-8444-444444444444';
const WA = '55555555-5555-4555-8555-555555555555';
const WB = '66666666-6666-4666-8666-666666666666';
const workspace = (workspaceId = WA, role = 'owner', status = 'active') => ({ workspaceId, displayName: workspaceId === WA ? 'Workspace A' : 'Workspace B', role, status });
const snapshot = (selected: string | null = null, person = A, sessionId = SA, role = 'owner') => ({
  mode: 'hosted', session: { principalId: person, sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  workspaces: [workspace(WA, role), workspace(WB, role)], nextCursor: null,
  selectedWorkspace: selected === null ? null : workspace(selected, role),
});
const entries: BrowserEntry[] = [];
function entry(fetch: ApiTransport) {
  const value = createBrowserEntry({ origin: window.location.origin, page: window, fetch, landing: captureBrowserLanding(window) });
  entries.push(value); return value;
}
afterEach(() => {
  for (const value of entries.splice(0)) value.dispose();
  window.sessionStorage.clear(); window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('verified tab entry', () => {
  it('has no sole-workspace default and sends selected/session facts only after choice', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetch: ApiTransport = async (input, init) => {
      const url = String(input); const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url.endsWith('/api/settings')) return Response.json(settingsResponse({ own: 'A' }));
      const body = snapshot(headers.get(WORKSPACE_SELECTION_HEADER)); body.workspaces = [workspace()];
      return Response.json(body);
    };
    const value = entry(fetch);
    await value.refresh();
    expect(value.snapshot().phase).toBe('choose');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get(WORKSPACE_SELECTION_HEADER)).toBeNull();
    await value.choose(WA);
    const runtime = value.snapshot().runtime!;
    expect(runtime.owner.mode).toBe('hosted');
    await runtime.api.fetchSettings();
    expect(calls.at(-1)?.headers.get(WORKSPACE_SELECTION_HEADER)).toBe(WA);
    expect(calls.at(-1)?.headers.get(WORKSPACE_SESSION_HEADER)).toBe(SA);
  });
  it('revalidates saved selection after identifying the current session', async () => {
    const calls: Headers[] = [];
    window.sessionStorage.setItem(tabSelectionKey({ principalId: A, sessionId: SA }), WB);
    const value = entry(async (_input, init) => {
      const headers = new Headers(init?.headers); calls.push(headers);
      return Response.json(snapshot(headers.get(WORKSPACE_SELECTION_HEADER)));
    });
    await value.refresh();
    expect(calls.map(headers => headers.get(WORKSPACE_SELECTION_HEADER))).toEqual([null, WB]);
    expect(value.snapshot().runtime?.owner).toMatchObject({ workspaceId: WB });
  });
  it('does not import a predecessor person or session selection', async () => {
    window.sessionStorage.setItem(tabSelectionKey({ principalId: A, sessionId: SA }), WA);
    const value = entry(async (_input, init) => Response.json(snapshot(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER), B, SB)));
    await value.refresh();
    expect(value.snapshot().phase).toBe('choose');
    expect(value.snapshot().runtime).toBeNull();
  });
  it('retirement refuses old reads and queued answers before a successor is selected', async () => {
    const send = vi.fn(async () => {});
    const value = entry(async (_input, init) => Response.json(snapshot(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER))));
    await value.refresh(); await value.choose(WA);
    const old = value.snapshot().runtime!;
    old.answers.schedule({ id: 'same-id', answer: send, delayMs: 20_000 });
    value.switchWorkspace();
    await expect(old.api.fetchSettings()).rejects.toThrow('no longer active');
    expect(old.answers.undo('same-id')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('suppresses a slow predecessor bootstrap completion', async () => {
    let release!: (response: Response) => void;
    let calls = 0;
    const value = entry(async () => ++calls === 1 ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(snapshot(null, B, SB)));
    const first = value.refresh();
    await value.refresh();
    release(Response.json(snapshot(WA)));
    await first;
    expect(value.snapshot().phase).toBe('choose');
    expect(value.snapshot().session).toMatchObject({ session: { principalId: B, sessionId: SB } });
  });
  it('replaces runtime/cache on fresh role observations even with the same identifiers', async () => {
    let role = 'owner';
    const value = entry(async (_input, init) => Response.json(snapshot(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER), A, SA, role)));
    await value.refresh(); await value.choose(WA);
    const old = value.snapshot().runtime!;
    old.queries.setQueryData(['settings'], 'old');
    role = 'viewer'; await value.refresh();
    const next = value.snapshot().runtime!;
    expect(next.ownerKey).not.toBe(old.ownerKey);
    expect(next.queries.getQueryData(['settings'])).toBeUndefined();
    expect(next.guard(() => true)()).toBe(true);
    expect(old.guard(() => true)()).toBeUndefined();
  });
  it('keeps verified zero memberships distinct from sign-out and inactive choices disabled', async () => {
    let body = { ...snapshot(), workspaces: [] as ReturnType<typeof workspace>[] };
    const value = entry(async () => Response.json(body));
    await value.refresh(); expect(value.snapshot().phase).toBe('choose'); expect(value.snapshot().choices).toEqual([]);
    body = { ...snapshot(), workspaces: [workspace(WA, 'owner', 'suspended')] };
    await value.refresh(); await value.choose(WA);
    expect(value.snapshot().runtime).toBeNull();
    expect(value.snapshot().phase).toBe('choose');
  });
  it('loads the next page without treating the cursor as selected authority', async () => {
    const calls: Headers[] = [];
    const value = entry(async (input, init) => {
      const headers = new Headers(init?.headers); calls.push(headers);
      const next = String(input).includes('?after=');
      return Response.json({ ...snapshot(headers.get(WORKSPACE_SELECTION_HEADER)), workspaces: [workspace(next ? WB : WA)], nextCursor: next ? null : WA });
    });
    await value.refresh(); await value.loadMore();
    expect(value.snapshot().choices.map(item => item.workspaceId)).toEqual([WA, WB]);
    expect(calls.every(headers => headers.get(WORKSPACE_SELECTION_HEADER) === null)).toBe(true);
    await value.choose(WB);
    expect(value.snapshot().runtime?.owner).toMatchObject({ workspaceId: WB });
  });
  it('refuses malformed bootstrap and failed saved selection without another workspace fallback', async () => {
    window.sessionStorage.setItem(tabSelectionKey({ principalId: A, sessionId: SA }), WA);
    const value = entry(async (_input, init) => new Headers(init?.headers).has(WORKSPACE_SELECTION_HEADER) ? new Response('', { status: 403 }) : Response.json(snapshot()));
    await value.refresh();
    expect(value.snapshot().phase).toBe('unavailable'); expect(value.snapshot().runtime).toBeNull();
    expect(window.sessionStorage.getItem(tabSelectionKey({ principalId: A, sessionId: SA }))).toBeNull();
    await value.refresh(); expect(value.snapshot().phase).toBe('choose');
    for (const body of [{ mode: 'hosted' }, { ...snapshot(), workspaces: [workspace(), workspace()] }, { ...snapshot(WA), selectedWorkspace: workspace(WA, 'owner', 'suspended') }]) {
      expect(() => decodeBrowserSession(body)).toThrow('invalid response');
    }
  });
  it('pagehide immediately retires and pageshow creates a fresh verified lifetime', async () => {
    const value = entry(async () => Response.json({ mode: 'standalone' }));
    await value.refresh(); const old = value.snapshot().runtime!;
    window.dispatchEvent(new Event('pagehide'));
    expect(value.snapshot().runtime).toBeNull(); expect(old.guard(() => true)()).toBeUndefined();
    window.dispatchEvent(new Event('pageshow'));
    await vi.waitFor(() => expect(value.snapshot().phase).toBe('ready'));
    expect(value.snapshot().runtime?.ownerKey).not.toBe(old.ownerKey);
  });
});

describe('identity protocol entry', () => {
  it('enrollment links carry only one canonical selector and capture/remove it before networking', async () => {
    const origin = window.location.origin;
    const url = emailEnrollmentUrl(origin, { kind: 'invitation', id: WA });
    expect(parseEmailEnrollmentLanding(url)).toMatchObject({ kind: 'enrollment', enrollment: { kind: 'invitation', id: WA } });
    for (const suffix of [`#invitation=${WA}&platform=${WB}`, '#invitation=bad', `?email=person@example.com#invitation=${WA}`]) {
      expect(parseEmailEnrollmentLanding(`${origin}/sign-in${suffix}`)).toEqual({ kind: 'invalid' });
    }
    window.history.replaceState(null, '', url);
    const fetch = vi.fn<ApiTransport>(async () => {
      expect(window.location.hash).toBe('');
      return Response.json(snapshot());
    });
    const value = entry(fetch); await value.refresh();
    expect(value.enrollment).toEqual({ kind: 'invitation', id: WA });
    expect(value.snapshot().phase).toBe('invitation');
  });
  it('invalid enrollment does not silently become ordinary login', async () => {
    window.history.replaceState(null, '', '/sign-in#invitation=bad');
    const fetch = vi.fn<ApiTransport>(); const value = entry(fetch);
    await value.refresh(); expect(value.snapshot().phase).toBe('invalid-link'); expect(fetch).not.toHaveBeenCalled();
  });
  it('joins only after explicit intent using a fresh session and never chooses a workspace', async () => {
    window.history.replaceState(null, '', emailEnrollmentUrl(window.location.origin, { kind: 'invitation', id: WB }));
    window.sessionStorage.setItem(tabSelectionKey({ principalId: A, sessionId: SA }), WA);
    const calls: { path: string; headers: Headers; body?: BodyInit | null }[] = [];
    const value = entry(async (input, init) => {
      calls.push({ path: String(input), headers: new Headers(init?.headers), body: init?.body });
      return String(input) === ACCEPT_INVITATION_PATH ? new Response(null, { status: 200 }) : Response.json(snapshot());
    });
    await value.refresh(); expect(value.snapshot().phase).toBe('invitation');
    expect(calls).toHaveLength(1);
    await value.joinInvitation();
    const accept = calls.find(call => call.path === ACCEPT_INVITATION_PATH)!;
    expect(accept.headers.get(WORKSPACE_SESSION_HEADER)).toBe(SA);
    expect(accept.headers.has(WORKSPACE_SELECTION_HEADER)).toBe(false);
    expect(accept.headers.has(EMAIL_ENROLLMENT_HEADERS.id)).toBe(false);
    expect(JSON.parse(String(accept.body))).toEqual({ invitationId: WB });
    expect(value.snapshot().phase).toBe('choose'); expect(value.snapshot().runtime).toBeNull();
    expect(window.location.pathname).toBe('/'); expect(value.enrollment).toBeUndefined();
  });
  it('session replacement or failed acceptance cannot silently join under another person', async () => {
    window.history.replaceState(null, '', emailEnrollmentUrl(window.location.origin, { kind: 'invitation', id: WB }));
    let changed = false; let accepts = 0;
    const value = entry(async input => {
      if (String(input) === ACCEPT_INVITATION_PATH) { accepts++; return new Response(null, { status: 403 }); }
      return Response.json(snapshot(null, changed ? B : A, changed ? SB : SA));
    });
    await value.refresh(); changed = true; await value.joinInvitation();
    expect(accepts).toBe(0); expect(value.snapshot().phase).toBe('invitation');
    await value.joinInvitation();
    expect(accepts).toBe(1); expect(value.snapshot().label).toBe('Invitation could not be accepted.');
    expect(value.snapshot().runtime).toBeNull(); expect(value.enrollment?.kind).toBe('invitation');
  });
  it('platform verification never calls invitation acceptance and non-hosted enrollment refuses', async () => {
    window.history.replaceState(null, '', emailEnrollmentUrl(window.location.origin, { kind: 'platform', id: WB }));
    const fetch = vi.fn<ApiTransport>(async () => Response.json(snapshot()));
    const value = entry(fetch); await value.refresh(); await value.signedIn();
    expect(value.snapshot().phase).toBe('choose');
    expect(fetch.mock.calls.some(([path]) => String(path) === ACCEPT_INVITATION_PATH)).toBe(false);
    window.history.replaceState(null, '', emailEnrollmentUrl(window.location.origin, { kind: 'invitation', id: WB }));
    const local = entry(async () => Response.json({ mode: 'standalone' }));
    await local.refresh(); expect(local.snapshot().phase).toBe('invalid-link');
  });
  it('request/verify use the same enrollment and no workspace/session selection; logout is session-bound', async () => {
    const calls: { input: string; init: RequestInit }[] = [];
    const auth = createBrowserAuth(async (input, init) => { calls.push({ input: String(input), init: init ?? {} }); return new Response(null, { status: 200 }); });
    const enrollment = { kind: 'platform' as const, id: WA };
    await auth.request('person@example.com', { enrollment });
    await auth.verify('person@example.com', '123456', { enrollment });
    await auth.logout(SA);
    expect(calls.map(call => call.input)).toEqual([EMAIL_CODE_PATHS.request, EMAIL_CODE_PATHS.verify, EMAIL_CODE_PATHS.logout]);
    for (const call of calls.slice(0, 2)) {
      const headers = new Headers(call.init.headers);
      expect(headers.get(EMAIL_ENROLLMENT_HEADERS.kind)).toBe('platform');
      expect(headers.get(EMAIL_ENROLLMENT_HEADERS.id)).toBe(WA);
      expect(headers.has(WORKSPACE_SELECTION_HEADER)).toBe(false); expect(headers.has(WORKSPACE_SESSION_HEADER)).toBe(false);
    }
    const logout = new Headers(calls[2]?.init.headers);
    expect(logout.get(WORKSPACE_SESSION_HEADER)).toBe(SA); expect(logout.has(EMAIL_ENROLLMENT_HEADERS.id)).toBe(false);
  });
});
