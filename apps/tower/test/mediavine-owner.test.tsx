import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { MediavineSettings } from '@/routes/asset-detail/MediavineSettings';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import type { ApiTransport } from '@/lib/api';

const id = '11111111-1111-4111-8111-111111111111';
const status = { connected: true, siteId: 'generated', enabled: true, holidayCalendar: 'none', daily: [{ date: '2026-09-15', amountMinor: 1234 }],
  availableThrough: '2026-09-15', reportedThrough: '2026-09-15', lastSuccessAt: null, lastAttemptAt: null, nextAttemptAt: null, differenceMinor: null, error: null };
const owned: ReturnType<typeof createBrowserRuntime>[] = [];
function show(fetch: ApiTransport, mode: 'hosted' | 'demo' = 'hosted') {
  const owner = mode === 'hosted' ? { mode, principalId: id, sessionId: id, workspaceId: id, clientGeneration: 1 } : { mode, workspaceId: id, clientGeneration: 1 };
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>(owner, { origin: window.location.origin, fetch, sendAnswer: async () => {} });
  owned.push(runtime);
  render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: 'Generated workspace' }}><QueryClientProvider client={runtime.queries}>
    <MediavineSettings asset="example.com" />
  </QueryClientProvider></BrowserRuntimeProvider>);
  return runtime;
}
afterEach(() => { owned.splice(0).forEach(runtime => runtime.retire()); vi.restoreAllMocks(); });
it('saved reads and refresh capture the same owner headers; retired success cannot repaint or invalidate', async () => {
  const calls: { path: string; headers: Headers }[] = [];
  let finish!: (response: Response) => void;
  const runtime = show(async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, headers: new Headers(init?.headers) });
    if (path === '/api/config') return Response.json({ writable: true, sources: {}, reason: null });
    if (init?.method === 'POST') return new Promise<Response>(yes => { finish = yes; });
    return Response.json({ ok: true, value: status });
  });
  const button = await screen.findByRole('button', { name: 'Refresh revenue' });
  const invalidate = vi.spyOn(runtime.queries, 'invalidateQueries');
  fireEvent.click(button);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  for (const call of calls) {
    expect(call.headers.get(WORKSPACE_SELECTION_HEADER)).toBe(id);
    expect(call.headers.get(WORKSPACE_SESSION_HEADER)).toBe(id);
  }
  runtime.retire();
  await act(async () => finish(Response.json({ ok: true, value: { ...status, reportedThrough: '2026-09-16' } })));
  expect(screen.queryByText('2026-09-16')).toBeNull(); expect(invalidate).not.toHaveBeenCalled();
});
it('retired error and delayed initial read cannot publish local state', async () => {
  let reject!: (error: Error) => void;
  const runtime = show(async input => new URL(String(input)).pathname === '/api/config' ? Response.json({ writable: true, sources: {} })
    : new Promise<Response>((_yes, no) => { reject = no; }));
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  runtime.retire(); await act(async () => reject(new Error('predecessor error')));
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByRole('button', { name: 'Refresh revenue' })).toBeNull();
});
it('verified demo preserves saved values but refuses provider effects immediately', async () => {
  const fetch = vi.fn<ApiTransport>(async input => new URL(String(input)).pathname === '/api/config' ? Response.json({ writable: true, sources: {} })
    : Response.json({ ok: true, value: status }));
  show(fetch, 'demo');
  const button = await screen.findByRole('button', { name: 'Refresh revenue' });
  expect(button).toBeDisabled(); fireEvent.click(button);
  expect(screen.getByRole('combobox', { name: 'Forecast holiday calendar' })).toBeDisabled();
  expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST' && init?.method !== 'PUT')).toBe(true);
});
