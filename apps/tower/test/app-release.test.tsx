import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen } from './render';
import { APP_RELEASE_HEADER, withAppRelease } from '../shared/app-release';
import { createAppRelease, AppReleaseError } from '@/lib/app-release';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { createBrowserEntry } from '@/lib/browser-entry';
import { AppUpdateNotice } from '@/BrowserEntry';
import { tabSelectionKey } from '@/lib/browser-session';
import { WORKSPACE_SELECTION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { BrowserRuntimeProvider, useOwnerPreferences } from '@/lib/browser-context';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const origin = 'https://desk.example';
const owned: Array<() => void> = [];
const response = (release: string | null, body: unknown = {}) => Response.json(body,
  { headers: release === null ? {} : { [APP_RELEASE_HEADER]: release } });
afterEach(() => { for (const close of owned.splice(0)) close(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
const principalId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';
const workspace = { workspaceId, displayName: 'Workspace', role: 'owner', status: 'active' };
const facts = (selected: string | null = null, cursor: string | null = null) => ({ mode: 'hosted',
  session: { principalId, sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  workspaces: [workspace], selectedWorkspace: selected ? workspace : null, nextCursor: cursor });
function Draft() {
  const [value, setValue] = useState('synthetic-unsaved');
  const preferences = useOwnerPreferences();
  return <><span data-owned-preference>{preferences.read('columns') ?? 'none'}</span>
    <input aria-label="Owned draft" value={value} onChange={event => setValue(event.target.value)} /></>;
}
function OwnedView({ entry }: { entry: ReturnType<typeof createBrowserEntry> }) {
  const state = useSyncExternalStore(entry.subscribe, entry.snapshot);
  return <><AppUpdateNotice release={entry.appRelease} />{state.runtime ?
    <BrowserRuntimeProvider key={state.runtime.ownerKey} value={{ runtime: state.runtime, workspaceLabel: null }}><Draft /></BrowserRuntimeProvider> : null}</>;
}

describe('server-owned app compatibility', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('refuses a changed %s before any route effect', async (method) => {
    const route = vi.fn(async () => response('caller-value'));
    const reply = await withAppRelease(new Request(`${origin}/api/ga4/realtime`, {
      method, headers: { [APP_RELEASE_HEADER]: A },
    }), route, B);
    expect(reply.status).toBe(409);
    expect(reply.headers.get(APP_RELEASE_HEADER)).toBe(B);
    expect(route).not.toHaveBeenCalled();
  });

  it.each([A, null])('allows compatible or headerless clients without granting route authority: %s', async (client) => {
    const route = vi.fn(async () => new Response('denied', { status: 403, headers: { [APP_RELEASE_HEADER]: B } }));
    const reply = await withAppRelease(new Request(`${origin}/api/settings`, {
      headers: client === null ? {} : { [APP_RELEASE_HEADER]: client },
    }), route, A);
    expect(route).toHaveBeenCalledOnce();
    expect(reply.status).toBe(403);
    expect(await reply.text()).toBe('denied');
    expect(reply.headers.get(APP_RELEASE_HEADER)).toBe(A);
  });

  it('answers its metadata probe without entering auth, tenancy, or data routes', async () => {
    const route = vi.fn(async () => response(A));
    const reply = await withAppRelease(new Request(`${origin}/api/app-release`), route, A);
    expect(await reply.json()).toEqual({ release: A });
    expect(route).not.toHaveBeenCalled();
  });

  it('refuses malformed metadata and covers visit-prefixed demo APIs', async () => {
    const route = vi.fn(async () => response(A));
    const reply = await withAppRelease(new Request(`${origin}/visit/${'a'.repeat(32)}/api/config`, {
      headers: { [APP_RELEASE_HEADER]: 'not-a-version' },
    }), route, A);
    expect(reply.status).toBe(409);
    expect(route).not.toHaveBeenCalled();
  });
});

describe('an old browser document', () => {
  it.each(['/wall', '/wall/edit', '/integrations'])('reloads only the read-only display after an observed deployment: %s', async pathname => {
    const prior = window.location.href;
    window.history.replaceState(null, '', pathname);
    try {
      let server = A;
      const release = createAppRelease(async () => response(server), A);
      const reload = vi.fn();
      const view = render(<AppUpdateNotice release={release} reload={reload} />);
      expect(reload).not.toHaveBeenCalled();
      server = B;
      await act(async () => { await expect(release.check()).rejects.toBeInstanceOf(AppReleaseError); });
      expect(reload).toHaveBeenCalledTimes(pathname === '/wall' ? 1 : 0);
      view.rerender(<AppUpdateNotice release={release} reload={() => reload()} />);
      expect(reload).toHaveBeenCalledTimes(pathname === '/wall' ? 1 : 0);
    } finally { window.history.replaceState(null, '', prior); }
  });
  it('keeps the display open when release metadata is unavailable', async () => {
    const prior = window.location.href;
    window.history.replaceState(null, '', '/wall');
    try {
      const release = createAppRelease(async () => response(null), A);
      const reload = vi.fn();
      render(<AppUpdateNotice release={release} reload={reload} />);
      await act(async () => { await expect(release.check()).rejects.toBeInstanceOf(AppReleaseError); });
      expect(reload).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, '', prior); }
  });
  it('recovers an unattended display after a headerless outage without reopening API writes', async () => {
    const prior = window.location.href;
    window.history.replaceState(null, '', '/wall');
    vi.useFakeTimers();
    try {
      let server: string | null = null;
      const release = createAppRelease(async () => response(server), A);
      const reload = vi.fn();
      const view = render(<AppUpdateNotice release={release} reload={reload} />);
      await act(async () => { await expect(release.check()).rejects.toBeInstanceOf(AppReleaseError); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(reload).not.toHaveBeenCalled();
      server = A;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(reload).not.toHaveBeenCalled();
      server = B;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(reload).toHaveBeenCalledOnce();
      await expect(release.fetch('/api/settings', { method: 'PUT' })).rejects.toBeInstanceOf(AppReleaseError);
      view.unmount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); window.history.replaceState(null, '', prior); }
  });
  it('completes a same-release metadata check even when body cleanup stalls', async () => {
    let finish!: () => void;
    const canceled = new Promise<void>(resolve => { finish = resolve; });
    const release = createAppRelease(async () => new Response(new ReadableStream({ cancel: () => canceled }), {
      headers: { [APP_RELEASE_HEADER]: A },
    }), A);
    try { await release.check(); expect(release.snapshot()).toBe('current'); }
    finally { finish(); }
  });
  it('latches refusal before an unread body finishes cancellation', async () => {
    let finish!: () => void;
    const canceled = new Promise<void>(resolve => { finish = resolve; });
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel: () => canceled }), {
      headers: { [APP_RELEASE_HEADER]: B },
    }));
    const release = createAppRelease(fetch, A);
    try {
      await expect(release.fetch('/api/settings')).rejects.toBeInstanceOf(AppReleaseError);
      expect(release.snapshot()).toBe('changed');
      await expect(release.fetch('/api/config', { method: 'PUT' })).rejects.toBeInstanceOf(AppReleaseError);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { finish(); }
  });

  it.each([null, 'malformed', B])('rejects an unread %s response and stops later requests without retry', async (server) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(server, { amount: 123 }));
    const release = createAppRelease(fetch, A);
    await expect(release.fetch('/api/financials')).rejects.toBeInstanceOf(AppReleaseError);
    expect(release.snapshot()).toBe(server === B ? 'changed' : 'unavailable');
    await expect(release.fetch('/api/config', { method: 'PUT', body: '{}' })).rejects.toBeInstanceOf(AppReleaseError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(APP_RELEASE_HEADER)).toBe(A);
  });

  it('keeps observed zero and current response data intact', async () => {
    const release = createAppRelease(async () => response(A, { amount: 0 }), A);
    expect(await (await release.fetch('/api/financials')).json()).toEqual({ amount: 0 });
    expect(release.snapshot()).toBe('current');
  });

  it('does not apply an older in-flight response after another request observes a release change', async () => {
    let complete!: (value: Response) => void;
    const release = createAppRelease(vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }))
      .mockImplementationOnce(async () => response(B)), A);
    const earlier = release.fetch('/api/settings');
    await expect(release.fetch('/api/wall')).rejects.toBeInstanceOf(AppReleaseError);
    complete(response(A, { stale: true }));
    await expect(earlier).rejects.toBeInstanceOf(AppReleaseError);
  });

  it('keeps the owner cache and a mounted credential draft while refusing the changed result', async () => {
    let server = A;
    const fetch = vi.fn(async () => response(server, { saved: true }));
    const release = createAppRelease(fetch, A);
    const runtime = createBrowserRuntime({ mode: 'standalone', clientGeneration: 1 }, {
      origin, fetch, appRelease: release, sendAnswer: async () => {},
    });
    owned.push(runtime.retire);
    runtime.queries.setQueryData(['settings'], { previous: true });
    render(<><input type="password" aria-label="Draft key" defaultValue="synthetic-draft" /><AppUpdateNotice release={release} /></>);
    const input = screen.getByLabelText('Draft key');
    server = B;
    await act(async () => { await expect(runtime.api.fetchSettings()).rejects.toBeInstanceOf(AppReleaseError); });
    expect(runtime.queries.getQueryData(['settings'])).toEqual({ previous: true });
    expect(screen.getByLabelText('Draft key')).toBe(input);
    expect(input).toHaveValue('synthetic-draft');
    const link = screen.getByRole('link', { name: 'Open app in new tab' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(runtime.guard(() => true)()).toBe(true);
  });

  it('checks release before focus/session refresh can retire current drafts', async () => {
    let server = A;
    const fetch = vi.fn(async () => response(server, { mode: 'standalone' }));
    const release = createAppRelease(fetch, A);
    const entry = createBrowserEntry({ origin, fetch, page: window, landing: { kind: 'none' }, appRelease: release });
    owned.push(entry.dispose);
    await entry.refresh();
    const runtime = entry.snapshot().runtime;
    expect(runtime).not.toBeNull();
    server = B;
    await entry.refresh();
    expect(entry.snapshot().runtime).toBe(runtime);
    expect(runtime?.guard(() => true)()).toBe(true);
    expect(release.snapshot()).toBe('changed');
    const calls = fetch.mock.calls.length;
    await entry.refresh();
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('ignores an abandoned release probe while a successor session check is pending', async () => {
    let rejectEarlier!: (error: Error) => void;
    let completeSession!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectEarlier = reject; }))
      .mockResolvedValueOnce(response(A))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { completeSession = resolve; }));
    const release = createAppRelease(fetch, A);
    const entry = createBrowserEntry({ origin, fetch, page: window, landing: { kind: 'none' }, appRelease: release });
    owned.push(entry.dispose);
    const abandoned = entry.refresh();
    const successor = entry.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    rejectEarlier(new Error('abandoned probe'));
    await abandoned;
    expect(entry.snapshot().phase).toBe('checking');
    completeSession(response(A, { mode: 'standalone' }));
    await successor;
    expect(entry.snapshot().phase).toBe('ready');
  });

  it.each(['first-session', 'selected-session', 'pagination'])('keeps the real owner subtree after a %s compatibility refusal', async (stage) => {
    let changing = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const selected = new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER);
      const path = String(input);
      const mismatch = changing && (stage === 'first-session' ? path === '/api/session'
        : stage === 'selected-session' ? selected !== null : path.includes('?after='));
      return response(mismatch ? B : A, path === '/api/app-release' ? {} : facts(selected, workspaceId));
    });
    const release = createAppRelease(fetch, A);
    const entry = createBrowserEntry({ origin, fetch, page: window, landing: { kind: 'none' }, appRelease: release });
    owned.push(entry.dispose);
    await entry.refresh(); await entry.choose(workspaceId);
    const runtime = entry.snapshot().runtime!;
    runtime.queries.setQueryData(['settings'], { retained: true });
    render(<OwnedView entry={entry} />);
    const input = screen.getByLabelText('Owned draft');
    changing = true;
    await act(async () => { if (stage === 'pagination') await entry.loadMore(); else await entry.refresh(); });
    expect(entry.snapshot().runtime).toBe(runtime);
    expect(screen.getByLabelText('Owned draft')).toBe(input);
    expect(input).toHaveValue('synthetic-unsaved');
    expect(runtime.queries.getQueryData(['settings'])).toEqual({ retained: true });
    expect(sessionStorage.getItem(tabSelectionKey({ principalId, sessionId }))).toBe(workspaceId);
    expect(screen.getByRole('link', { name: 'Open app in new tab' })).toBeVisible();
    fireEvent.change(input, { target: { value: 'still-mounted' } });
    expect(input).toHaveValue('still-mounted');
    await expect(runtime.api.fetchSettings()).rejects.toThrow();
  });

  it.each(['denied', 'malformed', 'network'])('retires the old owner for a genuine %s session failure', async (kind) => {
    let failing = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === '/api/app-release') return response(A);
      if (failing) {
        if (kind === 'network') throw new Error('unreachable');
        if (kind === 'denied') return new Response(null, { status: 403, headers: { [APP_RELEASE_HEADER]: A } });
        return response(A, { mode: 'invalid' });
      }
      return response(A, facts(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER)));
    });
    const release = createAppRelease(fetch, A);
    const entry = createBrowserEntry({ origin, fetch, page: window, landing: { kind: 'none' }, appRelease: release });
    owned.push(entry.dispose); await entry.refresh(); await entry.choose(workspaceId);
    const runtime = entry.snapshot().runtime!;
    runtime.queries.setQueryData(['settings'], { retained: false });
    render(<OwnedView entry={entry} />);
    failing = true;
    await act(() => entry.refresh());
    expect(entry.snapshot().phase).toBe('unavailable');
    expect(entry.snapshot().runtime).toBeNull();
    expect(screen.queryByLabelText('Owned draft')).toBeNull();
    expect(runtime.queries.getQueryData(['settings'])).toBeUndefined();
    expect(runtime.guard(() => true)()).toBeUndefined();
  });

  it('rejects a decoded session body after another response observes a release change', async () => {
    let changing = false;
    let finish!: (value: unknown) => void;
    let decoding!: () => void;
    const started = new Promise<void>(resolve => { decoding = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input);
      if (path === '/api/observe-change') return response(B);
      const reply = response(A, path === '/api/app-release' ? {} : facts(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER)));
      if (changing && path === '/api/session') vi.spyOn(reply, 'json').mockImplementation(() => {
        decoding(); return new Promise(resolve => { finish = resolve; });
      });
      return reply;
    });
    const release = createAppRelease(fetch, A);
    const entry = createBrowserEntry({ origin, fetch, page: window, landing: { kind: 'none' }, appRelease: release });
    owned.push(entry.dispose);
    await entry.refresh(); await entry.choose(workspaceId);
    const runtime = entry.snapshot().runtime;
    render(<OwnedView entry={entry} />);
    const input = screen.getByLabelText('Owned draft');
    changing = true;
    await act(async () => {
      const refresh = entry.refresh(); await started;
      await expect(release.fetch('/api/observe-change')).rejects.toBeInstanceOf(AppReleaseError);
      finish(facts()); await refresh;
    });
    expect(entry.snapshot().runtime).toBe(runtime);
    expect(screen.getByLabelText('Owned draft')).toBe(input);
    expect(input).toHaveValue('synthetic-unsaved');
    expect(runtime?.guard(() => true)()).toBeUndefined();
  });

  it('freezes work immediately but keeps readable preferences/cache until final retirement', async () => {
    const send = vi.fn(async () => {});
    const runtime = createBrowserRuntime({ mode: 'standalone', clientGeneration: 1 }, {
      origin, fetch: vi.fn(), sendAnswer: send, storage: localStorage,
    });
    owned.push(runtime.retire);
    runtime.preferences.write('columns', 'saved');
    runtime.queries.setQueryData(['settings'], { amount: 0 });
    runtime.answers.schedule({ id: 'pending', answer: 'draft', delayMs: 60_000 });
    runtime.freeze(); runtime.freeze();
    expect(runtime.preferences.read('columns')).toBe('saved');
    expect(() => runtime.preferences.write('columns', 'new')).toThrow();
    expect(runtime.queries.getQueryData(['settings'])).toEqual({ amount: 0 });
    expect(runtime.guard(() => true)()).toBeUndefined();
    expect(runtime.answers.undo('pending')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await expect(runtime.api.fetchSettings()).rejects.toThrow('no longer active');
    runtime.retire(); runtime.retire();
    expect(runtime.queries.getQueryData(['settings'])).toBeUndefined();
    expect(() => runtime.preferences.read('columns')).toThrow();
  });
});
