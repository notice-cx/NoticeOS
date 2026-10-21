// @vitest-environment node
import { expect, it } from 'vitest';
import { handleTasksRequest, type TaskLaneOptions } from '../vite/task-lane';

it('reads two lists per project and exposes only aggregates, naming failed projects', async () => {
  const calls: string[][] = [];
  const options: TaskLaneOptions = {
    now: () => new Date('2026-10-15T12:00:00Z'), actor: 'Synthetic Operator',
    readProjects: async () => [{ asset: 'example', prefix: 'ex', repo: '.' }, { asset: 'unavailable', prefix: 'ot', repo: '.', unavailableReason: 'No local repository' }],
    run: argv => {
      calls.push(argv);
      return { code: 0, stderr: '', stdout: JSON.stringify(argv.includes('closed') ? [{ id: 'ex-a', title: 'Private details', status: 'closed',
        closed_at: '2026-10-15T10:00:00Z', metadata: { noticeos_claimed_model: 'Opus 5.5' } }] : []) };
    },
  };
  const response = await handleTasksRequest({ method: 'GET', url: '/api/tasks/agent-stats', headers: {}, body: '' }, options);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ projects: 2, broken: ['unavailable'], stats: { week: 1 } });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('in_progress,blocked');
  expect(calls[1]).toContain('2026-08-20');
  expect(JSON.stringify(response.body)).not.toContain('Private details');
  expect(JSON.stringify(response.body)).not.toContain('metadata');
  const before = calls.length;
  expect((await handleTasksRequest({ method: 'GET', url: '/api/tasks/agent-stats?status=open', headers: {}, body: '' }, options)).status).toBe(422);
  expect((await handleTasksRequest({ method: 'GET', url: '/api/tasks/agent-stats', headers: { origin: 'https://foreign.example' }, body: '' }, options)).status).toBe(403);
  expect(calls).toHaveLength(before);
});
