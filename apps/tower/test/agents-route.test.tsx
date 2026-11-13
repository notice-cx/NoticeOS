import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readAgentStats, type ModelStats } from '@noticeos/contract/agent-stats';
import { AgentsRoute } from '@/routes/AgentsRoute';
import { WorkerRows } from '@/routes/agents/agent-panels';

const state = vi.hoisted(() => ({ read: vi.fn(), view: 'overview' as import('@shared/views').ViewId, needsNtasks: false }));
vi.mock('@/hooks/useView', () => ({ useView: () => ({ view: { id: state.view } }) }));
beforeEach(() => { state.view = 'overview'; state.needsNtasks = false; });
vi.mock('@/hooks/useAgentWork', () => ({ useAgentWork: state.read }));
vi.mock('@/hooks/useTaskService', () => ({ useNeedsNtasks: () => state.needsNtasks }));
afterEach(cleanup);
const empty = () => ({ live: true, projects: 2, complete: true, pending: false, broken: [] as string[], failed: false, work: readAgentStats([], Date.parse('2026-10-15T12:00:00Z')) });
const row = (over: Partial<ModelStats> = {}): ModelStats => ({ id: 'Other', name: 'Other', inHand: 2, blocked: 1, days: [0, 0, 0, 1, 0, 1, 1], week: 3, lastWeek: 0, medianHours: 2, shipped: null, ...over });

it('directs an installation without Ntasks to its task-project settings', () => {
  state.read.mockReturnValue({ ...empty(), work: null, failed: true });
  state.needsNtasks = true;
  function SettingsLocation() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
  render(<MemoryRouter initialEntries={['/agents']}><Routes>
    <Route path="/agents" element={<AgentsRoute />} />
    <Route path="/settings/*" element={<SettingsLocation />} />
  </Routes></MemoryRouter>);
  expect(screen.queryByText("Couldn't read any task project")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Go to Task projects →' }));
  expect(screen.getByRole('status')).toHaveTextContent('/settings/task-projects');
});

it('shows empty activity once and keeps the task action without empty model panels', () => {
  state.read.mockReturnValue(empty());
  render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.queryByRole('region', { name: 'Velocity' })).not.toBeInTheDocument();
  expect(document.querySelector('[data-agent-rows]')).toBeNull();
  expect(screen.getByRole('link', { name: 'Review tasks →' })).toHaveAttribute('href', '/tasks');
});

it('qualifies partial figures and a failed refresh', () => {
  state.read.mockReturnValue({ ...empty(), broken: ['Example'], complete: false, failed: true });
  render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(document.querySelector('[data-status-for="agents:projects"]')).toHaveTextContent('Example');
  expect(document.querySelector('[data-status-for="agents:refresh"]')).toBeVisible();
});

it('renders one compact statistics row per model without task or agent details', () => {
  render(<WorkerRows workers={[row()]} />);
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('rowheader', { name: 'Other' })).toBeInTheDocument();
});

it("shows each model's changes shipped only where merges are recorded", () => {
  const { shipped: _shipped, ...older } = row();
  const page = render(<WorkerRows workers={[row(), older as ModelStats]} />);
  expect(screen.getAllByRole('columnheader')).toHaveLength(5);
  page.rerender(<WorkerRows workers={[row({ shipped: 4 }), row({ id: 'GPT-6.1 Sol', name: 'GPT-6.1 Sol', shipped: 0 }), row({ id: 'o3 mini', name: 'o3 mini' })]} />);
  const [, first, second, third] = screen.getAllByRole('row');
  expect(screen.getAllByRole('columnheader')).toHaveLength(6);
  expect(within(first!).getAllByRole('cell')[0]).toHaveTextContent('4');
  expect(within(second!).getAllByRole('cell')[0]).toHaveTextContent('0');
  // Not measured is not zero.
  expect(within(third!).getAllByRole('cell')[0]).not.toHaveTextContent(/\d/u);
});

it('leads with changes shipped against the 7 days before, and falls back to tasks closed without merges', () => {
  const stats = empty();
  stats.work = { ...stats.work, week: 12, lastWeek: 4, shipped: 3, shippedLastWeek: 1 };
  state.read.mockReturnValue(stats);
  const page = render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  const answer = () => page.container.querySelector('[data-agents-answer]')!;
  expect(answer()).toHaveTextContent(/^3 /u);
  expect(answer()).toHaveTextContent('(1)');
  state.view = 'delivery';
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(answer().querySelector('[data-agents-shipped]')).toHaveTextContent('3');
  // An Ntasks older than the shipped counts answers none of them.
  const { shipped: _shipped, shippedLastWeek: _before, ...older } = stats.work;
  state.read.mockReturnValue({ ...stats, work: older });
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(answer().querySelector('[data-agents-shipped]')).toBeNull();
  expect(answer().querySelector('[data-agents-closed]')).toHaveTextContent('12');
  state.view = 'overview';
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(answer()).toHaveTextContent(/^12 /u);
  expect(answer()).toHaveTextContent('(4)');
});

it('prioritizes blocked work and keeps every chart and outcome evidence accessible', () => {
  const stats = empty();
  stats.work.blocked = 3;
  stats.work.inHand = 2;
  stats.work.workers = [row({ id: 'Claude Opus 5.5', name: 'Claude Opus 5.5', blocked: 1 }), row({ blocked: 3 })];
  stats.work.velocity.weeks[0]!.total = 1;
  stats.work.velocity.weeks[0]!.counts = { Other: 1 };
  stats.work.velocity.keys = ['Other'];
  stats.work.velocity.names = { Other: 'Other' };
  state.read.mockReturnValue(stats);
  const page = render(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  state.view = 'reliability';
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  const panels = page.container.querySelector('[data-agent-section-order]')!;
  expect(panels.firstElementChild).toHaveAttribute('data-agent-rows');
  // Rows keep name order, Other last, whatever each has blocked.
  expect([...panels.querySelectorAll('[data-agent-row]')].map(row => row.getAttribute('data-agent-row'))).toEqual(['Claude Opus 5.5', 'Other']);
  expect(screen.getByRole('region', { name: 'Velocity' })).toBeInTheDocument();
  state.view = 'revenue';
  page.rerender(<MemoryRouter><AgentsRoute /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'View recorded financials →' })).toHaveAttribute('href', '/financials');
});
