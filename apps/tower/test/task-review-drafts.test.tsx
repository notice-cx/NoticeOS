import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { useTaskReviewDraft, type TaskReviewField } from '@/lib/task-review-drafts';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
function owner(over = {}) {
  const runtime = createBrowserRuntime({ mode: 'hosted', workspaceId: id, principalId: id, sessionId: id, clientGeneration: 1, ...over }, {
    origin: window.location.origin, fetch: vi.fn(), sendAnswer: async () => {},
  });
  runtimes.push(runtime);
  return runtime;
}
function wrapper(runtime: ReturnType<typeof owner>) {
  return function Owner({ children }: { children: ReactNode }) {
    return <BrowserRuntimeProvider value={{ runtime, workspaceLabel: null }}>{children}</BrowserRuntimeProvider>;
  };
}
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.retire(); });

it('retains separate project/task/field drafts across unmount and beyond normal query collection', async () => {
  const runtime = owner();
  const options = { wrapper: wrapper(runtime), initialProps: { project: 'project-a', task: 'tt-a', field: 'comment' as TaskReviewField } };
  const hook = renderHook(({ project, task, field }) => useTaskReviewDraft(project, task, field), options);
  act(() => hook.result.current.change('A comment'));
  await waitFor(() => expect(hook.result.current.text).toBe('A comment'));
  hook.rerender({ project: 'project-a', task: 'tt-a', field: 'done-evidence' });
  expect(hook.result.current.text).toBe('');
  act(() => hook.result.current.change('A evidence'));
  hook.rerender({ project: 'project-a', task: 'tt-b', field: 'comment' });
  expect(hook.result.current.text).toBe('');
  act(() => hook.result.current.change('B comment'));
  hook.rerender({ project: 'project-b', task: 'tt-a', field: 'comment' });
  expect(hook.result.current.text).toBe('');
  act(() => hook.result.current.change('Other project'));
  hook.unmount();
  const cached = runtime.queries.getQueryCache().find({ queryKey: ['task-review-draft', 'project-a', 'tt-a', 'comment'] });
  expect(cached?.gcTime).toBe(Infinity);
  const restored = renderHook(() => ({
    comment: useTaskReviewDraft('project-a', 'tt-a', 'comment'),
    evidence: useTaskReviewDraft('project-a', 'tt-a', 'done-evidence'),
    other: useTaskReviewDraft('project-b', 'tt-a', 'comment'),
  }), { wrapper: wrapper(runtime) });
  expect(restored.result.current.comment.text).toBe('A comment');
  expect(restored.result.current.evidence.text).toBe('A evidence');
  act(() => restored.result.current.comment.discard());
  await waitFor(() => expect(restored.result.current.comment.text).toBe(''));
  expect(restored.result.current.evidence.text).toBe('A evidence');
  expect(restored.result.current.other.text).toBe('Other project');
});

it.each(['comment', 'done-evidence'] as const)('%s clears only the submitted revision and retains failures without resending', async (field) => {
  const runtime = owner();
  const hook = renderHook(() => useTaskReviewDraft('project-a', 'tt-a', field), { wrapper: wrapper(runtime) });
  act(() => hook.result.current.change('note 1'));
  const first = hook.result.current.begin()!;
  expect(first.text).toBe('note 1');
  expect(hook.result.current.begin()).toBeNull();
  hook.unmount();
  const restored = renderHook(() => useTaskReviewDraft('project-a', 'tt-a', field), { wrapper: wrapper(runtime) });
  expect(restored.result.current.pending).toBe(true);
  expect(restored.result.current.begin()).toBeNull();
  // An identical replacement is a new revision, too.
  act(() => { restored.result.current.change('note 2'); restored.result.current.change('note 1'); first.settle(true); });
  await waitFor(() => expect(restored.result.current.pending).toBe(false));
  expect(restored.result.current.text).toBe('note 1');
  const failed = restored.result.current.begin()!;
  act(() => failed.settle(false));
  await waitFor(() => expect(restored.result.current.pending).toBe(false));
  expect(restored.result.current.text).toBe('note 1');
  const accepted = restored.result.current.begin()!;
  act(() => accepted.settle(true));
  await waitFor(() => expect(restored.result.current.text).toBe(''));
});

it.each([
  { clientGeneration: 2 }, { workspaceId: other }, { principalId: other }, { sessionId: other },
])('replacement owner %j cannot read old drafts or receive retired writes', async (identity) => {
  const a = owner();
  const hook = renderHook(() => useTaskReviewDraft('project', 'tt-a', 'comment'), { wrapper: wrapper(a) });
  act(() => hook.result.current.change('Private A'));
  const pending = hook.result.current.begin()!;
  const old = hook.result.current;
  hook.unmount();
  a.freeze();
  expect(old.change('Frozen write')).toBeUndefined();
  expect(pending.settle(true)).toBeUndefined();
  a.retire();
  const b = owner(identity);
  const current = renderHook(() => useTaskReviewDraft('project', 'tt-a', 'comment'), { wrapper: wrapper(b) });
  expect(current.result.current.text).toBe('');
  act(() => current.result.current.change('Private B'));
  act(() => { old.change('Late A'); old.discard(); pending.settle(true); });
  await waitFor(() => expect(current.result.current.text).toBe('Private B'));
  expect(a.queries.getQueryCache().getAll()).toHaveLength(0);
});

it.each(['comment', 'done-evidence'] as const)('%s discard followed by identical text survives the previous completion', async (field) => {
  const runtime = owner();
  const hook = renderHook(() => useTaskReviewDraft('project', 'tt-a', field), { wrapper: wrapper(runtime) });
  act(() => hook.result.current.change('Identical text'));
  const submitted = hook.result.current.begin()!;
  act(() => { hook.result.current.discard(); hook.result.current.change('Identical text'); submitted.settle(true); });
  await waitFor(() => expect(hook.result.current.pending).toBe(false));
  expect(hook.result.current.text).toBe('Identical text');
});
