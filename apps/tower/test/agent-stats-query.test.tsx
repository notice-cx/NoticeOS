import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { readAgentStats } from '@noticeos/contract/agent-stats';
import { createApi } from '@/lib/api';
import { useAgentWork } from '@/hooks/useAgentWork';

const state = vi.hoisted(() => ({ live: true, api: vi.fn() }));
vi.mock('@/lib/browser-context', () => ({ useTowerApi: state.api }));
vi.mock('@/hooks/useTasks', () => ({ useTasksLive: () => ({ live: state.live }) }));
afterEach(() => { cleanup(); state.live = true; });

it('uses only the aggregate endpoint and refreshes when task writes invalidate tasks', async () => {
  const payload = { readAt: new Date().toISOString(), projects: 4, broken: [], stats: readAgentStats([], Date.now()) };
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(payload));
  state.api.mockReturnValue(createApi(transport));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(useAgentWork, { wrapper });
  try {
    await waitFor(() => expect(hook.result.current.complete).toBe(true));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe('/api/tasks/agent-stats');
    await act(() => client.invalidateQueries({ queryKey: ['tasks'] }));
    expect(transport).toHaveBeenCalledTimes(2);
  } finally { hook.unmount(); client.clear(); }
});

it('never requests live statistics in a snapshot deployment', async () => {
  state.live = false;
  const transport = vi.fn(async () => Response.json({}));
  state.api.mockReturnValue(createApi(transport));
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(useAgentWork, { wrapper });
  try {
    expect(hook.result.current.live).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  } finally { hook.unmount(); client.clear(); }
});
