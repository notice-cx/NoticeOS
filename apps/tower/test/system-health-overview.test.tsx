import { cleanup, render, screen } from './render';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceOverview } from '@/routes/health/ServiceOverview';
import { WORKFLOW_DEFINITIONS, type WorkflowsPayload } from '@shared/workflows';
import { integrationStatus, type IntegrationStatus } from '@shared/integration-status';
import { captureWorkflowOutput } from '../../../scripts/workflow-output.mjs';
import { stepResult } from '../../../scripts/workflow-trace.mjs';

const mock = vi.hoisted(() => ({ data: undefined as WorkflowsPayload | undefined, isError: false }));
vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: () => mock }));
// System health names the OS's own problems from the Wall's read (D45); these
// cases are about the workflow and connection reads, so the Wall has none.
const wall = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/hooks/useWall', () => ({ useWall: () => ({ data: wall.data, isError: false }) }));
vi.mock('@/hooks/useNow', () => ({ useNow: () => Date.parse('2026-09-09T12:00:00Z') }));
function mount(dataCurrent = true, integrations: IntegrationStatus = integrationStatus({ generatedAt: '2026-09-09T12:00:00Z', available: true, items: [], events: [] }, false, Date.parse('2026-09-09T12:00:00Z'))) {
  render(<MemoryRouter><ServiceOverview dataCurrent={dataCurrent} degraded={0} unverified={0} setup={0} integrations={integrations} /></MemoryRouter>);
}
beforeEach(() => {
  wall.data = undefined;
  mock.isError = false;
  mock.data = { generatedAt: '2026-09-09T12:00:00Z', overrides: null, runtimeFresh: true, observationsFresh: true, historyAvailable: true, selectedRun: null,
    runtime: { updatedAt: '2026-09-09T12:00:00Z', error: null, jobs: WORKFLOW_DEFINITIONS.map((job) => ({ id: job.id, cron: job.cron, enabled: true, nextRun: null })) },
    workflows: ['backup', 'notifications'].map((id) => ({ id, active: null, history: [], runs: [], latest: { id: `${id}@2026-09-09T11:59:00Z`, workflowId: id, definitionVersion: 1, startedAt: '2026-09-09T11:59:00Z', finishedAt: '2026-09-09T11:59:10Z', state: 'failed', steps: null } })),
  };
});
afterEach(cleanup);
describe('System Health status evidence', () => {
  it("names the OS's own problem first, in the words Home's Stopped card used (D45)", () => {
    // The OS sent no report: Home's brief says "OS report missing" and its
    // Look opens this page, which must say the same thing first.
    wall.data = { system: { assetId: 'os-root', hasPulse: false, spendTodayUsd: 0, dailyCapUsd: 2, ingest: { fresh: 0, stale: 0, notExpected: 0, expected: 0 }, scheduledLanes: [] } };
    mount();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('OS report missing');
  });

  it('links internal failures to their exact run and excludes operator workflows from the summary', () => {
    mount();
    // Only what happened: nothing is listed at zero.
    expect(screen.getByText('1 background operation failed')).toBeVisible();
    expect(screen.getByRole('link', { name: /Backups/ })).toHaveAttribute('href', '/health/operations/backup?run=backup%402026-09-09T11%3A59%3A00Z');
    expect(screen.queryByText('Operator notifications')).toBeNull();
  });
  it('does not infer a healthy service from stale cached success', () => {
    mock.data!.generatedAt = '2026-09-09T11:58:00Z';
    mount();
    expect(screen.getByRole('heading', { name: 'Current health is unconfirmed' })).toBeVisible();
    expect(screen.queryByText('Reporting')).toBeNull();
    expect(screen.queryByRole('link', { name: /Backups/ })).toBeNull();
  });
  it('handles an unavailable endpoint without asserting zero failures or hiding the operations entry', () => {
    mock.data = undefined; mock.isError = true;
    mount();
    expect(screen.getByRole('heading', { name: 'Current health is unconfirmed' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'View background operations' })).toBeVisible();
  });
  it('requires fresh connection evidence before reporting normal checks', () => {
    mock.data!.workflows = [];
    mount(false);
    expect(screen.getByRole('heading', { name: 'Current health is unconfirmed' })).toBeVisible();
  });
  it('cannot report normal checks when a known internal operation has no scheduler entry', () => {
    mock.data!.runtime!.jobs = mock.data!.runtime!.jobs.filter((job) => job.id !== 'backup');
    mock.data!.workflows = mock.data!.workflows.filter((job) => job.id === 'backup');
    mount();
    expect(screen.getByRole('heading', { name: 'Current health is unconfirmed' })).toBeVisible();
  });
  it('judges an installation whose runner runs no host lanes by the jobs it does run', () => {
    // An installation `pnpm start` runs (bead ro-ujb9.156): no backup or task
    // hub lanes, so their absence is neither a failure nor unconfirmed.
    const ingest = WORKFLOW_DEFINITIONS.filter((definition) => !definition.local);
    mock.data!.runtime = { ...mock.data!.runtime!, hostLanes: false, jobs: mock.data!.runtime!.jobs.filter((job) => ingest.some((definition) => definition.id === job.id)) };
    mock.data!.workflows = ingest.map((definition) => ({ id: definition.id, active: null, history: [], runs: [], latest: { id: `${definition.id}@latest`, workflowId: definition.id, definitionVersion: 1, startedAt: '2026-09-09T11:59:00Z', finishedAt: '2026-09-09T11:59:10Z', state: 'succeeded', steps: null } }));
    mount(true, { current: true, available: true, items: [], providers: [], attention: 0, failing: 0, unconfirmed: 0, working: 1, idle: 0, affectedAssets: [] });
    expect(screen.getByRole('heading', { name: 'Checks are reporting normally' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Backups/ })).toBeNull();
    expect(screen.getByText('Collection and service checks')).toBeVisible();
  });
  // Bead ro-ujb9.178: the footer names what installedWorkflows lists, so a
  // started installation that backs up or refreshes a task board says so.
  describe('the operations footer names what this installation runs', () => {
    const started = (local: string[]) => {
      const installed = WORKFLOW_DEFINITIONS.filter((definition) => !definition.local || local.includes(definition.id));
      mock.data!.runtime = { ...mock.data!.runtime!, hostLanes: false, jobs: mock.data!.runtime!.jobs.filter((job) => installed.some((definition) => definition.id === job.id)) };
    };
    it('a started installation with only collection jobs', () => {
      started([]);
      mount();
      expect(screen.getByText('Collection and service checks')).toBeVisible();
    });
    it('a started installation that backs up', () => {
      started(['backup']);
      mount();
      expect(screen.getByText('Collection, service checks and backups')).toBeVisible();
    });
    it('a started installation with a task project and backups', () => {
      started(['beads-snapshot', 'backup']);
      mount();
      expect(screen.getByText('Collection, service checks, task-board refreshes and backups')).toBeVisible();
    });
    it('the host installation, which runs every lane', () => {
      mount();
      expect(screen.getByText('Collection, service checks, task-board refreshes and backups')).toBeVisible();
    });
  });
  // Bead ro-ujb9.188: under launchd the unpublished-commit check can be refused
  // by a site's remote. That is on the screen, by site and reason, every run —
  // not one log line that falls silent after it.
  describe('sites the unpublished-commit check could not read', () => {
    const pushRun = (failed: { asset: string; reason: string }[]) => {
      const output = captureWorkflowOutput({ checked: 1, filed: [], closed: [], failed });
      mock.data!.workflows.push({ id: 'push-state', active: null, history: [], runs: [], latest: {
        id: 'push-state@2026-09-09T11:40:00.000Z', workflowId: 'push-state', definitionVersion: 1, startedAt: '2026-09-09T11:40:00.000Z', finishedAt: '2026-09-09T11:40:04.000Z',
        state: failed.length ? 'failed' : 'succeeded',
        steps: [{ id: 'execute', attempt: 1, startedAt: '2026-09-09T11:40:00.000Z', finishedAt: '2026-09-09T11:40:04.000Z', ...stepResult({ failed }), ...(output ? { output } : {}) }],
      } });
    };
    it('names each unread site and why, and opens that run', () => {
      pushRun([{ asset: 'nosh.example', reason: 'remote-sign-in-refused' }, { asset: 'fees.example', reason: 'remote-sign-in-refused' }]);
      mount();
      const row = screen.getByRole('link', { name: /Unpublished commit checks/ });
      expect(row).toHaveTextContent('Unknown · nosh.example, fees.example');
      expect(row).toHaveTextContent('Remote sign-in refused');
      expect(row).toHaveAttribute('href', '/workflows/push-state?run=push-state%402026-09-09T11%3A40%3A00.000Z');
    });
    it('counts sites past two and lists each reason once', () => {
      pushRun([
        { asset: 'nosh.example', reason: 'remote-sign-in-refused' },
        { asset: 'fees.example', reason: 'remote-unreachable' },
        { asset: 'meals.example', reason: 'remote-sign-in-refused' },
      ]);
      mount();
      const row = screen.getByRole('link', { name: /Unpublished commit checks/ });
      expect(row).toHaveTextContent('Unknown · 3 sites');
      expect(row).toHaveTextContent('Remote sign-in refused · Remote unreachable');
    });
    it('says nothing when every site was read, or when the history is unreadable', () => {
      pushRun([]);
      mount();
      expect(screen.queryByRole('link', { name: /Unpublished commit checks/ })).toBeNull();
      cleanup();
      mock.data!.workflows = mock.data!.workflows.filter((summary) => summary.id !== 'push-state');
      pushRun([{ asset: 'nosh.example', reason: 'remote-unreachable' }]);
      mock.data!.historyAvailable = false;
      mount();
      expect(screen.queryByRole('link', { name: /Unpublished commit checks/ })).toBeNull();
    });
  });
  it('cannot report normal checks from an empty operation inventory', () => {
    mock.data!.workflows = [];
    mount();
    expect(screen.getByRole('heading', { name: 'Current health is unconfirmed' })).toBeVisible();
  });
  it('makes a settings refresh failure visible even when the scheduler still reports', () => {
    mock.data!.runtime!.error = 'Refresh unavailable';
    mount();
    expect(screen.getByRole('heading', { name: 'Schedule settings need attention' })).toBeVisible();
    expect(screen.getByText('Previously confirmed schedules remain active')).toBeVisible();
  });
  it('reports live traffic failure even when every background job and daily data source succeeds', () => {
    mock.data!.workflows = WORKFLOW_DEFINITIONS.map((definition) => ({ id: definition.id, active: null, history: [], runs: [], latest: { id: `${definition.id}@latest`, workflowId: definition.id, definitionVersion: 1, startedAt: '2026-09-09T11:59:00Z', finishedAt: '2026-09-09T11:59:10Z', state: 'succeeded', steps: null } }));
    mount(true, { current: true, available: true, items: [], providers: [], attention: 1, failing: 1, unconfirmed: 0, working: 1, idle: 0, affectedAssets: ['meals.example'] });
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    expect(screen.getAllByText('1 connection needs attention')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Checks are reporting normally' })).toBeNull();
  });
});
