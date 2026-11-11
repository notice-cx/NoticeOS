// @vitest-environment node
import { expect, it } from 'vitest';
import { handleTasksRequest, type TaskLaneOptions } from '../vite/task-lane';
import type { TaskService, TaskServiceCall } from '../../../scripts/task-service.mjs';

const PROJECT = { projectId: '8b3adafa-0d35-8bd9-b981-7a238b7cf410', logicalKey: 'example', displayName: 'Example', prefix: 'ex' };

it('reads two boards per project from Ntasks and exposes only aggregates, naming failed projects', async () => {
  const calls: TaskServiceCall[] = [];
  const service = {
    connected: async () => true,
    backend: async () => 'ntasks',
    origin: async () => 'https://ntasks.example.com',
    projects: async () => [PROJECT],
    async call(call: TaskServiceCall) {
      calls.push(call);
      return { status: 200, body: { tasks: call.path.includes('status=closed') ? [{ id: 'ex-a', title: 'Private details', status: 'closed',
        priority: 2, issueType: 'task', awaitType: null, assignee: null, startedAt: null, updatedAt: '2026-10-15T10:00:00Z',
        closedAt: '2026-10-15T10:00:00Z', closedBy: 'agent:claude', closedModel: 'claude-opus-5-5', metadata: { private_note: 'Private details' } }] : [] } };
    },
  } as unknown as TaskService;
  const options: TaskLaneOptions = {
    now: () => new Date('2026-10-15T12:00:00Z'), taskService: service,
    // The second project has no Ntasks project with its prefix.
    readProjects: async () => [{ asset: 'example', prefix: 'ex', repo: '' }, { asset: 'unmapped', prefix: 'ot', repo: '' }],
  };
  const response = await handleTasksRequest({ method: 'GET', url: '/api/tasks/agent-stats', headers: {}, body: '' }, options);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ projects: 2, broken: ['unmapped'], stats: { week: 1 } });
  expect(calls.map(call => call.path)).toEqual([`/api/tasks?project=${PROJECT.projectId}&status=in_progress,blocked`,
    `/api/tasks?project=${PROJECT.projectId}&status=closed&closedDays=56`]);
  expect(JSON.stringify(response.body)).not.toContain('Private details');
  expect(JSON.stringify(response.body)).not.toContain('metadata');
  const before = calls.length;
  expect((await handleTasksRequest({ method: 'GET', url: '/api/tasks/agent-stats?status=open', headers: {}, body: '' }, options)).status).toBe(422);
  expect((await handleTasksRequest({ method: 'GET', url: '/api/tasks/agent-stats', headers: { origin: 'https://foreign.example' }, body: '' }, options)).status).toBe(403);
  expect(calls).toHaveLength(before);
});
