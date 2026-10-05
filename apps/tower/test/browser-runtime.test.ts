import { createWorkspaceAdmission } from '../../../scripts/workspace-admission.mjs';
import { WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserRuntime, BrowserRetiredError } from '@/lib/browser-runtime';
import { createApi, ApiError, renameAsset, fetchWall } from '@/lib/api';
import { readStored } from '@/lib/browser-storage';
import { createAnswerQueue } from '@/lib/answer-queue';
import { settingsResponse, wallMoneyResponse, assetMoneyResponse } from './critical-response-fixtures';

const A = { mode: 'hosted', principalId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222', workspaceId: '33333333-3333-4333-8333-333333333333', clientGeneration: 1 };
const B = { ...A, workspaceId: '44444444-4444-4444-8444-444444444444' };
const origin = 'https://desk.example';
const project = { projectId: '66666666-6666-4666-8666-666666666666', logicalKey: 'tasks', displayName: 'Tasks', prefix: 'ex' };
const isCatalog = (input: RequestInfo | URL) => new URL(String(input), origin).pathname === '/api/tasks/projects';
const catalogResponse = () => Response.json({ projects: [project] });
const retired: Array<() => void> = [];
function runtime(owner: unknown = A, fetch: typeof globalThis.fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({})), page?: Window) {
  const result = createBrowserRuntime<string>(owner, { origin, fetch, storage: localStorage, page,
    sendAnswer: (api, answer, keepalive) => api.respondToTask('task-id', answer, { keepalive, project: project.logicalKey }) });
  retired.push(result.retire);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { for (const retire of retired.splice(0)) retire(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('an explicit browser lifetime', () => {
  it('refuses malformed ownership and origin before any transport call', () => {
    const fetch = vi.fn();
    for (const identity of [null, { ...A, role: 'owner' }, { ...A, sessionId: 'secret' }]) expect(() => runtime(identity, fetch)).toThrow('Browser owner is invalid.');
    for (const bad of ['https://desk.example/', 'https://desk.example/path', 'https://user:pass@desk.example', 'file:///desk', '*']) {
      expect(() => createBrowserRuntime(A, { origin: bad, fetch, sendAnswer: async () => {} })).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures the selected UUID and exposes no caller-selected transport, even for forged options or external asset text', async () => {
    const facts = { ...A };
    const transport = vi.fn<typeof globalThis.fetch>(async input => isCatalog(input) ? catalogResponse()
      : Response.json(String(input).endsWith('/api/settings') ? settingsResponse()
        : assetMoneyResponse(decodeURIComponent(new URL(String(input)).pathname.slice('/api/assets/'.length)))));
    const a = runtime(facts, transport);
    facts.workspaceId = B.workspaceId;
    await a.api.fetchSettings();
    expect(String(transport.mock.calls[0]?.[0])).toBe(`${origin}/api/settings`);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('x-noticeos-workspace-id')).toBe(A.workspaceId);
    expect(Object.isFrozen(a.owner)).toBe(true);
    expect('fetch' in a).toBe(false);
    const forged = { keepalive: true, project: project.logicalKey, workspaceId: B.workspaceId, headers: { 'X-NoticeOS-Workspace-ID': B.workspaceId } };
    await a.api.respondToTask('task-id', 'answer', forged);
    await a.api.fetchAssetDetail('https://foreign.example/api/settings');
    for (const [input, init] of transport.mock.calls) {
      expect(new URL(String(input)).origin).toBe(origin);
      expect(new Headers(init?.headers).get('x-noticeos-workspace-id')).toBe(A.workspaceId);
    }
    expect(String(transport.mock.calls.at(-1)?.[0])).toBe(`${origin}/api/assets/https%3A%2F%2Fforeign.example%2Fapi%2Fsettings`);
  });

  it('keeps colliding query keys, preferences and pending answer IDs separate across two tabs', async () => {
    const fetchA = vi.fn<typeof globalThis.fetch>(async () => Response.json(settingsResponse({ result: 'a' })));
    const fetchB = vi.fn<typeof globalThis.fetch>(async () => Response.json(settingsResponse({ result: 'b' })));
    const a = runtime(A, fetchA);
    const b = runtime(B, fetchB);
    await a.queries.fetchQuery({ queryKey: ['settings'], queryFn: () => a.api.fetchSettings() });
    await b.queries.fetchQuery({ queryKey: ['settings'], queryFn: () => b.api.fetchSettings() });
    expect(a.queries.getQueryData(['settings'])).toEqual(settingsResponse({ result: 'a' }));
    expect(b.queries.getQueryData(['settings'])).toEqual(settingsResponse({ result: 'b' }));
    a.preferences.write('nav|["workspace"]', 'a');
    b.preferences.write('nav|["workspace"]', 'b');
    b.preferences.forget('nav|["workspace"]');
    expect(a.preferences.read('nav|["workspace"]')).toBe('a');
    expect(b.preferences.read('nav|["workspace"]')).toBeNull();
    a.answers.schedule({ id: 'same-id', answer: 'a' });
    expect(b.answers.undo('same-id')).toBe(false);
    expect(b.answers.hides('same-id', null)).toBe(false);
    a.retire();
    expect(a.queries.getQueryCache().getAll()).toHaveLength(0);
    expect(b.queries.getQueryData(['settings'])).toEqual(settingsResponse({ result: 'b' }));
    expect(fetchA).toHaveBeenCalledTimes(1);
  });

  it('preserves API write bodies/options and caller cancellation on the fixed same-origin transport', async () => {
    let receivedInit: RequestInit | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (isCatalog(input)) return catalogResponse();
      receivedInit = init;
      return Response.json(String(input).endsWith('/api/settings') ? settingsResponse() : {});
    });
    const a = runtime(A, fetch);
    const abort = new AbortController();
    await a.api.respondToTask('task-id', 'answer', { keepalive: true, project: project.logicalKey });
    expect(receivedInit?.method).toBe('POST');
    expect(JSON.parse(String(receivedInit?.body))).toEqual({ response: 'answer', projectId: project.projectId });
    expect(receivedInit?.keepalive).toBe(true);
    expect(new Headers(receivedInit?.headers).get('content-type')).toBe('application/json');
    expect(receivedInit?.credentials).toBe('same-origin');
    expect(receivedInit?.mode).toBe('same-origin');
    await a.api.fetchSettings(abort.signal);
    abort.abort();
    expect(receivedInit?.signal?.aborted).toBe(true);
  });

  it('never imports standalone or legacy preferences into hosted/demo ownership, while device theme still migrates', () => {
    localStorage.setItem('reindex-os:theme', 'light');
    localStorage.setItem('reindex-os:nav-assets', 'private legacy names');
    localStorage.setItem('noticeos:nav-assets', 'private standalone names');
    const a = runtime();
    const demo = runtime({ mode: 'demo', workspaceId: A.workspaceId, clientGeneration: 1 });
    expect(a.preferences.read('nav-assets')).toBeNull();
    expect(demo.preferences.read('nav-assets')).toBeNull();
    a.preferences.forget('nav-assets');
    expect(localStorage.getItem('noticeos:nav-assets')).toBe('private standalone names');
    expect(readStored(localStorage, 'theme')).toBe('light');
    expect(localStorage.getItem('noticeos:theme')).toBe('light');
  });

  it('session or permission refresh receives a fresh instance/generation, not old cache or drafts', () => {
    const a = runtime(A);
    a.queries.setQueryData(['role'], { writable: true });
    a.preferences.write('draft', 'old');
    const refreshed = runtime({ ...A, clientGeneration: 2 });
    const session = runtime({ ...A, sessionId: B.workspaceId });
    expect(refreshed.ownerKey).not.toBe(a.ownerKey);
    expect(session.ownerKey).not.toBe(a.ownerKey);
    expect(refreshed.queries.getQueryData(['role'])).toBeUndefined();
    expect(refreshed.preferences.read('draft')).toBeNull();
  });

  it('a successor on the same page immediately cancels unissued work, clears predecessor cache and releases listeners', async () => {
    vi.useFakeTimers();
    const fetchA = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const a = runtime(A, fetchA, window);
    a.answers.schedule({ id: 'same-id', answer: 'old' });
    a.queries.setQueryData(['settings'], 'old');
    const b = runtime(B, undefined, window);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchA).not.toHaveBeenCalled();
    expect(a.queries.getQueryCache().getAll()).toHaveLength(0);
    expect(() => a.preferences.write('draft', 'old')).toThrow(BrowserRetiredError);
    expect(() => a.answers.schedule({ id: 'old', answer: 'old' })).toThrow();
    const remove = vi.spyOn(window, 'removeEventListener');
    b.retire();
    expect(remove).toHaveBeenCalledWith('pagehide', b.retire);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pagehide retires unissued actions and reads without dispatching to a later page', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const a = runtime(A, fetch, window);
    a.answers.schedule({ id: 'same-id', answer: 'old' });
    window.dispatchEvent(new Event('pagehide'));
    expect(a.answers.undo('same-id')).toBe(false);
    await expect(a.api.fetchSettings()).rejects.toBeInstanceOf(BrowserRetiredError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('acquires the existing page queue and preserves keyboard Undo in its own lifetime', () => {
    const oldSend = vi.fn(async () => {});
    const old = createAnswerQueue({ mode: 'standalone', clientGeneration: 0 }, oldSend, window);
    retired.push(old.retire);
    old.schedule({ id: 'old', answer: 'old' });
    const a = runtime(A, undefined, window);
    expect(old.undo('old')).toBe(false);
    expect(oldSend).not.toHaveBeenCalled();
    const onUndo = vi.fn();
    a.answers.schedule({ id: 'current', answer: 'current', onUndo });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(a.answers.hides('current', null)).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('suppresses late %s and optimistic rollback/completion after retirement', async (kind) => {
    const pending = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const a = runtime(A, vi.fn((_input, init) => { signal = init?.signal; return pending.promise; }));
    const completed = vi.fn();
    const rollback = vi.fn();
    const answer = a.api.renameAsset('example.com', 'New name', 'Old name').then(a.guard(completed), a.guard(rollback));
    a.retire();
    expect(signal?.aborted).toBe(true);
    const b = runtime(B);
    b.queries.setQueryData(['asset', 'example.com'], 'successor');
    if (kind === 'resolve') pending.resolve(Response.json({})); else pending.reject(new Error('predecessor error details'));
    await answer;
    expect(completed).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(b.queries.getQueryData(['asset', 'example.com'])).toBe('successor');
  });

  it.each(['resolve', 'reject'] as const)('rejects late body %s even when the endpoint catches transport errors', async (kind) => {
    const body = deferred<unknown>();
    const decoding = deferred<void>();
    const response = new Response();
    const json = vi.spyOn(response, 'json').mockImplementation(() => { decoding.resolve(); return body.promise; });
    const a = runtime(A, vi.fn(async () => response));
    const result = a.api.fetchSiteName('example.com');
    const rejected = expect(result).rejects.toBeInstanceOf(BrowserRetiredError);
    await decoding.promise;
    expect(json).toHaveBeenCalledOnce();
    a.retire();
    if (kind === 'resolve') body.resolve({ name: 'Predecessor site' });
    else body.reject(new Error('Predecessor body details'));
    await rejected;
  });

  it('guarded callbacks retain their awaited result while active and do nothing after retirement', async () => {
    const a = runtime();
    const callback = vi.fn(async (value: string) => value);
    const guarded = a.guard(callback);
    await expect(guarded('current')).resolves.toBe('current');
    a.retire();
    expect(guarded('predecessor')).toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels an outstanding query and cannot refill either cache with its late decoded value', async () => {
    const body = deferred<unknown>();
    const response = new Response();
    vi.spyOn(response, 'json').mockImplementation(() => body.promise);
    const a = runtime(A, vi.fn(async () => response));
    const pending = a.queries.fetchQuery({ queryKey: ['settings'], queryFn: () => a.api.fetchSettings() });
    // Observe rejection before retirement, so cancellation never escapes the test.
    const settled = pending.catch(() => undefined);
    await Promise.resolve();
    a.retire();
    const b = runtime(B);
    b.queries.setQueryData(['settings'], 'new owner');
    body.resolve({ oldOwner: true });
    await settled;
    expect(a.queries.getQueryCache().getAll()).toHaveLength(0);
    expect(b.queries.getQueryData(['settings'])).toBe('new owner');
  });

  it('issued answers retain original request ownership, cannot Undo, and suppress late callbacks', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>((input, _init) => isCatalog(input) ? Promise.resolve(catalogResponse()) : pending.promise);
    const a = runtime(A, fetch);
    const onSent = vi.fn();
    a.answers.schedule({ id: 'same-id', answer: 'original answer', onSent });
    a.answers.flush(true);
    expect(a.answers.undo('same-id')).toBe(false);
    expect(a.answers.hides('same-id', null)).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${origin}/api/tasks/projects`);
    const issued = fetch.mock.calls[1];
    expect(String(issued?.[0])).toBe(`${origin}/api/tasks/task-id/respond`);
    expect(JSON.parse(String(issued?.[1]?.body))).toEqual({ response: 'original answer', projectId: project.projectId });
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get('x-noticeos-workspace-id')).toBe(A.workspaceId);
      expect(new Headers(init?.headers).get(WORKSPACE_SESSION_HEADER)).toBe(A.sessionId);
    }
    expect(issued?.[1]?.keepalive).toBe(true);
    a.retire();
    const b = runtime(B);
    expect(b.answers.undo('same-id')).toBe(false);
    pending.resolve(Response.json({}));
    await Promise.resolve(); await Promise.resolve();
    expect(onSent).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('an old queued answer cannot execute as a successor cookie session in the same workspace', async () => {
    const successor = { ...A, principalId: B.workspaceId, sessionId: '55555555-5555-4555-8555-555555555555' };
    let effects = 0;
    const gate = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: async () => ({ principalId: successor.principalId, sessionId: successor.sessionId, workspaceId: successor.workspaceId, role: 'owner', workspaceStatus: 'active', expiresAt: new Date(Date.now() + 60000).toISOString() }) });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (isCatalog(input)) return catalogResponse();
      const request = new Request(String(input), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin } });
      try { await gate.withAdmission('tasks.write', { requestedWorkspaceId: A.workspaceId, correlationId: 'queued-answer' }, request,
        async context => { expect(context.principalId).toBe(successor.principalId); effects++; }); }
      catch { return Response.json({ error: 'refused' }, { status: 403 }); }
      return Response.json({});
    });
    const a = runtime(A, fetch), failed = vi.fn(), sent = vi.fn();
    a.answers.schedule({ id: 'same-id', answer: 'old answer', onSent: sent, onFailed: failed }); a.answers.flush();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(effects).toBe(0); expect(sent).not.toHaveBeenCalled();
    const refused = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(new Headers(refused?.[1]?.headers).get(WORKSPACE_SESSION_HEADER)).toBe(A.sessionId);
    expect(JSON.parse(String(refused?.[1]?.body))).toEqual({ response: 'old answer', projectId: project.projectId });
    a.retire();
    const b = runtime(successor, fetch);
    await b.api.respondToTask('task-id', 'new answer', { project: project.logicalKey }); expect(effects).toBe(1);
    const issued = fetch.mock.calls.at(-1);
    expect(new Headers(issued?.[1]?.headers).get(WORKSPACE_SESSION_HEADER)).toBe(successor.sessionId);
    expect(JSON.parse(String(issued?.[1]?.body))).toEqual({ response: 'new answer', projectId: project.projectId });
    for (const owner of [{ mode: 'standalone', clientGeneration: 1 }, { mode: 'demo', workspaceId: A.workspaceId, clientGeneration: 1 }]) {
      const unbound = vi.fn<typeof globalThis.fetch>(async () => Response.json(wallMoneyResponse()));
      await runtime(owner, unbound).api.fetchWall();
      expect(new Headers(unbound.mock.calls[0]?.[1]?.headers).get(WORKSPACE_SESSION_HEADER)).toBeNull();
    }
  });

  it('pins a demo visit prefix without consulting the current window or successor visit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const a = createBrowserRuntime({ mode: 'demo', workspaceId: A.workspaceId, clientGeneration: 1 },
      { origin, fetch, apiBase: `/visit/${'a'.repeat(32)}/api/`, sendAnswer: async () => {} });
    retired.push(a.retire);
    await a.api.fetchWorkflows('run/id');
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${origin}/visit/${'a'.repeat(32)}/api/workflows?run=run%2Fid`);
    expect(() => createBrowserRuntime(A, { origin, fetch, apiBase: `/visit/${'a'.repeat(32)}/api/`, sendAnswer: async () => {} })).toThrow('Browser API base is invalid.');
  });
});

describe('one API implementation', () => {
  it('nested config calls use their captured transport and retain error constructor identity', async () => {
    const a = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: 'refused' }, { status: 403 }));
    const b = vi.fn<typeof globalThis.fetch>(async () => Response.json({ applied: 0, archive: null, commit: null }));
    const apiA = createApi(a); const apiB = createApi(b);
    await expect(apiA.renameAsset('example.com', 'New', 'Old')).rejects.toBeInstanceOf(ApiError);
    await apiB.createAssetConfig([], 'example');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(String(b.mock.calls[0]?.[0])).toBe('/api/config');
  });

  it('named standalone functions keep the original path, body and unselected request behavior', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(wallMoneyResponse({ standalone: true })));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchWall()).resolves.toEqual(wallMoneyResponse({ standalone: true }));
    await renameAsset('example.com', 'New', 'Old');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/wall');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/assets/example.com');
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('x-noticeos-workspace-id')).toBeNull();
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ column: 'display_name', value: 'New', expect: 'Old' });
  });
});
