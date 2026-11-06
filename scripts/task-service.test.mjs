import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskService, mapTaskProjects, TaskServiceToolRefused, TaskServiceUnavailable } from './task-service.mjs';
import { openStandaloneMcp } from './standalone-mcp.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/task-service.mts and the standalone MCP's task service. The ingest
// door and the Ntasks Worker behind it are answered here; nothing leaves the test.

const DOOR = 'http://door.test';
const LOCAL = '11111111-1111-4111-8111-111111111111';
const REMOTE = '37e269ad-cd23-4f5c-b3c7-ae5201e79e2d';
const PROJECT = { projectId: '8b3adafa-0d35-8bd9-b981-7a238b7cf410', logicalKey: 'example.com', displayName: 'Example', prefix: 'ex' };

/** The ingest's /api/task-service in front of `ntasks(call)`, which answers
 * `{ status, body }`, or `null` for an Ntasks that does not answer. */
function door(ntasks, { connected = true, seen = [] } = {}) {
  return async (url, init) => {
    assert.equal(url, `${DOOR}/api/task-service`);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer operator-token');
    if (init.method === 'GET') return Response.json({ connected, origin: connected ? 'https://ntasks.example.com' : null });
    const call = JSON.parse(init.body);
    seen.push(call);
    if (!connected) return Response.json({ answered: false, reason: 'not-connected' });
    const answer = await ntasks({ ...call, body: call.body === undefined ? undefined : JSON.parse(call.body) });
    return Response.json(answer === null ? { answered: false, reason: 'network' } : { answered: true, ...answer });
  };
}
/** An Ntasks MCP endpoint whose tools are `tools[name](args)`. */
function mcp(tools) {
  return async ({ path, body }) => {
    if (path === '/api/tasks/projects') return { status: 200, body: { projects: [PROJECT] } };
    assert.equal(path, '/api/mcp');
    const { name, arguments: args } = body.params;
    if (name === 'list_workspaces') return { status: 200, body: { jsonrpc: '2.0', id: body.id, result: { structuredContent: { workspaces: [{ workspaceId: REMOTE }] } } } };
    const tool = tools[name];
    if (!tool) return { status: 200, body: { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `no tool named ${name}` } } };
    const out = await tool(args);
    return { status: 200, body: { jsonrpc: '2.0', id: body.id, result: out instanceof Error
      ? { isError: true, content: [{ type: 'text', text: out.message }] } : { content: [], structuredContent: out } } };
  };
}
const service = (fetch, now = Date.now) => createTaskService({ door: DOOR, token: async () => 'operator-token', fetch, now });

test('a call reaches Ntasks through the ingest door, and an unanswered one names why', async () => {
  const seen = [];
  const tasks = service(door(async () => ({ status: 200, body: { events: [], lastSeq: 7 } }), { seen }));
  assert.equal(await tasks.connected(), true);
  assert.equal(await tasks.origin(), 'https://ntasks.example.com');
  assert.deepEqual(await tasks.call({ method: 'GET', path: '/api/changes?after=7' }), { status: 200, body: { events: [], lastSeq: 7 } });
  await tasks.call({ method: 'POST', path: '/api/tasks', body: { title: 'One' }, idempotencyKey: 'key-12345678' });
  assert.deepEqual(seen, [{ method: 'GET', path: '/api/changes?after=7' },
    { method: 'POST', path: '/api/tasks', body: '{"title":"One"}', idempotencyKey: 'key-12345678' }]);

  await assert.rejects(service(door(async () => null)).call({ method: 'GET', path: '/api/tasks' }),
    error => error instanceof TaskServiceUnavailable && error.reason === 'network');
  await assert.rejects(service(door(async () => null, { connected: false })).call({ method: 'GET', path: '/api/tasks' }),
    error => error instanceof TaskServiceUnavailable && error.reason === 'not-connected');
  await assert.rejects(service(async () => { throw new TypeError('ECONNREFUSED'); }).connected(),
    error => error instanceof TaskServiceUnavailable && error.reason === 'ingest');
});

test('whether a task service is connected is read at most every few seconds', async () => {
  let reads = 0, clock = 0;
  const tasks = service(async (url, init) => { reads += 1; return door(async () => null)(url, init); }, () => clock);
  await tasks.connected(); await tasks.connected();
  assert.equal(reads, 1);
  clock = 6_000;
  await tasks.connected();
  assert.equal(reads, 2);
});

test('a tool call names Ntasks\'s workspace and keeps each refusal\'s own sentence', async () => {
  const calls = [];
  const tasks = service(door(mcp({
    list_tasks: async args => { calls.push(args); return { tasks: [{ id: 'ex-1' }] }; },
    claim_task: async () => new Error('refused: ex-1 is held by someone else.'),
  })));
  assert.deepEqual(await tasks.tool('list_tasks', { workspace: LOCAL, project: PROJECT.projectId }), { tasks: [{ id: 'ex-1' }] });
  assert.deepEqual(calls, [{ workspace: REMOTE, project: PROJECT.projectId }]);
  await assert.rejects(tasks.tool('claim_task', { workspace: LOCAL, project: PROJECT.projectId, task: 'ex-1', idempotency_key: 'claim-12345678' }),
    error => error instanceof TaskServiceToolRefused && error.message === 'refused: ex-1 is held by someone else.');
  await assert.rejects(tasks.tool('close_task', { workspace: LOCAL }),
    error => error instanceof TaskServiceToolRefused && /does not offer close_task yet; nothing was read or changed/u.test(error.message));
  assert.deepEqual(await tasks.projects(), [PROJECT]);
});

test('a saved task project is the Ntasks project with its prefix', () => {
  assert.deepEqual(mapTaskProjects([{ asset: 'example.com', prefix: 'EX' }, { asset: 'shop.example', prefix: 'shop' }], [PROJECT]), [
    { asset: 'example.com', prefix: 'EX', project: PROJECT },
    { asset: 'shop.example', prefix: 'shop', project: null },
  ]);
});

async function standalone(fetch, now = Date.now) {
  const ran = [];
  const handle = await openStandaloneMcp({ store: { onlyWorkspace: async () => LOCAL, close: async () => {},
    inWorkspace: async () => [] }, receipts: memoryReceipts(Date.now),
    projects: async () => [{ projectId: PROJECT.projectId, asset: 'example.com', prefix: 'ex', cwd: '/nowhere' }],
    run: async argv => { ran.push(argv); return { code: 0, stdout: '[]' }; }, taskService: service(fetch, now) });
  const call = async (name, args) => (await handle.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))).json();
  return { call, ran, close: () => handle.close() };
}

test('while Ntasks is connected the task tools run there and never on the local task client', async t => {
  const seen = [];
  const actors = [];
  const fetch = door(mcp({
    list_tasks: async args => { seen.push(['list_tasks', args]); return { tasks: [{ id: 'ex-1', title: 'From Ntasks' }] }; },
    claim_task: async args => { seen.push(['claim_task', args]); return { task: { id: 'ex-1', status: 'in_progress' } }; },
  }));
  const local = await standalone(async (url, init) => {
    if (init.method === 'POST') actors.push(JSON.parse(init.body).onBehalfOf);
    return fetch(url, init);
  });
  t.after(local.close);
  const listed = await local.call('list_tasks', { workspace: LOCAL, project: PROJECT.projectId });
  assert.deepEqual(listed.result.structuredContent, { tasks: [{ id: 'ex-1', title: 'From Ntasks' }] });
  const claimed = await local.call('claim_task', { workspace: LOCAL, project: PROJECT.projectId, task: 'ex-1', idempotency_key: 'claim-12345678', model: 'm' });
  assert.equal(claimed.result.isError, undefined);
  assert.deepEqual(seen.map(([name, args]) => [name, args.workspace]), [['list_tasks', REMOTE], ['claim_task', REMOTE]]);
  // Every task tool call names the agent; the workspace lookup is the installation's own.
  assert.ok(actors.length >= 2 && actors.filter(actor => actor !== undefined).every(actor => actor === 'agent'));
  const missing = await local.call('close_task', { workspace: LOCAL, project: PROJECT.projectId, task: 'ex-1', reason: 'Done', idempotency_key: 'close-12345678' });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /does not offer close_task yet/u);
  assert.deepEqual(local.ran, []);
});

test('with Ntasks unreachable no task tool reports success', async t => {
  const local = await standalone(door(async () => null));
  t.after(local.close);
  const read = await local.call('list_tasks', { workspace: LOCAL, project: PROJECT.projectId });
  assert.equal(read.result.isError, true);
  assert.match(read.result.content[0].text, /^unavailable: https:\/\/ntasks\.example\.com did not answer \(network\)\. Nothing was read/u);
  const write = await local.call('comment_on_task', { workspace: LOCAL, project: PROJECT.projectId, task: 'ex-1', text: 'Note', idempotency_key: 'note-12345678' });
  assert.equal(write.result.isError, true);
  assert.match(write.result.content[0].text, /Its outcome is not confirmed: read the task, or retry with the same idempotency_key/u);
  assert.deepEqual(local.ran, []);

  const down = await standalone(async () => { throw new TypeError('ECONNREFUSED'); });
  t.after(down.close);
  const unknown = await down.call('list_tasks', { workspace: LOCAL, project: PROJECT.projectId });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /^unavailable: The installation's ingest did not answer/u);
  assert.deepEqual(down.ran, []);
});

test('with no task service connected the task tools stay on the linked projects', async t => {
  const local = await standalone(door(async () => { throw new Error('Ntasks must not be asked'); }, { connected: false }));
  t.after(local.close);
  const listed = await local.call('list_projects', { workspace: LOCAL });
  assert.deepEqual(listed.result.structuredContent.projects.map(project => project.prefix), ['ex']);
});

test('where the tasks live is the ingest\'s last answer while it cannot say, and unknown before it ever has', async () => {
  let up = true, connected = false, reads = 0, clock = 0;
  const fetch = async (url, init) => { reads += 1; if (!up) throw new TypeError('ECONNREFUSED'); return door(async () => null, { connected })(url, init); };
  const never = service(async () => { reads += 1; throw new TypeError('ECONNREFUSED'); }, () => clock);
  assert.equal(await never.backend(), 'unknown');
  assert.equal(await never.backend(), 'unknown');
  assert.equal(reads, 1, 'a failed read is reused for a few seconds');
  reads = 0;
  const tasks = service(fetch, () => clock);
  assert.equal(await tasks.backend(), 'local');
  clock = 6_000; up = false;
  assert.equal(await tasks.backend(), 'local');
  clock = 12_000; up = true; connected = true;
  assert.equal(await tasks.backend(), 'ntasks');
  clock = 18_000; up = false;
  assert.equal(await tasks.backend(), 'ntasks');
  await assert.rejects(tasks.connected(), error => error instanceof TaskServiceUnavailable && error.reason === 'ingest');
});

test('a known local backend keeps the task tools local while the ingest does not answer', async t => {
  let up = true, clock = 0, reads = 0;
  const fetch = door(async () => { throw new Error('Ntasks must not be asked'); }, { connected: false });
  const local = await standalone(async (url, init) => { reads += 1; if (!up) throw new TypeError('ECONNREFUSED'); return fetch(url, init); }, () => clock);
  t.after(local.close);
  assert.equal((await local.call('list_projects', { workspace: LOCAL })).result.isError, undefined);
  up = false; clock = 6_000; reads = 0;
  const listed = await local.call('list_projects', { workspace: LOCAL });
  assert.deepEqual(listed.result.structuredContent.projects.map(project => project.prefix), ['ex']);
  assert.equal(reads, 1, 'the ingest was asked, and its last answer stood');
});

test('a change that takes no retry key says to read the task before retrying', async t => {
  const local = await standalone(door(async ({ path }) => path === '/api/mcp' ? null : { status: 200, body: { projects: [PROJECT] } }));
  t.after(local.close);
  const linked = await local.call('add_dependency', { workspace: LOCAL, project: PROJECT.projectId, task: 'ex-1', depends_on: 'ex-2' });
  assert.equal(linked.result.isError, true);
  assert.match(linked.result.content[0].text, /read the task to see whether it landed before retrying\.$/u);
  assert.doesNotMatch(linked.result.content[0].text, /idempotency_key/u);
});
