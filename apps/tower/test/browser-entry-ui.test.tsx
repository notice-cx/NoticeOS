import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { createBrowserRouter } from 'react-router-dom';
import { BrowserEntry } from '@/BrowserEntry';
import { captureBrowserLanding, createBrowserEntry } from '@/lib/browser-entry';
import type { BrowserEntry as Entry } from '@/lib/browser-entry';
import type { ApiTransport } from '@/lib/api';

const records = vi.hoisted(() => ({ routers: [] as { router: ReturnType<typeof createBrowserRouter>; disposed: ReturnType<typeof vi.spyOn> }[] }));
vi.mock('@/App', async () => {
  const { createBrowserRouter } = await import('react-router-dom');
  return { createTowerRouter() {
    const router = createBrowserRouter([{ path: '*', element: <span>Owned screen</span> }]);
    const disposed = vi.spyOn(router, 'dispose'); records.routers.push({ router, disposed }); return router;
  } };
});
const id = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  for (const { router } of records.routers.splice(0)) router.dispose();
  window.history.replaceState(null, '', '/'); vi.restoreAllMocks();
});
it('StrictMode disposes every abandoned controller/request/router without weakening replay checks', async () => {
  const controllers: Entry[] = []; const signals: AbortSignal[] = [];
  let release!: (response: Response) => void; let reads = 0;
  const fetch: ApiTransport = async (_input, init) => {
    signals.push(init!.signal!);
    if (++reads === 1) return new Promise(resolve => { release = resolve; });
    return Response.json({ mode: 'standalone' });
  };
  const landing = captureBrowserLanding(window);
  const factory = () => { const value = createBrowserEntry({ origin: window.location.origin, page: window, fetch, landing }); controllers.push(value); return value; };
  const rendered = render(<StrictMode><BrowserEntry createEntry={factory} /></StrictMode>);
  await screen.findByText('Owned screen');
  expect(controllers).toHaveLength(2); expect(signals[0]?.aborted).toBe(true);
  release(Response.json({ mode: 'standalone' }));
  await waitFor(() => expect(controllers[0]?.snapshot().runtime).toBeNull());
  expect(records.routers).toHaveLength(2);
  expect(records.routers[0]?.disposed).toHaveBeenCalledTimes(1);
  expect(records.routers[1]?.disposed).not.toHaveBeenCalled();
  rendered.unmount();
  expect(records.routers[1]?.disposed).toHaveBeenCalledTimes(1);
  expect(controllers[1]?.snapshot().runtime?.guard(() => true)()).toBeUndefined();
});
it('StrictMode preserves captured enrollment after fragment removal and first effect cleanup', async () => {
  window.history.replaceState(null, '', `/sign-in#invitation=${id}`);
  const landing = captureBrowserLanding(window);
  expect(window.location.hash).toBe('');
  const controllers: Entry[] = [];
  const factory = () => {
    const value = createBrowserEntry({ origin: window.location.origin, page: window, landing,
      fetch: async () => Response.json({ mode: 'hosted', session: null, workspaces: [], selectedWorkspace: null, nextCursor: null }),
    }); controllers.push(value); return value;
  };
  const rendered = render(<StrictMode><BrowserEntry createEntry={factory} /></StrictMode>);
  await screen.findByRole('button', { name: 'Send code' });
  expect(controllers).toHaveLength(2);
  expect(controllers[1]?.enrollment).toEqual({ kind: 'invitation', id });
  expect(window.location.hash).toBe(''); rendered.unmount();
});
