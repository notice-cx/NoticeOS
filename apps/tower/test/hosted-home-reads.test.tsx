import { INTEGRATION_PROVIDERS } from '@noticeos/contract';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { useConnections } from '@/hooks/useConnections';
import { useCreateTask } from '@/hooks/useTasks';
import { useWork } from '@/hooks/useWork';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { HomeRoute } from '@/routes/HomeRoute';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { assetMoneyResponse, wallMoneyResponse } from './critical-response-fixtures';
import { item, payload, project } from './tasks-next-fixtures';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const owner = { mode: 'hosted', clientGeneration: 1, workspaceId, sessionId, principalId: '33333333-3333-4333-8333-333333333333' };
const initialTime = '2026-10-01T12:00:00.000Z';
const primary = 'first.example';
const detail = `/api/assets/${primary}`;
const health = '/api/integrations/health';
const providers = '/api/integrations/providers';
const wall = '/api/wall';
const feed = '/api/wall/feed';
const work = '/api/work';
const briefing = '/api/portfolio-brief';
const watched = [wall, feed, work, health, providers];
const windowMs = 11 * 60_000;
const empty = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
const projectId = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(initialTime));
  focusManager.setFocused(true);
});
afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

async function elapsed(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
  await act(() => vi.advanceTimersByTimeAsync(10));
}

function card(id: string, displayName: string) {
  return { id, displayName, status: 'live', openError: 0, openWarn: 0, work: null, dataSources: [],
    pulseReceivedAt: initialTime, firstReportAt: initialTime, activeUsers: empty, searchClicks: empty,
    netPeriod: '2026-10', booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    netByMonthCurrency: 'USD', netByMonth: [], netByMonthProvisionalFrom: null };
}

function fixture({ sites = 1, mode = 'hosted' }: { sites?: number; mode?: 'hosted' | 'standalone' } = {}) {
  const denied = new Set<string>();
  const reads: string[] = [];
  const deniedOrUnknown: { path: string; status: number }[] = [];
  let actionSaved = false;
  const runtime = createBrowserRuntime(mode === 'hosted' ? owner : { mode, clientGeneration: 1 }, {
    origin: location.origin,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      reads.push(path);
      if (mode === 'hosted') {
        const headers = new Headers(init?.headers);
        expect(headers.get(WORKSPACE_SELECTION_HEADER)).toBe(workspaceId);
        expect(headers.get(WORKSPACE_SESSION_HEADER)).toBe(sessionId);
      }
      if (denied.has(path)) {
        deniedOrUnknown.push({ path, status: 403 });
        return Response.json({ error: 'access_lost' }, { status: 403 });
      }
      const generatedAt = new Date().toISOString();
      switch (path) {
        case wall: return Response.json(wallMoneyResponse({ generatedAt, osTimeZone: 'UTC', attention: [],
          assets: [card(primary, 'First portfolio asset'), ...(sites > 1 ? [card('second.example', 'Second portfolio asset')] : [])] }));
        case feed: return Response.json({ generatedAt, since: generatedAt, items: [] });
        case work: {
          const waiting = [item({ id: 'fixture-decision', title: actionSaved ? 'Task after action' : 'Private decision before action', issueType: 'gate' })];
          return Response.json({ ...payload([project({ asset: primary, waiting })]), capturedAt: generatedAt });
        }
        case health: return Response.json({ generatedAt, available: true, items: [], events: [] });
        case providers: return Response.json({ generatedAt, keyPresent: true, blockers: [], keyReason: null, providers: [{
          provider: INTEGRATION_PROVIDERS.find(entry => entry.id === 'google')!, assets: [], credential: { provider: 'google', source: 'store',
            fields: [], assetsHeld: [], missingFields: [], auth: 'oauth', keyVersion: 1,
            createdAt: initialTime, updatedAt: initialTime, lastUsedAt: null, lastOkAt: null, lastError: null,
            metadata: { account: null, scopes: [], connectedAt: initialTime, expiresAt: '2026-10-05T12:00:00.000Z', expirySource: 'flow' },
          },
        }] });
        case detail: return Response.json({ ...assetMoneyResponse(primary), generatedAt,
          view: url.searchParams.get('view'), integrations: { lanes: [], sources: [] }, metrics: [], executive: null,
          performance: { activeUsers: empty, sessions: empty, webSearchClicks: { google: empty, bing: empty },
            webSearchImpressions: { google: empty, bing: empty } },
        });
        case '/api/tasks/capabilities': return Response.json({ live: true });
        case '/api/tasks/projects': return Response.json({ projects: [{ projectId, logicalKey: 'fixture', prefix: 'fix', displayName: 'Fixture' }] });
        case '/api/tasks':
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toMatchObject({ projectId, title: 'Create fixture task' });
          actionSaved = true;
          return Response.json({ id: 'fixture-created' }, { status: 201 });
        case briefing: return Response.json({ state: 'unsupported' });
        default:
          deniedOrUnknown.push({ path, status: 404 });
          return new Response(null, { status: 404 });
      }
    },
    sendAnswer: async () => {},
  });
  const wrapper = ({ children }: { children: ReactNode }) => <BrowserRuntimeProvider value={{ runtime, workspaceLabel: 'Synthetic' }}>
    <QueryClientProvider client={runtime.queries}>{children}</QueryClientProvider>
  </BrowserRuntimeProvider>;
  return { runtime, wrapper, reads, denied, deniedOrUnknown, count: (path: string) => reads.filter(read => read === path).length };
}

function FileFixtureTask() {
  const create = useCreateTask();
  return <button type="button" onClick={() => create.mutate({ project: 'fixture', title: 'Create fixture task' })}>File fixture task</button>;
}

function home(f: ReturnType<typeof fixture>) {
  return render(<MemoryRouter><Routes><Route element={<AppShell />}>
    <Route index element={<><HomeRoute /><FileFixtureTask /></>} />
  </Route></Routes></MemoryRouter>, { wrapper: f.wrapper });
}

it.each([1, 2])('keeps customer Home and both navigation layouts quiet with %i assets', async sites => {
  const f = fixture({ sites });
  const ui = home(f);
  try {
    await elapsed(100);
    expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
    expect(screen.getByText('Private decision before action')).toBeVisible();
    expect(ui.container.querySelector('[data-app-sidebar]')).not.toBeNull();
    expect(ui.container.querySelector('[data-nav-alarm]')).toHaveAttribute('data-nav-alarm', 'warn');
    expect(ui.container.querySelector('[data-health-snapshot] time')).toHaveAttribute('datetime', initialTime);
    const paths = sites === 1 ? [...watched, detail] : watched;
    expect(paths.map(f.count)).toEqual(paths.map(() => 1));
    expect(f.deniedOrUnknown).toEqual([]);
    expect(f.count(detail)).toBe(sites === 1 ? 1 : 0);
    if (sites === 1) expect(ui.container.querySelector('[data-overview-numbers]')).not.toBeNull();

    // Briefing availability is qualified separately. It is excluded only
    // from the measurement of the other Home and shell read paths.
    const core = () => f.reads.filter(path => path !== briefing);
    const entry = core();
    expect(entry.slice().sort()).toEqual([...paths, '/api/tasks/capabilities'].sort());
    await elapsed(windowMs);
    expect(core()).toEqual(entry);
    focusManager.setFocused(false);
    await elapsed(windowMs);
    expect(core()).toEqual(entry);

    focusManager.setFocused(true);
    await elapsed(100);
    expect(core().slice(entry.length).sort()).toEqual([...paths].sort());
    expect(ui.container.querySelector('[data-health-snapshot] time')?.getAttribute('datetime')).not.toBe(initialTime);

    if (sites === 1) {
      fireEvent.click(screen.getByRole('button', { name: 'File fixture task' }));
      await elapsed(100);
      expect(screen.getByText('Task after action')).toBeVisible();
      expect(f.count(work)).toBe(3);
      expect(f.count(detail)).toBe(3);
    }
    expect(f.deniedOrUnknown).toEqual([]);
  } finally { ui.unmount(); f.runtime.retire(); }
});

it('drops only refused Home data when the same workspace returns without access to those reads', async () => {
  const f = fixture();
  const ui = home(f);
  try {
    await elapsed(100);
    expect(screen.getByText('Private decision before action')).toBeVisible();
    expect(ui.container.querySelector('[data-overview-numbers]')).not.toBeNull();
    focusManager.setFocused(false);
    await elapsed(windowMs);
    for (const path of [work, providers, health, detail]) f.denied.add(path);
    focusManager.setFocused(true);
    await elapsed(1_500);
    expect(f.deniedOrUnknown.map(reply => reply.path).sort()).toEqual([work, providers, health, detail].sort());
    expect(screen.queryByText('Private decision before action')).toBeNull();
    expect(ui.container.querySelector('[data-nav-alarm]')).toBeNull();
    expect(ui.container.querySelector('[data-health-snapshot] time')).toBeNull();
    expect(ui.container.querySelector('[data-overview-numbers]')).toBeNull();
    expect(ui.container.querySelector('[data-one-site-lead]')).not.toBeNull();
  } finally { ui.unmount(); f.runtime.retire(); }
});

it.each(['hosted', 'standalone'] as const)('keeps active %s monitoring and task reads on their existing clocks', async mode => {
  const f = fixture({ mode });
  const monitor = renderHook(() => { useWork(); useConnections(); }, { wrapper: f.wrapper });
  try {
    await elapsed(100);
    expect([work, health, providers].map(f.count)).toEqual([1, 1, 1]);
    await elapsed(30_000);
    expect([work, health, providers].map(f.count)).toEqual([2, 2, 1]);
    await elapsed(270_000);
    expect([work, health, providers].map(f.count)).toEqual([11, 11, 2]);
    focusManager.setFocused(false);
    await elapsed(windowMs);
    expect([work, health, providers].map(f.count)).toEqual([11, 11, 2]);
    monitor.unmount();
    const disabled = renderHook(() => useWork({ enabled: false, watch: false }), { wrapper: f.wrapper });
    try {
      focusManager.setFocused(true);
      await elapsed(61_000);
      expect(f.count(work)).toBe(11);
    } finally { disabled.unmount(); }
  } finally { monitor.unmount(); f.runtime.retire(); }
});
