import { describe, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from '@/lib/browser-runtime';
import { taskCatalogProjects, readTaskBoard } from '@/lib/task-board-read';

const a = { mode: 'hosted', principalId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333', clientGeneration: 1 };
const b = { ...a, workspaceId: '44444444-4444-4444-8444-444444444444' };
const projectA = '55555555-5555-4555-8555-555555555555', projectB = '66666666-6666-4666-8666-666666666666';
const origin = 'https://desk.example';
function fixture() {
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/tasks/projects') {
      const workspace = new Headers(init?.headers).get('x-noticeos-workspace-id');
      return Response.json({ projects: [{ projectId: workspace === a.workspaceId ? projectA : projectB, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }] });
    }
    return Response.json({ task: 'tt-collision', project: 'example' });
  });
  const runtime = (owner: unknown) => createBrowserRuntime(owner, { origin, fetch: transport, sendAnswer: async () => {} });
  return { transport, runtime };
}
describe('hosted Tasks transport', () => {
  it('colliding logical project/task IDs select only each immutable owner catalog', async () => {
    const f = fixture(), first = f.runtime(a), second = f.runtime(b);
    try {
      await first.api.fetchTask('tt-collision', undefined, 'example');
      await second.api.fetchTask('tt-collision', undefined, 'example');
      await first.api.commentOnTask('tt-collision', '--file=literal comment', 'example');
      const reads = f.transport.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/tasks/tt-collision');
      expect(new URL(String(reads[0]?.[0])).searchParams.get('project')).toBe(projectA);
      expect(new URL(String(reads[1]?.[0])).searchParams.get('project')).toBe(projectB);
      const write = f.transport.mock.calls.at(-1);
      expect(JSON.parse(String(write?.[1]?.body))).toEqual({ projectId: projectA, text: '--file=literal comment' });
      expect(new Headers(write?.[1]?.headers).get('x-noticeos-session-id')).toBe(a.sessionId);
      expect(f.transport.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/tasks/projects')).toHaveLength(2);
    } finally { first.retire(); second.retire(); }
  });
  it('missing and foreign logical selectors dispatch no task command and never infer a prefix', async () => {
    const f = fixture(), runtime = f.runtime(a);
    try {
      await expect(runtime.api.fetchTask('tt-collision')).rejects.toThrow('Choose a task project');
      expect(f.transport).not.toHaveBeenCalled();
      await expect(runtime.api.fetchTask('tt-collision', undefined, 'foreign')).rejects.toThrow('Task project is unavailable');
      expect(f.transport.mock.calls).toHaveLength(1);
      await expect(runtime.api.updateTask('tt-collision', { title: 'Owned edit' }, 'foreign')).rejects.toThrow();
      expect(f.transport.mock.calls).toHaveLength(1);
    } finally { runtime.retire(); }
  });
  it('normalizes only project selection and empty default labels, preserving explicit task fields', async () => {
    const f = fixture(), runtime = f.runtime(a);
    try {
      await runtime.api.createTask({ project: 'example', title: '--database=literal title', labels: [] });
      expect(JSON.parse(String(f.transport.mock.calls.at(-1)?.[1]?.body))).toEqual({ projectId: projectA, title: '--database=literal title' });
      await runtime.api.createTask({ project: 'example', title: 'Linked work', labels: ['owned-label'], metadata: { noticeos_kind: 'finding' } });
      expect(JSON.parse(String(f.transport.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ labels: ['owned-label'], metadata: { noticeos_kind: 'finding' } });
    } finally { runtime.retire(); }
  });
  it('decision sends retain explicit project, session and page-leave keepalive under the captured owner', async () => {
    const f = fixture(), runtime = f.runtime(a);
    try {
      await runtime.api.respondToTask('tt-collision', '--file=literal answer', { project: 'example', keepalive: true });
      await runtime.api.dismissTask('tt-collision', undefined, { project: 'example' });
      await runtime.api.resolveGate('tt-collision', 'Approved', { project: 'example', keepalive: true });
      const decisions = f.transport.mock.calls.filter(([input]) => /\/(respond|dismiss|resolve)$/u.test(new URL(String(input)).pathname));
      expect(decisions).toHaveLength(3);
      expect(JSON.parse(String(decisions[0]?.[1]?.body))).toEqual({ projectId: projectA, response: '--file=literal answer' });
      expect(JSON.parse(String(decisions[1]?.[1]?.body))).toEqual({ projectId: projectA });
      expect(JSON.parse(String(decisions[2]?.[1]?.body))).toEqual({ projectId: projectA, reason: 'Approved' });
      expect(decisions[0]?.[1]?.keepalive).toBe(true);expect(decisions[2]?.[1]?.keepalive).toBe(true);
      for (const [, init] of decisions) expect(new Headers(init?.headers).get('x-noticeos-session-id')).toBe(a.sessionId);
      const count=f.transport.mock.calls.length;runtime.retire();
      await expect(runtime.api.resolveGate('tt-collision', undefined, { project: 'example' })).rejects.toThrow();
      expect(f.transport.mock.calls).toHaveLength(count);
    } finally { runtime.retire(); }
  });
  it('standalone keeps its id-only path and native edit body unchanged', async () => {
    const f = fixture(), runtime = f.runtime({ mode: 'standalone', clientGeneration: 1 });
    try {
      await runtime.api.fetchTask('tt-collision');
      await runtime.api.updateTask('tt-collision', { claim: true });
      expect(String(f.transport.mock.calls[0]?.[0])).toBe(`${origin}/api/tasks/tt-collision`);
      expect(f.transport.mock.calls).toHaveLength(2);
      expect(JSON.parse(String(f.transport.mock.calls[1]?.[1]?.body))).toEqual({ claim: true });
    } finally { runtime.retire(); }
  });
  it('a catalog without observed board data does not fabricate zero counts', () => {
    const roster = taskCatalogProjects([{ projectId: projectA, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }], undefined);
    const board = readTaskBoard({ capabilities: { live: true, reason: null }, snapshot: undefined, roster,
      reads: new Map(), filters: { project: 'all', status: 'all', priority: 'all', label: '', assignee: 'all' } });
    expect(board.counts.open).toBeNull(); expect(board.complete).toBe(false); expect(board.rows).toEqual([]);
    expect(board.spokes).toHaveLength(1); expect(board.spokes[0]?.ok).toBe(false);
  });
});
