import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within, waitFor } from './render';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowsRoute from '@/routes/WorkflowsRoute';
import { WORKFLOW_DEFINITIONS, workflowState, type WorkflowsPayload, type WorkflowRun } from '@shared/workflows';
import { buildWorkflowHistory, createWorkflowHistoryReader, manualRecords } from '../vite/workflow-history';
import { readManualRuns } from '../vite/scheduled-jobs-lane';
import { WorkflowStages } from '@/components/WorkflowVisuals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('@/hooks/useConfigWritable', () => ({ useConfigWritable: () => ({ writable: true, reason: null }) }));
// Which sources are connected decides where a collection's schedule link goes
// (bead ro-ujb9.96.7.28). None, unless a test connects one.
const connections = vi.hoisted(() => ({ connected: [] as string[] }));
vi.mock('@/hooks/useConnections', () => ({
  useConnections: () => ({
    credentials: new Map(connections.connected.map((provider) => [provider, {
      provider, source: 'store', fields: [], assetsHeld: [], missingFields: [], auth: null, metadata: null, keyVersion: null,
      createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: '2026-09-09T12:00:00.000Z', lastError: null,
    }])),
    items: [],
  }),
}));
const now = Date.parse('2026-09-09T16:25:00.000Z');
const records = [
  { job: 'cron */15 * * * *', at: '2026-09-09T16:15:00.000Z', outcome: 'ran', ms: 500 },
  { job: 'backup', at: '2026-09-09T04:00:00.000Z', outcome: 'failed', ms: 1000 },
  { job: 'cron 10,30,50 * * * *', at: '2026-09-09T16:10:00.000Z', outcome: 'skipped', ms: 1 },
];
const trace: WorkflowRun = { id: 'counters@2026-09-09T16:15:00.000Z', workflowId: 'counters', definitionVersion: 1,
  startedAt: '2026-09-09T16:15:00.000Z', finishedAt: '2026-09-09T16:15:00.500Z', state: 'failed', steps: [
    { id: 'config', attempt: 1, startedAt: '2026-09-09T16:15:00.000Z', finishedAt: '2026-09-09T16:15:00.010Z', state: 'succeeded' },
    { id: 'google', attempt: 1, startedAt: '2026-09-09T16:15:00.010Z', finishedAt: '2026-09-09T16:15:00.500Z', state: 'failed', summary: 'One collection failed.' },
  ] };
let client: QueryClient;
let data: WorkflowsPayload;
function mount(url = '/health/operations') {
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><Routes><Route path="/health/operations/:id?" element={<WorkflowsRoute surface="system" />} /><Route path="/workflows/:id?" element={<WorkflowsRoute />} /></Routes></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  connections.connected = [];
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  data = { overrides: null, runtimeFresh: true, observationsFresh: true, generatedAt: new Date(now).toISOString(), historyAvailable: true,
    runtime: { updatedAt: new Date(now).toISOString(), error: null, jobs: WORKFLOW_DEFINITIONS.map((w) => ({ id: w.id, enabled: true, cron: w.cron, nextRun: '2026-09-10T04:00:00Z' })) },
    ...buildWorkflowHistory(records, [trace], [], now) };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const selected = new URL(url, 'http://localhost').searchParams.get('run');
    return new Response(JSON.stringify({ ...data, selectedRun: selected === trace.id ? trace : selected ? data.workflows.flatMap((w) => w.runs).find((r) => r.id === selected) ?? null : null }));
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('workflow operating surface', () => {
  it('reserves Workflows for intentional operator automations and scopes the counts and categories', async () => {
    mount('/workflows');
    expect(await screen.findByRole('link', { name: 'Search review tasks' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Operator notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Task board refresh' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Business signals' })).toBeNull();
    expect(screen.getByText(/5 of 5 workflows/)).toBeInTheDocument();
  });
  it('preserves legacy execution links when an operation moves to System Health', async () => {
    mount(`/workflows/counters?run=${encodeURIComponent(trace.id)}`);
    expect(await screen.findByRole('complementary', { name: 'Stage details' })).toHaveTextContent('One collection failed.');
    expect(screen.getByRole('link', { name: 'Background operations' })).toHaveAttribute('href', '/health/operations');
  });
  it('names each row by its label and provider, latest run first, and re-sorts by what needs attention', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'System health' })).toBeInTheDocument();
    const links = await screen.findAllByRole('link', { name: /Backups|Live traffic and counters/ });
    expect(links[0]).toHaveTextContent('Live traffic and counters');
    expect(screen.getByRole('link', { name: '10 minutes ago' })).toHaveAttribute('title', 'Wed, Sep 9, 16:15 UTC');
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort operations' }), { target: { value: 'attention' } });
    expect(screen.getAllByRole('link', { name: /Backups|Live traffic and counters/ })[0]).toHaveTextContent('Backups');
    // No row or group needs a description (bead ro-ujb9.96.9): the label, the
    // provider where the label does not name it, and the row's state are the answer.
    expect(screen.getByRole('link', { name: 'Search accessibility checks' }).parentElement).toHaveTextContent(/^Search accessibility checks$/);
    expect(screen.getByRole('link', { name: 'Product analytics archives' }).parentElement).toHaveTextContent(/^Product analytics archivesPostHog$/);
    expect(screen.getByRole('heading', { name: /^Business signals/ }).parentElement?.querySelector('p')).toBeNull();
  });
  // Split from the case above (bead ro-ujb9.106): one mount and seven re-renders
  // of the whole list took 5.7 s on a busy machine, past vitest's 5 s limit.
  it('filters by provider search and by state, including inactive workflows', async () => {
    mount();
    fireEvent.change(await screen.findByPlaceholderText('Search operations…'), { target: { value: 'posthog' } });
    expect(screen.getByRole('link', { name: 'Product analytics archives' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search operations…'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Operation state'), { target: { value: 'failed' } });
    expect(screen.getByRole('link', { name: 'Backups' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ad revenue' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Operation state'), { target: { value: 'inactive' } });
    expect(screen.getByRole('link', { name: 'Ad revenue' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
  });
  it('restores sorting from the URL and orders upcoming executions before unscheduled ones', async () => {
    data.runtime!.jobs.find((job) => job.id === 'backup')!.nextRun = '2026-09-09T17:00:00Z';
    data.runtime!.jobs.find((job) => job.id === 'counters')!.enabled = false;
    mount('/health/operations?sort=next');
    expect(await screen.findByRole('combobox', { name: 'Sort operations' })).toHaveValue('next');
    expect((await screen.findAllByRole('link', { name: /Backups|Live traffic and counters/ }))[0]).toHaveTextContent('Backups');
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort operations' }), { target: { value: 'name' } });
    expect(screen.getAllByRole('link', { name: /Ad revenue|Backups/ })[0]).toHaveTextContent('Ad revenue');
  });
  it('groups by operational purpose and allows a flat view without changing sort', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: /Business signals/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /System maintenance/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Business signals' })).toHaveTextContent('1 failed');
    fireEvent.change(screen.getByRole('combobox', { name: 'Group operations' }), { target: { value: 'flat' } });
    expect(screen.queryByRole('heading', { name: /Business signals/ })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Sort operations' })).toHaveValue('latest');
    fireEvent.change(screen.getByRole('combobox', { name: 'Operation category' }), { target: { value: 'Site health' } });
    expect(screen.getByRole('link', { name: 'Search accessibility checks' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
  });
  it('does not show stale runtime as active or successful current operation', async () => {
    data.runtimeFresh = false;
    mount();
    expect(await screen.findByText(/Live operation is unconfirmed/)).toBeInTheDocument();
    expect(screen.getAllByText('Unconfirmed')).toHaveLength(15);
    expect(screen.getAllByText('Unknown')).toHaveLength(15);
  });
  it('lists only the ingest’s jobs for an installation whose runner runs no host lanes', async () => {
    // An installation `pnpm start` runs (bead ro-ujb9.156): no task hub, push
    // state or offsite backup, so none of them is listed or counted unconfirmed.
    const ingest = WORKFLOW_DEFINITIONS.filter((w) => !w.local);
    data.runtime = { ...data.runtime!, hostLanes: false, jobs: data.runtime!.jobs.filter((job) => ingest.some((w) => w.id === job.id)) };
    mount();
    expect(await screen.findByRole('link', { name: 'Live traffic and counters' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Task board refresh' })).toBeNull();
    expect(screen.queryByText('Unknown')).toBeNull();
    const system = ingest.filter((w) => w.surface === 'system').length;
    expect(screen.getByText(new RegExp(`${system} of ${system} operations`))).toBeInTheDocument();
  });
  it('lists a host lane such an installation has set up, and no other', async () => {
    // A started installation with a task project saved runs its task board
    // refresh (bead ro-ujb9.174); with no offsite folder named it runs no backup.
    const listed = WORKFLOW_DEFINITIONS.filter((w) => !w.local || w.id === 'beads-snapshot');
    data.runtime = { ...data.runtime!, hostLanes: false, jobs: data.runtime!.jobs.filter((job) => listed.some((w) => w.id === job.id)) };
    mount();
    expect(await screen.findByRole('link', { name: 'Task board refresh' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Task service health' })).toBeNull();
    const system = listed.filter((w) => w.surface === 'system').length;
    expect(screen.getByText(new RegExp(`${system} of ${system} operations`))).toBeInTheDocument();
  });
  it('shows a pending save while retaining the runner-confirmed next execution', async () => {
    data.overrides = { backup: { enabled: false, cron: '0 4 * * *' } };
    mount();
    expect(await screen.findByText('Saved change pending')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Backups' })).toBeInTheDocument();
  });
  it('searches a workflow’s keywords and provider, not only its name', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Search operations'), { target: { value: 'robots' } });
    expect(screen.getByRole('link', { name: 'Search accessibility checks' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull();
  });
  it('renders a confirmed schedule timeline with neutral future executions', async () => {
    mount('/health/operations/schedule');
    expect(await screen.findByText(/Next 24 hours/)).toBeInTheDocument();
    expect(screen.getByLabelText('Backups: next 24 hours')).toBeInTheDocument();
  });
  it('opens a failed step with real evidence and retains the requested run', async () => {
    mount(`/health/operations/counters?run=${encodeURIComponent(trace.id)}`);
    const details = await screen.findByRole('complementary', { name: 'Stage details' });
    expect(within(details).getByRole('heading', { level: 3 })).toHaveTextContent('Refresh Google signals');
    expect(within(details).getByText('One collection failed.')).toBeInTheDocument();
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load collection settings/ }));
    expect(within(details).getByRole('heading', { level: 3 })).toHaveTextContent('Load collection settings');
    // A collection's schedule has ONE editor, in Settings → Data collection
    // (bead ro-ujb9.96.7.12): this page keeps the runner's view and links there.
    expect(screen.getByRole('link', { name: 'Edit in Settings' })).toHaveAttribute('href', '/settings#data-collection');
    expect(screen.queryByRole('button', { name: 'Edit schedule' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Live traffic and counters schedule' })).toBeNull();
  });
  it.each(['current hosted', 'legacy'] as const)('labels a %s run with no definition version without inferring its age', async (kind) => {
    const run: WorkflowRun = { ...trace, definitionVersion: null,
      ...(kind === 'legacy' ? { id: 'legacy-counters', startedAt: '2026-08-01T16:15:00.000Z',
        finishedAt: '2026-08-01T16:15:00.500Z', steps: null } : {}),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...data, selectedRun: run }))));
    mount(`/health/operations/counters?run=${encodeURIComponent(run.id)}`);
    expect(await screen.findByText('Version unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Earlier execution')).toBeNull();
    expect(document.querySelector(`time[datetime="${run.startedAt}"]`)).toBeInTheDocument();
    if (kind === 'current hosted') expect(screen.getByText('One collection failed.')).toBeInTheDocument();
    else expect(screen.getAllByText('Not observed').length).toBeGreaterThan(0);
  });
  // Bead ro-ujb9.96.7.28: a collection a connection feeds is changed on that
  // connection's Manage panel, so its page links there — to a connected
  // source's panel, or nowhere while none of its sources is connected.
  it("links a connection-fed collection to its source's Manage panel, and nowhere with nothing connected", async () => {
    connections.connected = ['bing-webmaster'];
    const first = mount('/health/operations/signal-dumps');
    expect(await screen.findByRole('link', { name: 'Edit in Integrations' })).toHaveAttribute('href', '/integrations?connect=bing-webmaster');
    expect(screen.queryByRole('link', { name: 'Edit in Settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit schedule' })).toBeNull();
    first.unmount();

    connections.connected = [];
    mount('/health/operations/signal-dumps');
    expect(await screen.findByRole('heading', { name: 'Traffic and search archives' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Edit in / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit schedule' })).toBeNull();
  });
  it("keeps every other job's one schedule editor where the job runs", async () => {
    mount('/health/operations/backup');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));
    expect(screen.getByRole('form', { name: 'Backups schedule' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit in Settings' })).toBeNull();
  });
  it('marks legacy stage detail unavailable and does not manufacture green nodes', () => {
    render(<WorkflowStages definition={WORKFLOW_DEFINITIONS.find((w) => w.id === 'backup')!} run={{ ...trace, workflowId: 'backup', state: 'succeeded', steps: null }} />);
    // Every stage says it for itself — no paragraph above the diagram.
    expect(screen.queryByText(/Step details unavailable/)).toBeNull();
    expect(screen.getAllByText('Not observed')).toHaveLength(2);
    expect(screen.queryByText('Succeeded')).toBeNull();
  });
  it('keeps an unavailable deep-linked run distinct from the latest run', async () => {
    mount('/health/operations/backup?run=not-retained');
    expect(await screen.findByText(/not in the retained execution history/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Run' })).toHaveValue('not-retained');
  });
  it('shows an uncertain hosted attempt as Unknown in the run picker', async () => {
    const summary = data.workflows.find((workflow) => workflow.id === 'counters')!;
    summary.runs[0] = { ...summary.runs[0]!, state: 'unknown' };
    mount('/health/operations/counters');
    expect(await screen.findByRole('option', { name: / · Unknown$/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: / · Skipped$/ })).toBeNull();
  });
  it('keeps navigation while a new run loads without displaying the previous run evidence', async () => {
    const nextRun = { ...trace, id: 'counters@2026-09-09T16:00:00.000Z', startedAt: '2026-09-09T16:00:00.000Z', steps: null };
    data.workflows.find((w) => w.id === 'counters')!.runs.push(nextRun);
    let release: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const requested = new URL(url, 'http://localhost').searchParams.get('run');
      if (requested === nextRun.id) return new Promise<Response>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ ...data, selectedRun: trace }));
    }));
    mount(`/health/operations/counters?run=${encodeURIComponent(trace.id)}`);
    expect(await screen.findByText('One collection failed.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Run' }), { target: { value: nextRun.id } });
    expect(await screen.findByText('Loading execution…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit in Settings' })).toBeInTheDocument();
    expect(screen.queryByText('One collection failed.')).toBeNull();
    release(new Response(JSON.stringify({ ...data, selectedRun: nextRun })));
    await waitFor(() => expect(screen.queryByText('Loading execution…')).toBeNull());
    expect(screen.getAllByText('Not observed').length).toBeGreaterThan(0);
  });
});

describe('workflow history evidence', () => {
  it('joins step failures to the correct original dispatch identity, preserving legacy absence', () => {
    const result = buildWorkflowHistory(records, [trace], [], now, trace.id);
    expect(result.workflows.find((w) => w.id === 'counters')?.latest?.state).toBe('failed');
    expect(result.workflows.find((w) => w.id === 'backup')?.latest?.steps).toBeNull();
    expect(result.selectedRun?.steps?.[1]?.state).toBe('failed');
    expect(result.workflows.find((w) => w.id === 'counters')?.history.at(-1)?.failed).toBe(1);
  });
  it('rejects malformed, future and unknown records instead of turning them green', () => {
    const result = buildWorkflowHistory([{ ...records[0], outcome: 'unknown' }, { ...records[0], at: '2027-01-01' }, { ...records[0], ms: -1 }, { ...records[0], job: 'not-a-workflow' }], [], [], now);
    expect(result.workflows.every((w) => w.latest === null)).toBe(true);
  });
  it('keeps the retained verdict when rich steps expire and suppresses completed active snapshots', () => {
    const result = buildWorkflowHistory([{ ...records[0], workflowState: 'failed' }], [], [{ ...trace, state: 'running', finishedAt: undefined }], now, trace.id);
    expect(result.selectedRun?.state).toBe('failed');
    expect(result.selectedRun?.steps).toBeNull();
    expect(result.workflows.find((w) => w.id === 'counters')?.active).toBeNull();
    const skipped = buildWorkflowHistory([{ ...records[0], workflowState: 'skipped' }], [], [], now, trace.id);
    expect(skipped.selectedRun?.state).toBe('skipped');
  });
  it('retains observed failures when the coarse ledger append is missing', () => {
    const result = buildWorkflowHistory([], [trace], [], now, trace.id);
    expect(result.workflows.find((w) => w.id === 'counters')?.latest?.state).toBe('failed');
    expect(result.selectedRun?.id).toBe(trace.id);
  });
  it('drops malformed output without losing valid step and failure evidence', () => {
    const unsafe = { ...trace, rawResponse: 'private response', steps: trace.steps!.map((step) => ({ ...step, rawResponse: 'private response', output: { version: 1, metrics: [], fields: [], items: [], totalItems: 0, truncated: false, rawResponse: 'private response' } })) };
    const result = buildWorkflowHistory(records, [unsafe], [], now, trace.id);
    expect(result.selectedRun?.state).toBe('failed');
    expect(result.selectedRun?.steps?.[1]?.state).toBe('failed');
    expect(result.selectedRun?.steps?.[0]?.output).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private response');
  });
  it('distinguishes a confirmed pause, a never-run job and missing evidence', () => {
    const summary = data.workflows.find((w) => w.id === 'freshness')!;
    expect(workflowState(summary, data)).toBe('never');
    data.runtime!.jobs.find((w) => w.id === 'freshness')!.enabled = false;
    expect(workflowState(summary, data)).toBe('paused');
    expect(workflowState(summary, { ...data, historyAvailable: false })).toBe('unknown');
  });
  it('does not revive an active run from an earlier runner process', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-reader-'));
    try {
      await mkdir(path.join(dir, '.local/logs'), { recursive: true });
      await writeFile(path.join(dir, '.local/logs/job-runs.jsonl'), '');
      await writeFile(path.join(dir, '.local/workflow-active.json'), JSON.stringify({ sessionId: 'old-runner', updatedAt: new Date(now).toISOString(), runs: [{ ...trace, state: 'running', finishedAt: undefined }] }));
      const read = createWorkflowHistoryReader(dir);
      expect((await read(now, undefined, 'new-runner')).workflows.every((w) => !w.active)).toBe(true);
      expect((await read(now, undefined, 'old-runner')).workflows.find((w) => w.id === 'counters')?.active?.state).toBe('running');
      expect((await read(now + 45_000, undefined, 'old-runner')).workflows.every((w) => !w.active)).toBe(true);
      expect((await read(now + 45_000, undefined, 'old-runner')).observationsFresh).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // Bead ro-ujb9.96.7.19: the connect panel's Start collecting runs the pull
  // job's Bing step inside the ingest, which records it in job_runs marked
  // manual; this is that record as GET /api/job-runs?trigger=manual answers it.
  const pressed = { job: 'cron 30 2 * * *', startedAt: '2026-09-09T15:00:00.000Z', finishedAt: '2026-09-09T15:00:02.000Z', outcome: 'ran' };
  it("lists a Start collecting press once in its job's run history, marked manual, beside the scheduler's runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-reader-'));
    try {
      await mkdir(path.join(dir, '.local/logs'), { recursive: true });
      await writeFile(path.join(dir, '.local/logs/job-runs.jsonl'), `${JSON.stringify({ job: 'cron 30 2 * * *', at: '2026-09-09T02:30:00.000Z', outcome: 'ran', ms: 900 })}\n`);
      const read = createWorkflowHistoryReader(dir, async () => [pressed]);
      const pull = (await read(now)).workflows.find((w) => w.id === 'pull')!;
      expect(pull.runs.map((run) => [run.startedAt, run.state, run.trigger?.kind ?? 'schedule'])).toEqual([
        ['2026-09-09T15:00:00.000Z', 'succeeded', 'manual'],
        ['2026-09-09T02:30:00.000Z', 'succeeded', 'schedule'],
      ]);
      expect(pull.latest?.trigger).toEqual({ kind: 'manual' });
      expect(pull.latest?.finishedAt).toBe('2026-09-09T15:00:02.000Z');
      // A read that fails leaves the runner's own history exactly as it was.
      const failing = createWorkflowHistoryReader(dir, async () => { throw new Error('door down'); });
      expect((await failing(now)).workflows.find((w) => w.id === 'pull')!.runs.map((run) => run.trigger)).toEqual([undefined]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reads the manual runs through the operator door, and any other answer as none', async () => {
    const request = vi.fn(async () => ({ status: 200, body: { runs: [pressed] } }));
    expect(await readManualRuns(request)).toEqual([pressed]);
    expect(request).toHaveBeenCalledWith('api/job-runs', expect.objectContaining({ params: { trigger: 'manual' } }));
    expect(await readManualRuns(async () => ({ status: 401, body: { error: 'unauthorized' } }))).toEqual([]);
    // A malformed or impossible record is dropped rather than drawn.
    expect(manualRecords([{ ...pressed, finishedAt: '2026-09-09T14:00:00.000Z' }, { job: 7 }, null])).toEqual([]);
  });
  it('marks a manual run on its row and in the run picker', async () => {
    data = { ...data, ...buildWorkflowHistory([...records, ...manualRecords([pressed])], [trace], [], now) };
    mount('/health/operations/pull');
    const recent = await screen.findByRole('region', { name: 'Recent runs' });
    expect(within(recent).getByText('Manual')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /· Manual$/ })).toBeInTheDocument();
  });
});
