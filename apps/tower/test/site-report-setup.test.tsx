import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { SiteReportSetup } from '@/routes/asset-detail/SiteReportSetup';

const workspace = '00000000-0000-4000-8000-000000000001';
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
});

function view(fetch: typeof globalThis.fetch) {
  const runtime = createBrowserRuntime({ mode: 'hosted', clientGeneration: 1,
    workspaceId: workspace, principalId: workspace, sessionId: workspace }, {
    origin: location.origin, fetch, sendAnswer: async () => {},
  });
  runtimes.push(runtime);
  render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: 'Example' }}>
    <QueryClientProvider client={runtime.queries}><SiteReportSetup asset="shared.example" /></QueryClientProvider>
  </BrowserRuntimeProvider>);
  return runtime;
}

it('keeps the report token out of cached results and confirms replacement and revocation', async () => {
  let issued = false;
  let generation = 0;
  const effects: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method === 'GET') return Response.json({ issued, mayIssue: true, mayRevoke: true });
    effects.push(method);
    issued = method === 'POST';
    return issued ? Response.json({ token: 'fixture-report-' + ++generation }, { status: 201 }) : new Response(null, { status: 204 });
  });
  const runtime = view(fetch);
  fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
  expect(await screen.findByText('fixture-report-1')).toBeVisible();
  const replace = await screen.findByRole('button', { name: 'Replace token' });
  fireEvent.click(replace);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(effects).toEqual(['POST']);
  fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
  fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
  expect(await screen.findByText('fixture-report-2')).toBeVisible();
  expect(screen.queryByText('fixture-report-1')).toBeNull();
  expect(JSON.stringify(runtime.queries.getMutationCache().getAll().map(item => item.state.data))).not.toContain('fixture-report-2');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
  expect(effects).toEqual(['POST', 'POST']);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
  await waitFor(() => expect(screen.queryByText('fixture-report-2')).toBeNull());
  expect(effects).toEqual(['POST', 'POST', 'DELETE']);
});

it('keeps issue and revoke controls out of workspaces where the local intake is unavailable', async () => {
  view(vi.fn(async () => new Response(null, { status: 404 })));
  await screen.findByText('Report intake is unavailable for this workspace.');
  expect(screen.queryByRole('button')).toBeNull();
});
