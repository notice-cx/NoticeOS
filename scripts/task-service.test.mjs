import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskService, mapTaskProjects, TaskServiceToolRefused, TaskServiceUnavailable } from './task-service.mjs';
import { openStandaloneMcp } from './standalone-mcp.mjs';
import { TASK_MCP_TOOLS } from './hosted-task-mcp.mjs';
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
  const rpc = async (method, params = {}) => (await handle.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json();
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  return { rpc, call, ran, close: () => handle.close() };
}

const TASK_TOOL_NAMES = new Set(TASK_MCP_TOOLS.map(tool => tool.name));
const ENDPOINT = 'https://ntasks.example.com/api/mcp';

test('while the tasks live in Ntasks, the endpoint lists no task tools and names Ntasks\'s endpoint instead', async t => {
  let connected = true;
  const asked = [];
  const fetch = async (url, init) => door(async call => { asked.push(call); return null; }, { connected })(url, init);
  let clock = 0;
  const local = await standalone(fetch, () => clock);
  t.after(local.close);
  const listedNames = async () => (await local.rpc('tools/list')).result.tools.map(tool => tool.name);

  const names = await listedNames();
  assert.deepEqual(names.filter(name => TASK_TOOL_NAMES.has(name)), []);
  assert.ok(names.includes('list_workspaces') && names.includes('get_task_guide') && names.includes('get_panel'), 'the other tools stay');
  const { instructions } = (await local.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
  assert.ok(instructions.includes(ENDPOINT));
  const { guide, version } = (await local.call('get_task_guide', {})).result.structuredContent;
  assert.ok(guide.includes(ENDPOINT));
  const [workspace] = (await local.call('list_workspaces', {})).result.structuredContent.workspaces;
  assert.equal(workspace.access.some(scope => scope.startsWith('tasks:')), false);
  assert.equal((await local.call('list_workspaces', {})).result.structuredContent.guideVersion, version);

  // A client that listed the task tools earlier is told where the tasks are; nothing runs.
  const claimed = await local.call('claim_task', { workspace: LOCAL, project: PROJECT.projectId, task: 'ex-1', idempotency_key: 'claim-12345678', model: 'm' });
  assert.equal(claimed.result.isError, true);
  assert.ok(claimed.result.content[0].text.includes(ENDPOINT));
  assert.deepEqual(asked, [], 'Ntasks is not asked for a task tool');
  assert.deepEqual(local.ran, []);

  connected = false; clock = 6_000;
  assert.ok((await listedNames()).includes('claim_task'), 'the task tools come back with the local task database');
  assert.notEqual((await local.call('get_task_guide', {})).result.structuredContent.version, version);
});

test('before the ingest has ever said where the tasks live, a task tool answers unavailable', async t => {
  const down = await standalone(async () => { throw new TypeError('ECONNREFUSED'); });
  t.after(down.close);
  const unknown = await down.call('list_tasks', { workspace: LOCAL, project: PROJECT.projectId });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /^unavailable:/u);
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
