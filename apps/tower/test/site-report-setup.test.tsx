import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { SiteReportSetup } from '@/routes/asset-detail/SiteReportSetup';
import { deferred } from './deferred';

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
  runtime.queries.setDefaultOptions({ queries: { retry: false } });
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
  await waitFor(() => expect(replace).toBeEnabled());
  fireEvent.click(replace);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(effects).toEqual(['POST']);
  fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
  fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
  expect(await screen.findByText('fixture-report-2')).toBeVisible();
  expect(screen.queryByText('fixture-report-1')).toBeNull();
  expect(JSON.stringify(runtime.queries.getMutationCache().getAll().map(item => item.state.data))).not.toContain('fixture-report-2');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke token' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
  expect(effects).toEqual(['POST', 'POST']);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
  await waitFor(() => expect(screen.queryByText('fixture-report-2')).toBeNull());
  expect(effects).toEqual(['POST', 'POST', 'DELETE']);
});

it('keeps the one-time token visible and blocks writes until a failed status read is retried', async () => {
  const refresh = deferred<Response>();
  const status = (issued: boolean) => Response.json({ issued, mayIssue: true, mayRevoke: true });
  let reads = 0;
  let issues = 0;
  view(vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    if (init?.method === 'POST') {
      issues++;
      return Response.json({ token: 'fixture-report' }, { status: 201 });
    }
    reads++;
    if (reads === 1) return status(false);
    if (reads === 2) return refresh.promise;
    return status(true);
  }));
  try {
    const create = await screen.findByRole('button', { name: 'Create token' });
    fireEvent.click(create);
    expect(await screen.findByText('fixture-report')).toBeVisible();
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(issues).toBe(1);

    refresh.resolve(new Response(null, { status: 503 }));
    const retry = await screen.findByRole('button', { name: 'Retry reading report setup' });
    expect(screen.getByText('fixture-report')).toBeVisible();
    expect(create).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace token' })).toBeEnabled());
    expect(screen.getByText('fixture-report')).toBeVisible();
    expect(issues).toBe(1);
  } finally {
    refresh.resolve(status(true));
  }
});

it('keeps issue and revoke controls out of workspaces where the local intake is unavailable', async () => {
  view(vi.fn(async () => new Response(null, { status: 404 })));
  await screen.findByText('Report intake is unavailable for this workspace.');
  expect(screen.queryByRole('button')).toBeNull();
});
