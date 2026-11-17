import { createElement, type ReactNode } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { useIntegrationHealth } from '@/hooks/useIntegrationHealth';
import { WallHealthStamp } from '@/components/wall/WallHealthStamp';
import type { IntegrationHealthItem } from '@noticeos/contract/integration-health';

afterEach(() => { vi.useRealTimers(); });

it('ages source status at the cadence health is read, so a page that draws it repaints twice a minute, not twelve times', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ generatedAt: new Date().toISOString(), available: true, events: [], items: [] }));
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>({ mode: 'standalone', clientGeneration: 0 },
    { origin: 'https://desk.example', fetch, sendAnswer: async () => {} });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(BrowserRuntimeProvider, {
    value: { runtime, workspaceLabel: null },
    children: createElement(QueryClientProvider, { client: runtime.queries, children }),
  });
  let renders = 0;
  const { unmount } = renderHook(() => { renders++; return useIntegrationHealth(); }, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  const settled = renders;
  for (let second = 0; second < 60; second++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  // Two clock ticks and two polls at most; a 5 s clock alone would be twelve.
  expect(renders - settled).toBeLessThanOrEqual(6);
  unmount();
  runtime.retire();
});

const stamp = '2026-10-01T12:00:00.000Z';
const checked = Date.parse(stamp);
const item: IntegrationHealthItem = { id: 'healthy', provider: 'google', capability: 'counters', label: 'Analytics',
  asset: 'example.com', detail: null, report: null, reportDate: null, state: 'healthy', lastAttemptAt: stamp,
  lastSuccessAt: stamp, nextAttemptAt: null, failure: null, code: null, action: 'Check', coverage: 'monitored' };
const failed: IntegrationHealthItem = { ...item, id: 'failed', state: 'failing', asset: 'other.example', lastSuccessAt: null };
const health = (available = true) => Response.json({ generatedAt: stamp, available, events: [], items: [item, failed] });

function healthOwner(fetch: typeof globalThis.fetch) {
  const id = '11111111-1111-4111-8111-111111111111';
  const runtime = createBrowserRuntime({ mode: 'hosted', clientGeneration: 1, workspaceId: id, principalId: id, sessionId: id },
    { origin: 'https://desk.example', fetch, sendAnswer: async () => {} });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(BrowserRuntimeProvider, {
    value: { runtime, workspaceLabel: null },
    children: createElement(QueryClientProvider, { client: runtime.queries, children }),
  });
  return { runtime, wrapper };
}

it('live health expires at 90 seconds when observations stop advancing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(checked);
  const fetch = vi.fn(async () => health());
  const { runtime, wrapper } = healthOwner(fetch);
  const hook = renderHook(() => useIntegrationHealth(), { wrapper });
  try {
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(hook.result.current.status.items.map(entry => entry.state)).toEqual(['healthy', 'failing']);
    await act(() => vi.advanceTimersByTimeAsync(89_998));
    expect(hook.result.current.status.current).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(hook.result.current.status.items.map(entry => entry.state)).toEqual(['unknown', 'failing']);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  } finally { hook.unmount(); runtime.retire(); }
});

it('keeps a validated Wall snapshot dated between refreshes and marks later stale or failed reads', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(checked);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => health());
  const { runtime, wrapper } = healthOwner(fetch);
  function Read() {
    const { snapshot, status, refetch } = useIntegrationHealth(false);
    return <>
      {snapshot ? <WallHealthStamp snapshot={snapshot} timeZone="UTC" /> : null}
      <output>{status.items.map(entry => entry.state).join(',')}</output>
      <button onClick={() => void refetch()}>Refresh</button>
    </>;
  }
  const view = render(<Read />, { wrapper });
  const status = () => view.container.querySelector('[data-health-snapshot]');
  try {
    expect(status()).toHaveAttribute('data-health-snapshot', 'unknown');
    await act(() => vi.advanceTimersByTimeAsync(121_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(status()).toHaveAttribute('data-health-snapshot', 'saved');
    expect(status()?.querySelector('time')).toHaveAttribute('datetime', stamp);
    expect(screen.getByText('healthy,failing')).toBeVisible();
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh' }).click();
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(status()).toHaveAttribute('data-health-snapshot', 'stale');
    expect(screen.getByText('unknown,failing')).toBeVisible();
    fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh' }).click();
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(status()).toHaveAttribute('data-health-snapshot', 'error');
    expect(status()?.querySelector('time')).toHaveAttribute('datetime', stamp);
    expect(screen.getByText('unknown,failing')).toBeVisible();
    fetch.mockImplementation(async () => new Response(null, { status: 403 }));
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh' }).click();
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(status()?.querySelector('time')).toBeNull();
    expect(screen.queryByText('unknown,failing')).toBeNull();
  } finally { view.unmount(); runtime.retire(); }
});
