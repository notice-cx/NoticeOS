import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH, READ_MODELS_HEADER } from './hosted-mcp.mjs';
import { createHostedTasksApi, IDEMPOTENCY_HEADER } from './hosted-tasks-api.mjs';
import { MCP_MODERN_VERSIONS } from './mcp-protocol.mjs';
import { READ_MODEL_TOOL_NAMES } from './read-model-tools.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { fakeTaskExecutor, memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/hosted-mcp.mts: NoticeOS's one MCP endpoint. One
// connection and one token reach every tool in every workspace its person
// belongs to; each call names its workspace, where the person's role bounds
// the token's scopes. Task tools run over the shared operations; read-model
// tools are forwarded to the Worker. Tools speak in tasks, never storage names.

const [A, B, P, S, PERSON] = ['11111111', '22222222', '33333333', '44444444', '55555555'].map(prefix => `${prefix}-1111-4111-8111-111111111111`);
const DEMO = '99999999-1111-4111-8111-111111111111';
const origin = 'https://tower.example.test';
const FULL = 'agent-token-full-0000000001', READER = 'agent-token-read-0000000002';
const TOKENS = new Map([[FULL, ['tasks:read', 'tasks:write', 'evidence:read']], [READER, ['tasks:read', 'evidence:read']]]);
const ROLES = new Map([[A, 'operator'], [B, 'viewer']]);
const token = request => request.headers.get('authorization')?.slice('Bearer '.length);

function fixture({ profile = 'hosted', readModels } = {}) {
  let time = Date.parse('2026-10-07T12:00:00.000Z');
  const clock = () => time;
  const forwarded = [];
  const admission = profile === 'demo'
    ? createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: DEMO, workspaceStatus: async () => 'active' })
    : createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: async (_headers, workspaceId) => ({ principalId: PERSON, sessionId: S,
        expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceId, role: 'operator', workspaceStatus: 'active' }),
      agent: async (request, workspaceId) => TOKENS.has(token(request)) && ROLES.has(workspaceId) ? { principalId: PERSON,
        clientId: 'example-agent', workspaceId, role: ROLES.get(workspaceId), workspaceStatus: 'active',
        expiresAt: new Date(Date.now() + 60000).toISOString(), scopes: TOKENS.get(token(request)) } : null });
  const fake = fakeTaskExecutor({ principal: () => PERSON, clock });
  const receipts = memoryReceipts(clock);
  const directory = { catalog: async () => Object.freeze([{ projectId: P, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]) };
  const selection = profile === 'demo' ? { demoWorkspaceId: DEMO } : {};
  const operations = createHostedTaskOperations({ admission, directory, executor: fake.executor, receipts, now: clock });
  const agents = profile === 'demo' ? undefined : {
    verify: async request => TOKENS.has(token(request)) ? { scopes: TOKENS.get(token(request)) } : null,
    workspaces: async () => [{ workspaceId: A, displayName: 'Operated', role: 'operator', status: 'active' },
      { workspaceId: B, displayName: 'Viewed', role: 'viewer', status: 'active' }],
  };
  const mcp = createHostedMcp({ profile, trustedOrigin: origin, ...selection, operations, ...(agents ? { agents } : {}),
    readModels: readModels ?? (async request => {
      forwarded.push({ url: request.url, headers: new Headers(request.headers), body: await request.json() });
      const { name, arguments: args } = forwarded.at(-1).body.params;
      return Response.json({ jsonrpc: '2.0', id: 1, result: name === 'property_report' && args.asset === 'missing'
        ? { content: [{ type: 'text', text: 'no property with id missing' }], isError: true }
        : { content: [{ type: 'text', text: '{}' }], structuredContent: { properties: [{ asset: 'example.com' }] } } });
    }) });
  const http = createHostedTasksApi({ profile, trustedOrigin: origin, ...selection, admission, directory, executor: fake.executor, receipts });
  return { ...fake, mcp, http, forwarded, advance: ms => { time += ms; } };
}
function post(body, { headers = {}, path = MCP_PATH, method = 'POST', bearer = FULL } = {}) {
  return new Request(origin + path, { method, headers: { 'content-type': 'application/json',
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
const MODERN = MCP_MODERN_VERSIONS[0];
/** A 2026-07-28 request: no handshake, the version in _meta and the headers. */
function modern(method, params = {}, { bearer = FULL } = {}) {
  return post({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientCapabilities': {} } } }, { bearer, headers: { 'mcp-protocol-version': MODERN, 'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}) } });
}
let next = 1;
async function call(f, name, args, { bearer = FULL, status = 200 } = {}) {
  const reply = await f.mcp(post({ jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } }, { bearer }));
  assert.equal(reply.status, status);
  return status === 200 ? (await reply.json()).result : reply;
}

test('one endpoint in both protocol eras: a 401 to sign in, then discovery, one tool list and the transport rules', async () => {
  const f = fixture();
  const missing = await f.mcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { bearer: null }));
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write evidence:read"`);
  const unknown = await f.mcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { bearer: 'agent-token-unknown-00000' }));
  assert.equal(unknown.status, 401); assert.match(unknown.headers.get('www-authenticate'), /error="invalid_token"/u);
  const init = await (await f.mcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }))).json();
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ['2025-06-18', 'noticeos']);
  const discovered = (await (await f.mcp(modern('server/discover'))).json()).result;
  assert.deepEqual([discovered.resultType, discovered.supportedVersions], ['complete', [MODERN]]);
  assert.match(discovered.instructions, /list_workspaces/u);
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  assert.deepEqual((await (await f.mcp(modern('tools/list'))).json()).result.tools, tools, 'one tool list in both eras');
  assert.deepEqual(tools.map(tool => tool.name), ['list_workspaces', 'list_projects', 'list_tasks', 'get_task', 'get_task_history',
    'create_task', 'claim_task', 'update_task', 'comment_on_task', 'close_task', ...READ_MODEL_TOOL_NAMES]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.inputSchema.required.includes('workspace'), tool.name !== 'list_workspaces', `${tool.name} names its workspace`);
    assert.doesNotMatch(JSON.stringify(tool), /\bbeads?\b|\bbd\b|\bissue/iu, `${tool.name} speaks in tasks`);
  }
  // No human decision is a tool: write access never answers its own question.
  assert.equal(tools.some(tool => /respond|dismiss|resolve|gate|decide/u.test(tool.name)), false);
  for (const [request, status] of [
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { method: 'GET' }), 405],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { path: '/api/mcp?x=1' }), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { path: '/api/tasks/mcp' }), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { 'mcp-protocol-version': '2024-01-01' } }), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { origin: 'https://elsewhere.example' } }), 403],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { headers: { 'content-type': 'text/plain' } }), 415],
    [post('{"jsonrpc":"2.0","id":3,"method":"ping","method":"tools/list"}'), 400],
    [post({ jsonrpc: '2.0', id: 3, method: 'ping', params: { _meta: { pad: 'x'.repeat(300 * 1024) } } }), 400],
  ]) assert.equal((await f.mcp(request)).status, status);
  assert.equal((await (await f.mcp(post({ jsonrpc: '2.0', id: 5, method: 'resources/list' }))).json()).error.code, -32601);
  assert.deepEqual(f.calls, [], 'no transport refusal reaches a task command');
});

test('list_workspaces shows every workspace with what this connection may do there', async () => {
  const f = fixture();
  assert.deepEqual((await call(f, 'list_workspaces', {})).structuredContent, { workspaces: [
    { workspaceId: A, name: 'Operated', role: 'operator', status: 'active', access: ['tasks:read', 'tasks:write', 'evidence:read'] },
    { workspaceId: B, name: 'Viewed', role: 'viewer', status: 'active', access: ['tasks:read', 'evidence:read'] }] });
  assert.match((await call(f, 'list_workspaces', { workspace: A })).content[0].text, /^invalid arguments/u);
});

test('task tools act in the workspace each call names, bounded there by the role and everywhere by the scopes', async () => {
  const f = fixture();
  const args = { workspace: A, project: P, title: 'Investigate the drop', priority: 1, idempotency_key: 'agent-create-0001' };
  assert.deepEqual((await call(f, 'create_task', args)).structuredContent, { id: 'tt-1', project: 'example', replayed: false });
  assert.deepEqual((await call(f, 'create_task', args)).structuredContent, { id: 'tt-1', project: 'example', replayed: true });
  const modernRetry = (await (await f.mcp(modern('tools/call', { name: 'create_task', arguments: args }))).json()).result;
  assert.deepEqual([modernRetry.resultType, modernRetry.structuredContent.replayed], ['complete', true]);
  const claimed = (await call(f, 'claim_task', { workspace: A, project: P, task: 'tt-1', idempotency_key: 'agent-claim-0001' })).structuredContent;
  assert.deepEqual([claimed.task.status, claimed.task.assignee], ['in_progress', PERSON]);
  const said = (await call(f, 'comment_on_task', { workspace: A, project: P, task: 'tt-1', text: 'Found it', idempotency_key: 'agent-note-0001' })).structuredContent;
  assert.deepEqual([said.comment.author, said.comment.text], [PERSON, 'Found it']);
  const closed = (await call(f, 'close_task', { workspace: A, project: P, task: 'tt-1', reason: 'Fixed in abc123', idempotency_key: 'agent-close-0001' })).structuredContent;
  assert.equal(closed.task.closeReason, 'Fixed in abc123');
  const read = [await call(f, 'list_tasks', { workspace: A, project: P }), await call(f, 'get_task', { workspace: A, project: P, task: 'tt-1' }),
    await call(f, 'get_task_history', { workspace: A, project: P, task: 'tt-1', limit: 5 })];
  assert.equal(read[2].structuredContent.changes[0].revision, 'abc123');
  for (const result of read) assert.doesNotMatch(JSON.stringify(result), /issue_type|schema_version|CommitHash|Committer|"beads"/u);
  assert.ok(f.calls.every(entry => entry.workspace === A));
  // The viewer workspace reads but refuses changes; a read-only token cannot ask.
  assert.equal((await call(f, 'list_tasks', { workspace: B, project: P })).isError, undefined);
  assert.match((await call(f, 'create_task', { ...args, workspace: B, idempotency_key: 'agent-create-0002' })).content[0].text, /^refused:/u);
  const narrow = await call(f, 'create_task', { ...args, idempotency_key: 'agent-create-0003' }, { bearer: READER, status: 403 });
  assert.equal(narrow.headers.get('www-authenticate'), `Bearer error="insufficient_scope", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:write"`);
  // A workspace is required, and one the person does not belong to refuses.
  assert.match((await call(f, 'list_tasks', { project: P })).content[0].text, /^invalid arguments: workspace/u);
  assert.match((await call(f, 'list_tasks', { workspace: DEMO, project: P })).content[0].text, /^refused:/u);
  assert.deepEqual(f.effects.map(([kind]) => kind), ['create', 'update', 'comment', 'close']);
});

test('read-model tools are forwarded to the Worker with the token, the named workspace and their own arguments', async () => {
  const f = fixture();
  const listed = await call(f, 'list_properties', { workspace: B });
  assert.deepEqual(listed.structuredContent, { properties: [{ asset: 'example.com' }] });
  const [sent] = f.forwarded;
  assert.equal(sent.url, `${origin}/api/mcp`);
  assert.deepEqual([sent.headers.get('authorization'), sent.headers.get(WORKSPACE_SELECTION_HEADER), sent.headers.get(READ_MODELS_HEADER)],
    [`Bearer ${FULL}`, B, 'read-models']);
  assert.deepEqual(sent.body.params, { name: 'list_properties', arguments: {} });
  assert.equal((await call(f, 'property_report', { workspace: A, asset: 'missing' })).content[0].text, 'no property with id missing');
  const refusedHere = fixture({ readModels: async () => Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 }) });
  assert.match((await call(refusedHere, 'list_properties', { workspace: A })).content[0].text, /^refused:/u);
  // A token without evidence:read is asked to step up before anything is forwarded.
  const tasksOnly = 'agent-token-tasks-000000003';
  TOKENS.set(tasksOnly, ['tasks:read']);
  try {
    const before = f.forwarded.length;
    assert.equal((await call(f, 'list_properties', { workspace: A }, { bearer: tasksOnly, status: 403 })).headers.get('www-authenticate')
      .includes('scope="evidence:read"'), true);
    assert.equal(f.forwarded.length, before);
  } finally { TOKENS.delete(tasksOnly); }
});

test('HTTP and MCP share one receipt: a change retried through the other surface is not repeated', async () => {
  const f = fixture();
  const key = 'agent-create-0004';
  const viaHttp = await f.http(new Request(origin + '/api/tasks', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S, [IDEMPOTENCY_HEADER]: key },
    body: JSON.stringify({ projectId: P, title: 'Same change' }) }));
  assert.equal(viaHttp.status, 200);
  assert.deepEqual((await call(f, 'create_task', { workspace: A, project: P, title: 'Same change', idempotency_key: key })).structuredContent,
    { id: 'tt-1', project: 'example', replayed: true });
  assert.equal(f.effects.length, 1);
});

test('refusals are readable tool errors and never reveal which check refused', async () => {
  const f = fixture();
  const error = async (name, args) => { const result = await call(f, name, args); assert.equal(result.isError, true); return result.content[0].text; };
  assert.match(await error('create_task', { workspace: A, project: P, title: 'x' }), /^invalid arguments: idempotency_key/u);
  assert.match(await error('create_task', { workspace: A, project: P, title: 'x', idempotency_key: 'agent-create-0005', owner: 'me' }), /unknown owner/u);
  assert.match(await error('update_task', { workspace: A, project: P, task: 'tt-9', idempotency_key: 'agent-update-0001' }), /at least one field/u);
  assert.match(await error('list_tasks', { workspace: A, project: 'example' }), /^invalid arguments: project/u);
  assert.match(await error('get_task', { workspace: A, project: '77777777-1111-4111-8111-111111111111', task: 'tt-1' }), /^refused:/u);
  await call(f, 'comment_on_task', { workspace: A, project: P, task: 'tt-1', text: 'First', idempotency_key: 'agent-note-0002' });
  assert.match(await error('comment_on_task', { workspace: A, project: P, task: 'tt-1', text: 'Other', idempotency_key: 'agent-note-0002' }), /^conflict:/u);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const running = call(f, 'comment_on_task', { workspace: A, project: P, task: 'tt-1', text: 'Slow', idempotency_key: 'agent-note-0003' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(await error('comment_on_task', { workspace: A, project: P, task: 'tt-1', text: 'Slow', idempotency_key: 'agent-note-0003' }), /^pending:/u);
  release(); f.hold(null); await running;
});

test('the demo takes no credential, lists its one workspace and only reads', async () => {
  const demo = fixture({ profile: 'demo' });
  const anonymous = (name, args) => demo.mcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { bearer: null }));
  assert.equal((await (await anonymous('list_workspaces', {})).json()).result.structuredContent.workspaces[0].workspaceId, DEMO);
  assert.equal((await (await anonymous('create_task', { workspace: DEMO, project: P, title: 'x', idempotency_key: 'demo-create-0001' })).json()).result.isError, true);
  assert.equal((await demo.mcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }))).status, 400, 'a demo token is never accepted');
  assert.deepEqual(demo.effects, []);
});
