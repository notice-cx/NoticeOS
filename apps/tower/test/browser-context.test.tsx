import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeProvider, useOwnerMutation, useOwnerPreferences, useOwnerToast, useTowerApi } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { DemoViewerStatus } from '@/components/DemoViewerStatus';
import { useConfigWritable } from '@/hooks/useConfigWritable';
import { useCalendarUpcoming } from '@/hooks/useCalendarUpcoming';
import { useGa4Realtime } from '@/hooks/useGa4Realtime';
import { PropertyFavicon } from '@/components/PropertyFavicon';

const notifications = vi.hoisted(() => ({
  plain: vi.fn<(message: string, options?: { action?: { label: string; onClick: () => void } }) => void>(),
  success: vi.fn<(message: string, options?: { action?: { label: string; onClick: () => void } }) => void>(),
  error: vi.fn<(message: string) => void>(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(notifications.plain, notifications) }));
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
const id = '11111111-1111-4111-8111-111111111111';
function owned(workspaceId = id) {
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>({ mode: 'hosted', principalId: id, sessionId: id, workspaceId, clientGeneration: 1 }, {
    origin: window.location.origin, fetch: vi.fn(), storage: window.localStorage,
    sendAnswer: async () => {},
  });
  runtimes.push(runtime);
  return runtime;
}
function wrapper(runtime: ReturnType<typeof owned>) {
  return function Owner({ children }: { children: ReactNode }) {
    return <BrowserRuntimeProvider value={{ runtime, workspaceLabel: 'Workspace' }}><QueryClientProvider client={runtime.queries}>{children}</QueryClientProvider></BrowserRuntimeProvider>;
  };
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
  window.localStorage.clear(); vi.clearAllMocks();
});
it('missing owner context refuses rather than using standalone transport', () => {
  const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(useTowerApi)).toThrow('verified browser runtime');
  silence.mockRestore();
});
it('two owners with colliding query/preference names share neither values nor legacy imports', () => {
  window.localStorage.setItem('noticeos:palette-recent', 'private standalone');
  window.localStorage.setItem('reindex-os:palette-recent', 'old standalone');
  const a = owned(); const b = owned('22222222-2222-4222-8222-222222222222');
  const pa = renderHook(useOwnerPreferences, { wrapper: wrapper(a) });
  const pb = renderHook(useOwnerPreferences, { wrapper: wrapper(b) });
  expect(pa.result.current.read('palette-recent')).toBeNull();
  pa.result.current.write('palette-recent', 'A');
  expect(pb.result.current.read('palette-recent')).toBeNull();
  a.queries.setQueryData(['settings'], 'A');
  expect(b.queries.getQueryData(['settings'])).toBeUndefined();
  a.retire();
  expect(() => pa.result.current.write('palette-recent', 'late A')).toThrow('no longer active');
});
it('late completion/error/optimistic rollback callbacks and old Undo cannot reach another owner', async () => {
  const a = owned(); const b = owned('22222222-2222-4222-8222-222222222222');
  let reject!: (error: Error) => void;
  const rollback = vi.fn(); const settled = vi.fn(); const perCall = vi.fn();
  const hook = renderHook(() => useOwnerMutation({
    mutationFn: () => new Promise<void>((_resolve, no) => { reject = no; }),
    onMutate: () => 'optimistic A', onError: rollback, onSettled: settled,
  }), { wrapper: wrapper(a) });
  act(() => hook.result.current.mutate(undefined, { onError: perCall }));
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  const show = renderHook(useOwnerToast, { wrapper: wrapper(a) });
  const undo = vi.fn();
  show.result.current.success('Saved', { action: { label: 'Undo', onClick: undo } });
  const oldUndo = notifications.success.mock.calls[0]?.[1]?.action?.onClick;
  show.result.current('Saved', { action: { label: 'Undo', onClick: undo } });
  const plainUndo = notifications.plain.mock.calls[0]?.[1]?.action?.onClick;
  a.retire();
  await act(async () => { reject(new Error('late A')); });
  oldUndo?.(); plainUndo?.(); show.result.current.error('late A');
  expect(rollback).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled(); expect(perCall).not.toHaveBeenCalled();
  expect(undo).not.toHaveBeenCalled(); expect(notifications.error).not.toHaveBeenCalled();
  expect(b.guard(() => true)()).toBe(true);
});
it('a retired owner cannot publish a late successful mutation', async () => {
  const a = owned(); let resolve!: (value: string) => void;
  const success = vi.fn(); const perCall = vi.fn();
  const hook = renderHook(() => useOwnerMutation({ mutationFn: () => new Promise<string>(yes => { resolve = yes; }), onSuccess: success }), { wrapper: wrapper(a) });
  act(() => hook.result.current.mutate(undefined, { onSuccess: perCall }));
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  a.retire(); await act(async () => { resolve('late success'); });
  expect(success).not.toHaveBeenCalled(); expect(perCall).not.toHaveBeenCalled();
});
it('verified hosted demo is read-only before capability arrives and invents no generation age', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>({ mode: 'demo', workspaceId: id, clientGeneration: 1 }, {
    origin: window.location.origin, fetch, sendAnswer: async () => {},
  }); runtimes.push(runtime);
  const Owner = wrapper(runtime);
  render(<Owner><DemoViewerStatus /><PropertyFavicon domain="example.com" displayName="Example" /></Owner>);
  expect(screen.getByRole('status')).toHaveTextContent('Synthetic demo · Read only');
  expect(screen.queryByText(/Generated|Scenario through/u)).toBeNull();
  expect(screen.getByText('Generation time unknown')).toBeInTheDocument();
  const capability = renderHook(useConfigWritable, { wrapper: Owner });
  expect(capability.result.current.writable).toBe(false);
  renderHook(useCalendarUpcoming, { wrapper: Owner }); renderHook(useGa4Realtime, { wrapper: Owner });
  expect(document.querySelector('[data-property-favicon] img')).toBeNull();
  // Both Wall reads are asked for: the hosted demo answers them synthetically.
  await vi.waitFor(() => {
    for (const path of ['/api/ga4/realtime', '/api/calendar/upcoming']) {
      expect(fetch.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).includes(path))).toBe(true);
    }
  });
});
it('a demo generation poll retains the owner desk and last successful evidence after a failed read', async () => {
  let available = true;
  const generatedAt = '2026-09-16T11:55:00.000Z';
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (!available) throw new Error('Controlled read unavailable');
    return Response.json({ generatedAt, through: '2026-09-15' });
  });
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>({ mode: 'demo', workspaceId: id, clientGeneration: 1 }, {
    origin: window.location.origin, fetch, sendAnswer: async () => {},
  }); runtimes.push(runtime); runtime.queries.setDefaultOptions({ queries: { retry: false } });
  const Owner = wrapper(runtime);
  render(<Owner><input aria-label="Fixture draft" defaultValue="" /><DemoViewerStatus nowMs={Date.parse('2026-09-16T12:00:00Z')} /></Owner>);
  await vi.waitFor(() => expect(screen.getByText('Generated 5m ago')).toHaveAttribute('title', generatedAt));
  fireEvent.change(screen.getByRole('textbox', { name: 'Fixture draft' }), { target: { value: 'Unsubmitted draft' } });
  available = false;
  await act(async () => { await runtime.queries.invalidateQueries({ queryKey: ['demo-presentation'] }); });
  expect(screen.getByText('Generated 5m ago')).toHaveAttribute('title', generatedAt);
  expect(screen.getByRole('textbox', { name: 'Fixture draft' })).toHaveValue('Unsubmitted draft');
  expect(fetch).toHaveBeenCalledTimes(2); expect(runtime.guard(() => 'active')()).toBe('active');
});
