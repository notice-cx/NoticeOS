import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedTaskMcp, TASK_MCP_PATH } from './hosted-task-mcp.mjs';
import { MCP_MODERN_VERSIONS } from './mcp-protocol.mjs';
import { createHostedTasksApi, IDEMPOTENCY_HEADER } from './hosted-tasks-api.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { fakeTaskExecutor, memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/hosted-task-mcp.mts (epic ro-cvl9): the shared MCP transport, both
// protocol eras (scripts/mcp-protocol.test.mjs), over the shared hosted task
// operations. Tools speak in tasks; storage names never reach a client.

const [A, P, S, PERSON] = ['11111111', '33333333', '44444444', '55555555'].map(prefix => `${prefix}-1111-4111-8111-111111111111`);
const DEMO = '99999999-1111-4111-8111-111111111111';
const origin = 'https://tower.example.test';

function fixture({ profile = 'hosted' } = {}) {
  let time = Date.parse('2026-10-07T12:00:00.000Z'), role = 'operator';
  const clock = () => time;
  const admission = profile === 'demo'
    ? createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: DEMO, workspaceStatus: async () => 'active' })
    : createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: async (_headers, workspaceId) => ({ principalId: PERSON, sessionId: S,
        expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceId, role, workspaceStatus: 'active' }) });
  const fake = fakeTaskExecutor({ principal: () => PERSON, clock });
  const receipts = memoryReceipts(clock);
  const directory = { catalog: async () => Object.freeze([{ projectId: P, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]) };
  const selection = profile === 'demo' ? { demoWorkspaceId: DEMO } : {};
  const operations = createHostedTaskOperations({ admission, directory, executor: fake.executor, receipts, now: clock });
  const mcp = createHostedTaskMcp({ profile, trustedOrigin: origin, ...selection, operations });
  const http = createHostedTasksApi({ profile, trustedOrigin: origin, ...selection, admission, directory, executor: fake.executor, receipts });
  return { ...fake, mcp, http, receipts, role: value => { role = value; }, advance: ms => { time += ms; } };
}
function post(body, { headers = {}, path = TASK_MCP_PATH, method = 'POST' } = {}) {
  return new Request(origin + path, { method, headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S, ...headers },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
const MODERN = MCP_MODERN_VERSIONS[0];
/** A 2026-07-28 request: no handshake, the version in _meta and the headers. */
function modern(method, params = {}, id = 1) {
  return post({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientCapabilities': {} } } }, { headers: { 'mcp-protocol-version': MODERN, 'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}) } });
}
let next = 1;
async function call(f, name, args) {
  const reply = await f.mcp(post({ jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } }));
  assert.equal(reply.status, 200);
  return (await reply.json()).result;
}

test('both protocol eras: the handshake or discovery, the tool list and transport rules', async () => {
  const f = fixture();
  const init = await (await f.mcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }))).json();
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ['2025-06-18', 'noticeos-tasks']);
  const notified = await f.mcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notified.status, 202); assert.equal(await notified.text(), '');
  const discovered = (await (await f.mcp(modern('server/discover'))).json()).result;
  assert.deepEqual([discovered.resultType, discovered.supportedVersions, discovered.capabilities],
    ['complete', [MODERN], { tools: {} }]);
  assert.match(discovered.instructions, /list_projects/u);
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  assert.deepEqual((await (await f.mcp(modern('tools/list'))).json()).result.tools, tools, 'one tool list in both eras');
  assert.deepEqual(tools.map(tool => tool.name), ['list_projects', 'list_tasks', 'get_task', 'get_task_history',
    'create_task', 'claim_task', 'update_task', 'comment_on_task', 'close_task']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.annotations.readOnlyHint, !tool.inputSchema.required.includes('idempotency_key'), `${tool.name}: writes need a key`);
    assert.doesNotMatch(JSON.stringify(tool), /\bbeads?\b|\bbd\b|\bissue/iu, `${tool.name} speaks in tasks`);
  }
  // No human decision is a tool: write access never answers its own question.
  assert.equal(tools.some(tool => /respond|dismiss|resolve|gate|decide/u.test(tool.name)), false);

  for (const [request, status] of [
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { method: 'GET' }), 405],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { path: '/api/tasks/mcp?x=1' }), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { [WORKSPACE_SELECTION_HEADER]: 'not-a-workspace' } }), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { 'mcp-protocol-version': '2024-01-01' } }), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { origin: 'https://elsewhere.example' } }), 403],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { 'content-type': 'text/plain' } }), 415],
    [modern('tools/call', { name: 'list_projects', arguments: {} }), 200],
    [post('{"jsonrpc":"2.0","id":3,"method":"ping","method":"tools/list"}'), 400],
    [post('{"jsonrpc":"2.0","id":3,"method":"ping"} trailing'), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } }), 400],
  ]) assert.equal((await f.mcp(request)).status, status);
  const mismatched = modern('tools/call', { name: 'list_projects', arguments: {} }); mismatched.headers.set('mcp-name', 'create_task');
  assert.equal((await (await f.mcp(mismatched)).json()).error.code, -32020);
  const batch = await (await f.mcp(post([{ jsonrpc: '2.0', id: 4, method: 'ping' }]))).json();
  assert.equal(batch.error.code, -32600);
  assert.equal((await (await f.mcp(post({ jsonrpc: '2.0', id: 5, method: 'resources/list' }))).json()).error.code, -32601);
  assert.deepEqual(f.calls, [], 'no transport refusal reaches a task command');
});

test('task tools answer in task language, and a retried change is replayed, not repeated', async () => {
  const f = fixture();
  assert.deepEqual((await call(f, 'list_projects', {})).structuredContent,
    { projects: [{ projectId: P, key: 'example', name: 'Example', prefix: 'tt' }] });
  const args = { project: P, title: 'Investigate the drop', priority: 1, idempotency_key: 'agent-create-0001' };
  const created = await call(f, 'create_task', args);
  assert.deepEqual(created.structuredContent, { id: 'tt-1', project: 'example', replayed: false });
  assert.deepEqual((await call(f, 'create_task', args)).structuredContent, { id: 'tt-1', project: 'example', replayed: true });
  // The same retry from a 2026-07-28 client replays the same receipt.
  const modernRetry = (await (await f.mcp(modern('tools/call', { name: 'create_task', arguments: args }))).json()).result;
  assert.deepEqual([modernRetry.resultType, modernRetry.structuredContent], ['complete', { id: 'tt-1', project: 'example', replayed: true }]);
  const claimed = (await call(f, 'claim_task', { project: P, task: 'tt-1', idempotency_key: 'agent-claim-0001' })).structuredContent;
  assert.deepEqual([claimed.task.status, claimed.task.assignee, claimed.task.type], ['in_progress', PERSON, 'task']);
  const said = (await call(f, 'comment_on_task', { project: P, task: 'tt-1', text: 'Found it', idempotency_key: 'agent-note-0001' })).structuredContent;
  assert.deepEqual([said.comment.author, said.comment.text], [PERSON, 'Found it']);
  const closed = (await call(f, 'close_task', { project: P, task: 'tt-1', reason: 'Fixed in abc123', idempotency_key: 'agent-close-0001' })).structuredContent;
  assert.deepEqual([closed.task.status, closed.task.closeReason], ['closed', 'Fixed in abc123']);
  const read = [
    await call(f, 'list_tasks', { project: P }), await call(f, 'get_task', { project: P, task: 'tt-1' }),
    await call(f, 'get_task_history', { project: P, task: 'tt-1', limit: 5 }), created,
  ];
  assert.equal(read[2].structuredContent.changes[0].revision, 'abc123');
  for (const result of [...read, { structuredContent: claimed }, { structuredContent: said }, { structuredContent: closed }]) {
    assert.doesNotMatch(JSON.stringify(result), /issue_type|schema_version|CommitHash|Committer|"beads"/u);
  }
  assert.deepEqual(f.effects.map(([kind]) => kind), ['create', 'update', 'comment', 'close']);
});

test('HTTP and MCP share one receipt: a change retried through the other surface is not repeated', async () => {
  const f = fixture();
  const key = 'agent-create-0002';
  const viaHttp = await f.http(new Request(origin + '/api/tasks', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S, [IDEMPOTENCY_HEADER]: key },
    body: JSON.stringify({ projectId: P, title: 'Same change' }) }));
  assert.equal(viaHttp.status, 200);
  assert.deepEqual(await viaHttp.json(), { id: 'tt-1', project: 'example' });
  assert.deepEqual((await call(f, 'create_task', { project: P, title: 'Same change', idempotency_key: key })).structuredContent,
    { id: 'tt-1', project: 'example', replayed: true });
  assert.equal(f.effects.length, 1);
});

test('refusals are readable tool errors and never reveal which check refused', async () => {
  const f = fixture();
  const error = async (name, args) => { const result = await call(f, name, args); assert.equal(result.isError, true); return result.content[0].text; };
  assert.match(await error('create_task', { project: P, title: 'x' }), /^invalid arguments: idempotency_key/u);
  assert.match(await error('create_task', { project: P, title: 'x', idempotency_key: 'agent-create-0003', owner: 'me' }), /unknown owner/u);
  assert.match(await error('update_task', { project: P, task: 'tt-9', idempotency_key: 'agent-update-0001' }), /at least one field/u);
  assert.match(await error('list_tasks', { project: 'example' }), /^invalid arguments: project/u);
  assert.match(await error('get_task', { project: '77777777-1111-4111-8111-111111111111', task: 'tt-1' }), /^refused:/u);
  await call(f, 'comment_on_task', { project: P, task: 'tt-1', text: 'First', idempotency_key: 'agent-note-0002' });
  assert.match(await error('comment_on_task', { project: P, task: 'tt-1', text: 'Other', idempotency_key: 'agent-note-0002' }), /^conflict:/u);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const running = call(f, 'comment_on_task', { project: P, task: 'tt-1', text: 'Slow', idempotency_key: 'agent-note-0003' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(await error('comment_on_task', { project: P, task: 'tt-1', text: 'Slow', idempotency_key: 'agent-note-0003' }), /^pending:/u);
  release(); f.hold(null); await running;
  f.role('viewer');
  const effects = f.effects.length;
  assert.match(await error('close_task', { project: P, task: 'tt-1', reason: 'Done', idempotency_key: 'agent-close-0002' }), /^refused:/u);
  assert.equal(f.effects.length, effects);
  const demo = fixture({ profile: 'demo' });
  const demoCall = await demo.mcp(new Request(origin + TASK_MCP_PATH, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task',
      arguments: { project: P, title: 'x', idempotency_key: 'demo-create-0001' } } }) }));
  assert.equal((await demoCall.json()).result.isError, true);
  assert.deepEqual(demo.effects, []);
});
