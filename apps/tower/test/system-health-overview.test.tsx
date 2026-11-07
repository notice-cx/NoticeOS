import { cleanup, render, screen } from './render';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceOverview } from '@/routes/health/ServiceOverview';
import { WORKFLOW_DEFINITIONS, type WorkflowsPayload } from '@shared/workflows';
import { integrationStatus, type IntegrationStatus } from '@shared/integration-status';

const mock = vi.hoisted(() => ({ data: undefined as WorkflowsPayload | undefined, isError: false }));
vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: () => mock }));
// System health names the OS's own problems from the Wall's read; these cases
// are about the workflow and connection reads, so the Wall has none.
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
  it('links internal failures to their exact run and excludes operator workflows from the summary', () => {
    mount();
    expect(document.querySelectorAll('[aria-label="Failed background operations"] a')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Backups/ })).toHaveAttribute('href', '/health/operations/backup?run=backup%402026-09-09T11%3A59%3A00Z');
    expect(document.querySelector('a[href*="/notifications"]')).toBeNull();
  });
  it('does not infer a healthy service from stale cached success', () => {
    mock.data!.generatedAt = '2026-09-09T11:58:00Z';
    mount();
    expect(document.querySelector('[data-status-cells]')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Backups/ })).toBeNull();
  });
  it('handles an unavailable endpoint without asserting zero failures or hiding the operations entry', () => {
    mock.data = undefined; mock.isError = true;
    mount();
    expect(screen.getByRole('link', { name: 'View background operations' })).toHaveAttribute('href', '/health/operations');
  });
  it('judges an installation whose runner runs no host lanes by the jobs it does run', () => {
    // A runner without host lanes (the hosted scheduler): no backup or task hub lanes, so their
    // absence is neither a failure nor unconfirmed.
    const ingest = WORKFLOW_DEFINITIONS.filter((definition) => !definition.local);
    mock.data!.runtime = { ...mock.data!.runtime!, hostLanes: false, jobs: mock.data!.runtime!.jobs.filter((job) => ingest.some((definition) => definition.id === job.id)) };
    mock.data!.workflows = ingest.map((definition) => ({ id: definition.id, active: null, history: [], runs: [], latest: { id: `${definition.id}@latest`, workflowId: definition.id, definitionVersion: 1, startedAt: '2026-09-09T11:59:00Z', finishedAt: '2026-09-09T11:59:10Z', state: 'succeeded', steps: null } }));
    mount(true, { current: true, available: true, items: [], providers: [], attention: 0, failing: 0, unconfirmed: 0, working: 1, idle: 0, affectedAssets: [] });
    expect(document.querySelector('[data-status-cells]')).toBeNull();
    expect(screen.queryByRole('link', { name: /Backups/ })).toBeNull();
  });
  it('reports live traffic failure even when every background job and daily data source succeeds', () => {
    mock.data!.workflows = WORKFLOW_DEFINITIONS.map((definition) => ({ id: definition.id, active: null, history: [], runs: [], latest: { id: `${definition.id}@latest`, workflowId: definition.id, definitionVersion: 1, startedAt: '2026-09-09T11:59:00Z', finishedAt: '2026-09-09T11:59:10Z', state: 'succeeded', steps: null } }));
    mount(true, { current: true, available: true, items: [], providers: [], attention: 1, failing: 1, unconfirmed: 0, working: 1, idle: 0, affectedAssets: ['meadow.example'] });
    expect(document.querySelector('[data-status-cells] .text-error')).toBeVisible();
  });
});
