import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS_RUNBOOKS } from '@shared/analysis-runbooks';
import type { AnalysisRun, AnalysisWorkflow } from '@shared/analysis-workflows';
import { createAppRelease } from '@/lib/app-release';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import WorkflowsRoute from '@/routes/WorkflowsRoute';
import { wallMoneyResponse } from './critical-response-fixtures';

const WORKFLOW = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const ASSET = 'meadow.example';
const DATE = '2026-11-15T23:00:00Z';
const PATH = '/api/analysis-workflows';
const ZERO_MONEY = { revenue: 0, cost: 0, net: 0, currency: 'USD' };
const assetMoney = { booked: ZERO_MONEY, forecast: ZERO_MONEY, netPeriod: '2026-11', netByMonth: [], netByMonthCurrency: null, netByMonthProvisionalFrom: null };
const legacy = { generatedAt: DATE, runtimeFresh: false, observationsFresh: false, historyAvailable: true, overrides: null, runtime: null, workflows: [], selectedRun: null };
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];

function fixture(prepared = false, loseFirstStartResponse = false) {
  let workflow: AnalysisWorkflow | null = prepared ? {
    id: WORKFLOW, template: 'weekly-search-review', name: 'My search review', assetIds: [ASSET], enabled: true, version: 1,
    trigger: { kind: 'manual' }, createdAt: DATE, updatedAt: DATE,
  } : null;
  let run: AnalysisRun | null = null;
  const traffic: { path: string; method: string; key: string | null | undefined; body: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    traffic.push({ path, method, key: init?.headers && new Headers(init.headers).get('Idempotency-Key'), body });
    if (path === '/api/wall') return Response.json(wallMoneyResponse({ osTimeZone: 'Etc/UTC', assets: [
      { id: ASSET, displayName: 'Meadow', status: 'live', ...assetMoney },
      { id: 'retired.example', displayName: 'Retired', status: 'retired', ...assetMoney },
    ] }));
    if (path === '/api/workflows') return Response.json(legacy);
    if (path === PATH && method === 'GET') return Response.json({ workflows: workflow ? [workflow] : [], runbooks: ANALYSIS_RUNBOOKS });
    if (path === PATH && method === 'POST') {
      workflow = { ...body, id: WORKFLOW, enabled: true, version: 1, createdAt: DATE, updatedAt: DATE };
      return Response.json({ workflow }, { status: 201 });
    }
    if (path === `${PATH}/${WORKFLOW}` && workflow) return Response.json({ workflow, runs: run ? [run] : [] });
    if (path === `${PATH}/${WORKFLOW}/runs` && method === 'POST' && workflow) {
      run ??= {
        id: RUN, workflowId: WORKFLOW, source: 'manual', retryOf: null, createdAt: DATE, scheduledAt: null, completedAt: null, result: null, outcome: null,
        workflow, runbook: ANALYSIS_RUNBOOKS.find(book => book.id === workflow!.template)!,
        evidence: { asOf: DATE, coverage: [{ assetId: ASSET, source: 'Search Console', status: 'available', detail: 'Seven complete dates' }], citations: [
          { id: 'gsc-1', assetId: ASSET, label: 'Search clicks', source: 'Search Console', observedAt: DATE, href: `/assets/${ASSET}/search`, note: '', readings: [{ label: 'Clicks', value: 0 }] },
        ] },
      };
      if (loseFirstStartResponse) {
        loseFirstStartResponse = false;
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      }
      return Response.json({ run }, { status: 201 });
    }
    if (path === `${PATH}/${WORKFLOW}/runs/${RUN}` && run) return Response.json({ run });
    if (path === `${PATH}/assignments` && method === 'GET') return Response.json({ projects: [
      { projectId: PROJECT, displayName: 'Search review' }, { projectId: WORKFLOW, displayName: 'Other project' },
    ] });
    if (path === `${PATH}/${WORKFLOW}/runs/${RUN}/assignment` && method === 'POST' && run) {
      const assignment = { projectId: String(body.projectId), startedAt: DATE, taskId: null };
      run = { ...run, assignment };
      return Response.json({ assignment }, { status: 202 });
    }
    if (path === `${PATH}/${WORKFLOW}/runs/${RUN}/assignment/reconcile` && method === 'POST' && run?.assignment) {
      const assignment = { ...run.assignment, taskId: 'test-example' };
      run = { ...run, assignment };
      return Response.json({ assignment });
    }
    if (path === `${PATH}/${WORKFLOW}/runs/${RUN}/complete` && method === 'POST' && run) {
      run = { ...run, result: body, completedAt: DATE, outcome: body.outcome };
      const { assignment: _assignment, ...receipt } = run;
      return Response.json({ run: receipt });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  return { fetch, traffic };
}

function Address() {
  const { pathname, search } = useLocation();
  return <output hidden data-workflow-address>{pathname + search}</output>;
}

function mount(traffic: ReturnType<typeof fixture>, path = '/workflows', role: 'owner' | 'operator' | 'viewer' = 'operator', backupPreview?: true) {
  const member = '00000000-0000-4000-8000-000000000000';
  const runtime = createBrowserRuntime<unknown>({ mode: 'hosted', workspaceId: member, sessionId: member, principalId: member, clientGeneration: 1 }, {
    origin: location.origin, fetch: traffic.fetch, appRelease: createAppRelease(traffic.fetch, null), sendAnswer: async () => {},
  });
  runtimes.push(runtime);
  return render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: 'Fixture workspace', workspaceRole: role, backupPreview }}>
    <QueryClientProvider client={runtime.queries}><MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/workflows/:id?" element={<WorkflowsRoute />} /><Route path="/health/operations/:id?" element={<WorkflowsRoute surface="system" />} /></Routes>
      <Address />
    </MemoryRouter></QueryClientProvider>
  </BrowserRuntimeProvider>);
}

afterEach(() => { cleanup(); for (const runtime of runtimes.splice(0)) runtime.retire(); });

describe('customer analysis workflows', () => {
  it('creates a template with an explicit asset and weekly trigger, then keeps the cited result', async () => {
    const requests = fixture(false, true);
    const { container } = mount(requests);
    fireEvent.click(await screen.findByRole('button', { name: 'Create workflow' }));
    const form = screen.getByRole('form', { name: 'Create workflow' });
    expect(within(form).getByRole('button', { name: 'Save workflow' })).toBeDisabled();
    const asset = await within(form).findByRole('checkbox', { name: 'Meadow' });
    expect(within(form).queryByRole('checkbox', { name: 'Retired' })).toBeNull();
    fireEvent.click(asset);
    fireEvent.change(within(form).getByLabelText('Template'), { target: { value: 'seo-ai-visibility' } });
    fireEvent.change(within(form).getByLabelText('Workflow name *'), { target: { value: 'Discovery review' } });
    fireEvent.change(within(form).getByLabelText('Trigger'), { target: { value: 'weekly' } });
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: '4' } });
    fireEvent.change(within(form).getByLabelText('Time *'), { target: { value: '15:30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save workflow' }));
    expect(await screen.findByRole('heading', { name: 'Discovery review' })).toBeVisible();
    expect(requests.traffic.find(event => event.path === PATH && event.method === 'POST')).toMatchObject({ key: expect.any(String), body: {
      name: 'Discovery review', template: 'seo-ai-visibility', assetIds: [ASSET], trigger: { kind: 'weekly', weekday: 4, hour: 15, minute: 30, timeZone: 'Etc/UTC' },
    } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    const evidence = await screen.findByRole('region', { name: 'Run evidence' });
    const starts = requests.traffic.filter(event => event.path === `${PATH}/${WORKFLOW}/runs` && event.method === 'POST');
    expect(starts.map(event => event.key)).toEqual([expect.any(String), starts[0]?.key]);
    expect(evidence).toHaveTextContent(/Clicks\s*0/u);
    expect(within(evidence).getByRole('link', { name: 'Check background operations' })).toHaveAttribute('href', '/health/operations');
    expect(container.querySelector('[data-workflow-address]')).toHaveTextContent(`/workflows?workflow=${WORKFLOW}&run=${RUN}`);
    const assignment = screen.getByRole('region', { name: 'Analysis assignment' });
    const assign = await within(assignment).findByRole('button', { name: 'Assign analysis' });
    expect(assign).toBeDisabled();
    fireEvent.change(within(assignment).getByLabelText('Task project'), { target: { value: PROJECT } });
    fireEvent.click(assign);
    fireEvent.click(await within(assignment).findByRole('button', { name: 'Check assignment' }));
    expect(await within(assignment).findByRole('link', { name: 'View assigned task' })).toHaveAttribute('href', '/tasks/test-example');
    expect(requests.traffic.filter(event => event.path.endsWith('/assignment')).map(event => event.body)).toEqual([{ projectId: PROJECT }]);
    expect(requests.traffic.some(event => event.path.endsWith('/complete'))).toBe(false);
    const result = screen.getByRole('form', { name: 'Record result' });
    fireEvent.change(within(result).getByLabelText('Outcome *'), { target: { value: 'findings' } });
    fireEvent.change(within(result).getByLabelText('Summary *'), { target: { value: 'The report is ready for review.' } });
    fireEvent.change(within(result).getByLabelText('Title *'), { target: { value: 'Compare the empty first week' } });
    fireEvent.change(within(result).getByLabelText('Finding and next step *'), { target: { value: 'Check impressions for the same dates.' } });
    expect(within(result).getByRole('button', { name: 'Save result' })).toBeDisabled();
    fireEvent.click(within(result).getByRole('checkbox', { name: /Search clicks/u }));
    fireEvent.click(within(result).getByRole('button', { name: 'Save result' }));
    expect(await screen.findByRole('region', { name: 'Recorded result' })).toHaveTextContent('Compare the empty first week');
    expect(within(assignment).getByRole('link', { name: 'View assigned task' })).toHaveAttribute('href', '/tasks/test-example');
    expect(requests.traffic.find(event => event.path.endsWith('/complete'))?.body).toMatchObject({ outcome: 'findings', findings: [{ citationIds: ['gsc-1'] }] });
    expect(screen.queryByRole('form', { name: 'Record result' })).toBeNull();
  });

  it('lets a viewer open a saved workflow directly without exposing management actions', async () => {
    const requests = fixture(true);
    mount(requests, `/workflows?workflow=${WORKFLOW}`, 'viewer');
    expect(await screen.findByRole('region', { name: 'Runbook steps' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause workflow' })).toBeNull();
    expect(requests.traffic.some(event => event.method !== 'GET')).toBe(false);
  });

  it('records insufficient evidence without treating it as a failed run', async () => {
    const requests = fixture(true);
    mount(requests, `/workflows?workflow=${WORKFLOW}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Start run' }));
    const result = await screen.findByRole('form', { name: 'Record result' });
    fireEvent.change(within(result).getByLabelText('Outcome *'), { target: { value: 'insufficient-evidence' } });
    fireEvent.change(within(result).getByLabelText('Summary *'), { target: { value: 'Only one complete week was saved.' } });
    fireEvent.click(within(result).getByRole('button', { name: 'Save result' }));
    await screen.findByRole('region', { name: 'Recorded result' });
    expect(requests.traffic.find(event => event.path.endsWith('/complete'))?.body).toEqual({
      outcome: 'insufficient-evidence', summary: 'Only one complete week was saved.', findings: [],
    });
    expect(screen.queryByRole('button', { name: 'Retry run' })).toBeNull();
  });

  it.each([['/workflows', true], ['/health/operations', undefined], ['/workflows?activity=1', undefined]] as const)('keeps existing workflow operation routes outside the analysis API (%s)', async (path, preview) => {
    const requests = fixture(true);
    mount(requests, path, 'owner', preview);
    if (preview) await screen.findByRole('status');
    else await waitFor(() => expect(requests.traffic.some(event => event.path === '/api/workflows')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull();
    expect(requests.traffic.some(event => event.path.startsWith(PATH))).toBe(false);
    if (preview) expect(requests.traffic.some(event => event.path === '/api/workflows')).toBe(false);
  });
});
