import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { useIntegrationHealth } from '@/hooks/useIntegrationHealth';

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
