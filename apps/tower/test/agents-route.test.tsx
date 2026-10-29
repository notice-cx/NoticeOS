import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readAgentStats } from '@noticeos/contract/agent-stats';
import { AgentsRoute } from '@/routes/AgentsRoute';
import { WorkerRows } from '@/routes/agents/agent-panels';

const state = vi.hoisted(() => ({ read: vi.fn(), view: 'overview' as import('@shared/views').ViewId }));
vi.mock('@/hooks/useView', () => ({ useView: () => ({ view: { id: state.view } }) }));
beforeEach(() => { state.view = 'overview'; });
vi.mock('@/hooks/useAgentWork', () => ({ useAgentWork: state.read }));
afterEach(cleanup);
const empty = () => ({ live: true, projects: 2, complete: true, pending: false, broken: [] as string[], failed: false, work: readAgentStats([], Date.parse('2026-10-15T12:00:00Z')) });

it('shows an honest empty activity state and links to task evidence', () => {
  state.read.mockReturnValue(empty());
  render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.getByText('0 tasks closed in 7 days')).toBeInTheDocument();
  expect(screen.getByText('No work in progress or closed in the last 7 days')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View tasks and close evidence →' })).toHaveAttribute('href', '/tasks');
  expect(screen.queryByText('Claims and closes')).not.toBeInTheDocument();
});

it('distinguishes a failed first read from an installation with no task projects', () => {
  state.read.mockReturnValue({ ...empty(), projects: 0, work: null, complete: false, failed: true });
  render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.getByText("Couldn't read any task project")).toBeInTheDocument();
});

it('qualifies partial figures and a failed refresh', () => {
  state.read.mockReturnValue({ ...empty(), broken: ['Example'], complete: false, failed: true });
  render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.getByText('1 project could not be read')).toBeInTheDocument();
  expect(screen.getByText("Couldn't refresh agent statistics")).toBeInTheDocument();
  expect(screen.getByText('Some projects could not be read')).toBeInTheDocument();
});

it('renders one compact statistics row per model without task or agent details', () => {
  render(<WorkerRows workers={[{ id: 'Other', name: 'Other', inHand: 2, blocked: 1, days: [0, 0, 0, 1, 0, 1, 1], week: 3, lastWeek: 0, medianHours: 2 }]} />);
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('rowheader', { name: 'Other' })).toBeInTheDocument();
  expect(screen.queryByText('no model named')).not.toBeInTheDocument();
  expect(screen.queryByText('Nothing in progress')).not.toBeInTheDocument();
});

it('prioritizes blocked work and keeps every chart and outcome evidence accessible', () => {
  const stats = empty();
  stats.work.blocked = 3;
  stats.work.inHand = 2;
  state.read.mockReturnValue(stats);
  const page = render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  state.view = 'reliability';
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.getByText('3 tasks blocked')).toBeInTheDocument();
  const panels = page.container.querySelector('[data-agent-section-order]')!;
  expect(panels.firstElementChild).toHaveAttribute('data-agent-rows');
  expect(screen.getByRole('region', { name: 'Velocity' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Ranking' })).toBeInTheDocument();
  state.view = 'revenue';
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.getByText('Agent cost and return are unmeasured')).toBeInTheDocument();
  expect(panels.firstElementChild).toHaveAttribute('data-agent-evidence');
  expect(screen.getByRole('link', { name: 'View recorded financials →' })).toHaveAttribute('href', '/financials');
  expect(screen.getByRole('link', { name: 'View tasks and close evidence →' })).toBeInTheDocument();
});
