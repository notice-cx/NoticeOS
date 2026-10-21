import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createApi } from '@/lib/api';
import { useSettings } from '@/hooks/useSettings';
import { useOperatorRate } from '@/hooks/useOperatorRate';

const state = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/browser-context', () => ({ useTowerApi: state.api }));
afterEach(cleanup);

it('shares the compact rate and clock read, separate from the full Settings payload', async () => {
  const transport = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('?view=preferences')
    ? { clock: { owner: 'config/constants.json', timeZone: 'UTC', chosen: false }, operatorRateUsdPerMin: 3.5 }
    : { collection: { pullAssets: [] } }));
  state.api.mockReturnValue(createApi(transport));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const clock = renderHook(() => useSettings('preferences'), { wrapper });
  const rate = renderHook(useOperatorRate, { wrapper });
  try {
    await waitFor(() => expect(rate.result.current).toBe(3.5));
    expect(clock.result.current.data?.clock.timeZone).toBe('UTC');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe('/api/settings?view=preferences');
    expect(client.getQueryData(['settings'])).toBeUndefined();
    await act(() => client.invalidateQueries({ queryKey: ['settings'] }));
    expect(transport).toHaveBeenCalledTimes(2);
  } finally { clock.unmount(); rate.unmount(); client.clear(); }
});
