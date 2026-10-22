import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { TaskRoute } from '@/routes/TaskRoute';
import type { LiveTask, LiveTaskDetail } from '@shared/tasks';

const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: notices }));
vi.mock('@/hooks/useWork', () => ({ useWork: () => ({ data: undefined }) }));
vi.mock('@/hooks/useTaskSource', () => import('./task-source-mock'));
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
const comment = vi.fn(); const close = vi.fn();
const projects = [
  { projectId: '33333333-3333-4333-8333-333333333333', logicalKey: 'project-a', displayName: 'Project A', prefix: 'tt' },
  { projectId: '44444444-4444-4444-8444-444444444444', logicalKey: 'project-b', displayName: 'Project B', prefix: 'tt' },
];
function task(id: string): LiveTask {
  return { id, title: `Task ${id}`, status: 'in_progress', priority: 2, issueType: 'task', assignee: 'Example Operator',
    updatedAt: null, closedAt: null, parent: null, deferUntil: null, description: '', acceptance: '', labels: [], ready: true,
    dependencies: [], comments: 0, metadata: null, createdAt: null, startedAt: null, closeReason: null, awaitType: null };
}
function mount() {
  const runtime = createBrowserRuntime({ mode: 'standalone', clientGeneration: 1 }, {
    origin: window.location.origin, fetch: vi.fn(), sendAnswer: async () => {},
  });
  runtimes.push(runtime);
  const api = { ...runtime.api,
    fetchTasksCapabilities: async () => ({ live: true, reason: null, projectSelection: true }),
    fetchTaskProjects: async () => projects,
    fetchTask: async (id: string, _signal?: AbortSignal, project = 'project-a'): Promise<LiveTaskDetail> => ({
      project, prefix: 'tt', repo: '.', readAt: '2026-10-01T12:00:00Z', task: task(id), comments: [],
    }),
    fetchTasks: async (project: string) => ({ project, prefix: 'tt', repo: '.', readAt: '2026-10-01T12:00:00Z', tasks: [], epics: [] }),
    commentOnTask: comment, closeTask: close,
  };
  render(<BrowserRuntimeProvider value={{ runtime: { ...runtime, api }, workspaceLabel: null }}>
    <QueryClientProvider client={runtime.queries}><MemoryRouter initialEntries={['/tasks/tt-a?project=project-a']}>
      <nav><Link to="/tasks/tt-a?project=project-a">A</Link><Link to="/tasks/tt-b?project=project-a">B</Link>
        <Link to="/tasks/tt-a?project=project-b">Other project</Link><Link to="/other">Other page</Link></nav>
      <Routes><Route path="/tasks/:id" element={<TaskRoute />} /><Route path="/other" element={<p>Other page</p>} /></Routes>
    </MemoryRouter></QueryClientProvider>
  </BrowserRuntimeProvider>);
  return runtime;
}
const input = () => screen.getByRole('textbox', { name: 'Add a comment' });
async function visit(name: string) {
  fireEvent.click(screen.getByRole('link', { name }));
  if (name !== 'Other page') await screen.findByRole('textbox', { name: 'Add a comment' });
}
async function evidence() {
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  return screen.findByRole('textbox', { name: 'Close reason' });
}
beforeEach(() => { comment.mockReset().mockResolvedValue(undefined); close.mockReset().mockResolvedValue(undefined); vi.clearAllMocks(); });
afterEach(() => { cleanup(); for (const runtime of runtimes.splice(0)) runtime.retire(); });

it('restores both fields after other pages, direct tasks and colliding project ids; discards independently', async () => {
  mount(); await screen.findByRole('textbox', { name: 'Add a comment' });
  fireEvent.change(input(), { target: { value: 'A comment' } });
  fireEvent.change(await evidence(), { target: { value: 'A evidence' } });
  await visit('B'); expect(input()).toHaveValue('');
  fireEvent.change(input(), { target: { value: 'B comment' } });
  expect(await evidence()).toHaveValue('');
  await visit('A'); expect(input()).toHaveValue('A comment'); expect(await evidence()).toHaveValue('A evidence');
  await visit('Other project'); expect(input()).toHaveValue(''); expect(await evidence()).toHaveValue('');
  fireEvent.change(input(), { target: { value: 'Other project comment' } });
  await visit('Other page'); await visit('A');
  expect(input()).toHaveValue('A comment'); expect(await evidence()).toHaveValue('A evidence');
  fireEvent.click(screen.getByRole('button', { name: 'Discard comment' }));
  await waitFor(() => expect(input()).toHaveValue(''));
  expect(screen.getByRole('textbox', { name: 'Close reason' })).toHaveValue('A evidence');
  fireEvent.click(screen.getByRole('button', { name: 'Discard evidence' }));
  await visit('Other page'); await visit('A'); expect(await evidence()).toHaveValue('');
  await visit('B'); expect(input()).toHaveValue('B comment');
  await visit('Other project'); expect(input()).toHaveValue('Other project comment');
});

it('retains failed/ambiguous sends without retry and keeps text typed during a successful comment', async () => {
  comment.mockRejectedValueOnce(new Error('Delivery unknown'));
  mount(); await screen.findByRole('textbox', { name: 'Add a comment' });
  fireEvent.change(input(), { target: { value: 'note 1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(notices.error).toHaveBeenCalled());
  expect(input()).toHaveValue('note 1'); expect(comment).toHaveBeenCalledTimes(1);
  let resolve!: () => void;
  comment.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; }));
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(comment).toHaveBeenCalledTimes(2));
  fireEvent.change(input(), { target: { value: 'note 2' } });
  await visit('B'); await visit('A');
  expect(input()).toHaveValue('note 2');
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await act(async () => resolve());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled());
  expect(input()).toHaveValue('note 2');
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(input()).toHaveValue(''));
});

it('settles a close after unmount, preserves newer evidence and never changes another task', async () => {
  let resolve!: () => void;
  close.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; }));
  mount(); await screen.findByRole('textbox', { name: 'Add a comment' });
  fireEvent.change(await evidence(), { target: { value: 'Evidence 1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole('textbox', { name: 'Close reason' }), { target: { value: 'Evidence 2' } });
  await visit('B'); expect(await evidence()).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox', { name: 'Close reason' }), { target: { value: 'B evidence' } });
  await act(async () => resolve());
  expect(screen.getByRole('textbox', { name: 'Close reason' })).toHaveValue('B evidence');
  await visit('A'); expect(await evidence()).toHaveValue('Evidence 2');
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Close reason' })).toBeNull());
  expect(await evidence()).toHaveValue('');
});

it('retains refused close evidence, preserves it through other resolutions, and clears a confirmed close only', async () => {
  close.mockRejectedValueOnce(new Error('Close refused'));
  mount(); await screen.findByRole('textbox', { name: 'Add a comment' });
  fireEvent.change(input(), { target: { value: 'Separate comment' } });
  fireEvent.change(await evidence(), { target: { value: 'Required evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
  await waitFor(() => expect(notices.error).toHaveBeenCalled());
  expect(close).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox', { name: 'Close reason' })).toHaveValue('Required evidence');
  fireEvent.click(screen.getByRole('radio', { name: "Won't do" }));
  fireEvent.click(screen.getByRole('radio', { name: 'Done' }));
  expect(screen.getByRole('textbox', { name: 'Close reason' })).toHaveValue('Required evidence');
  await visit('Other page'); await visit('A');
  expect(await evidence()).toHaveValue('Required evidence');
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Close reason' })).toBeNull());
  expect(input()).toHaveValue('Separate comment');
  expect(await evidence()).toHaveValue('');
});

it('clears a confirmed comment after leaving its page without clearing another task', async () => {
  let resolve!: () => void;
  comment.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; }));
  mount(); await screen.findByRole('textbox', { name: 'Add a comment' });
  fireEvent.change(input(), { target: { value: 'Submitted A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(comment).toHaveBeenCalledTimes(1));
  await visit('B'); fireEvent.change(input(), { target: { value: 'Unsent B' } });
  await act(async () => resolve());
  expect(input()).toHaveValue('Unsent B');
  await visit('A'); expect(input()).toHaveValue('');
});
