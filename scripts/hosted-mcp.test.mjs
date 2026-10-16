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
import { TASK_QUALITY, TASK_WORKFLOW, taskGuide } from './hosted-task-mcp.mjs';

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
  // Every agent is told to name its model on each claim and close, so its work is ranked.
  assert.match(discovered.instructions, /On every claim_task and close_task, pass model/u);
  // And how to write a task: the one copy of the rules, in every session's instructions.
  assert.equal(init.result.instructions, discovered.instructions);
  for (const rule of TASK_QUALITY) assert.ok(discovered.instructions.includes(rule), rule);
  assert.match(discovered.instructions, /acceptance: the proof that completes it/u);
  assert.doesNotMatch(discovered.instructions, /get_panel/u, 'no panel tools here, so no word of them');
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  assert.deepEqual((await (await f.mcp(modern('tools/list'))).json()).result.tools, tools, 'one tool list in both eras');
  assert.deepEqual(tools.map(tool => tool.name), ['list_workspaces', 'get_task_guide', 'list_projects', 'list_tasks', 'get_task', 'get_task_history',
    'create_task', 'create_tasks', 'claim_task', 'update_task', 'comment_on_task', 'add_dependency', 'remove_dependency', 'request_human_approval',
    'close_task', ...READ_MODEL_TOOL_NAMES]);
  for (const name of ['claim_task', 'close_task']) {
    const tool = tools.find(entry => entry.name === name);
    assert.match(tool.description, /naming your model/u, name);
    assert.match(tool.inputSchema.properties.model.description, /Pass it on every claim and close/u, name);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.inputSchema.required.includes('workspace'), !['list_workspaces', 'get_task_guide'].includes(tool.name), `${tool.name} names its workspace`);
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

test('get_task_guide returns the whole guide with a version, and the instructions are lines of it', async () => {
  for (const [profile, panels] of [['hosted', false], ['demo', false]]) {
    const f = fixture({ profile });
    const bearer = profile === 'demo' ? null : READER;
    const instructions = (await (await f.mcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { bearer }))).json()).result.instructions;
    const reply = await call(f, 'get_task_guide', {}, { bearer });
    const { version, guide } = reply.structuredContent;
    assert.deepEqual(reply.structuredContent, taskGuide(panels), profile);
    assert.match(version, /^[0-9a-f]{12}$/u);
    assert.match(guide, new RegExp(`Guide version ${version}`, 'u'));
    for (const line of [...TASK_WORKFLOW, ...TASK_QUALITY]) assert.ok(guide.includes(line), line);
    // One source: every instruction line but the pointer to the guide is a line of the guide.
    for (const line of instructions.split('\n').filter(line => line && !line.startsWith('get_task_guide returns'))) {
      assert.ok(guide.includes(line), `${profile}: ${line}`);
    }
    assert.match(instructions, /get_task_guide returns these rules/u);
    assert.match((await call(f, 'get_task_guide', { workspace: A }, { bearer })).content[0].text, /takes none/u);
    assert.deepEqual(f.calls, [], 'the guide reaches no task command');
  }
  // Where the panel tools are offered, so is the rule for reading them.
  assert.match(taskGuide(true).guide, /## Site data\n\nFor a site's search, traffic and product data, use get_panel then query_panel/u);
  assert.notEqual(taskGuide(true).version, taskGuide(false).version);
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
  const lint = { missing: ['## Acceptance Criteria'] };
  assert.deepEqual((await call(f, 'create_task', args)).structuredContent, { id: 'tt-1', project: 'example', replayed: false, lint });
  assert.deepEqual((await call(f, 'create_task', args)).structuredContent, { id: 'tt-1', project: 'example', replayed: true, lint });
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

test('a call admission refuses names the workspace or the access when the caller\'s own workspace list shows it', async () => {
  const f = fixture();
  assert.equal((await call(f, 'list_tasks', { workspace: DEMO, project: P })).content[0].text,
    `refused: workspace ${DEMO} is not one of yours; list_workspaces lists yours.`);
  assert.equal((await call(f, 'create_task', { workspace: B, project: P, title: 'From a viewer', idempotency_key: 'agent-create-0901' })).content[0].text,
    `refused: this call needs tasks:write in workspace ${B} (Viewed), where you have tasks:read, evidence:read; `
    + 'list_workspaces shows what you may do in each.');
  assert.equal(f.calls.length, 0, 'admission refused both before any task command');
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
    { id: 'tt-1', project: 'example', replayed: true, lint: { missing: ['## Acceptance Criteria'] } });
  assert.equal(f.effects.length, 1);
});

test('dependencies and human approval decide what is ready; lint advises on every created or changed task', async () => {
  const f = fixture();
  const ready = async () => (await call(f, 'list_tasks', { workspace: A, project: P, ready: true })).structuredContent.tasks.map(task => task.id);
  const create = async (title, extra = {}) => (await call(f, 'create_task', { workspace: A, project: P, title, idempotency_key: `create-${title}`, ...extra })).structuredContent;
  assert.deepEqual((await create('First')).lint, { missing: ['## Acceptance Criteria'] });
  assert.deepEqual((await create('Second', { acceptance: 'The test passes' })).lint, { missing: [] });
  const fixed = (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', acceptance: 'It reads back', idempotency_key: 'agent-update-0002' })).structuredContent;
  assert.deepEqual(fixed.lint, { missing: [] });
  assert.deepEqual(await ready(), ['tt-1', 'tt-2']);
  const link = { workspace: A, project: P, task: 'tt-1', depends_on: 'tt-2' };
  assert.deepEqual((await call(f, 'add_dependency', link)).structuredContent, { task: 'tt-1', dependsOn: 'tt-2', type: 'blocks' });
  assert.deepEqual((await call(f, 'add_dependency', link)).structuredContent, { task: 'tt-1', dependsOn: 'tt-2', type: 'blocks' }, 'repeating it changes nothing');
  assert.deepEqual(await ready(), ['tt-2']);
  assert.deepEqual((await call(f, 'get_task', { workspace: A, project: P, task: 'tt-1' })).structuredContent.task.dependencies,
    [{ id: 'tt-2', type: 'blocks', title: 'Second', status: 'open' }]);
  assert.deepEqual((await call(f, 'remove_dependency', link)).structuredContent, { task: 'tt-1', dependsOn: 'tt-2', removed: true });
  assert.deepEqual(await ready(), ['tt-1', 'tt-2']);
  await call(f, 'add_dependency', { ...link, task: 'tt-2', depends_on: 'tt-1', type: 'discovered-from' });
  assert.deepEqual(await ready(), ['tt-1', 'tt-2'], 'only blocks holds a task back');

  const ask = { workspace: A, project: P, task: 'tt-2', reason: 'Approve the schema change' };
  const opened = (await call(f, 'request_human_approval', ask)).structuredContent;
  assert.deepEqual(opened, { task: 'tt-2', approval: { id: 'tt-3', status: 'open', reason: 'Approve the schema change' }, held: true,
    note: 'tt-2 is out of ready work until a person approves tt-3 on Tasks in the Tower.', created: true }, 'the reply says the task is held');
  assert.deepEqual((await call(f, 'request_human_approval', ask)).structuredContent, { ...opened, created: false }, 'a retry never asks twice');
  assert.deepEqual(await ready(), ['tt-1']);
  assert.equal((await call(f, 'request_human_approval', { ...ask, reason: 'Approve the rollout' })).structuredContent.approval.id, 'tt-4');
  assert.deepEqual(f.effects.filter(([kind]) => kind === 'gate'), [['gate', 'tt-3'], ['gate', 'tt-4']]);

  const error = async (name, args, options) => (await call(f, name, args, options)).content[0].text;
  assert.match(await error('add_dependency', { ...link, depends_on: 'tt-1' }), /cannot depend on itself/u);
  assert.match(await error('add_dependency', { ...link, type: 'parent-child' }), /^invalid arguments: type/u);
  assert.match(await error('add_dependency', { ...link, task: 'tt-2', depends_on: 'tt-1', type: 'related' }), /^refused:/u, 'an edge is never retyped');
  assert.match(await error('request_human_approval', { ...ask, reason: 'x'.repeat(401) }), /^invalid arguments: reason/u);
  assert.match(await error('add_dependency', { ...link, workspace: B }), /^refused:/u);
  assert.equal((await call(f, 'request_human_approval', ask, { bearer: READER, status: 403 })).headers.get('www-authenticate').includes('scope="tasks:write"'), true);
});

test('a project\'s tasks come a page of summaries at a time, most urgent first, and get_task reads one in full', async () => {
  const f = fixture();
  for (const [title, priority] of [['Later', 3], ['Now', 0], ['Soon', 1]]) {
    await call(f, 'create_task', { workspace: A, project: P, title, priority, idempotency_key: `create-${title.toLowerCase()}-0001` });
  }
  const list = async extra => (await call(f, 'list_tasks', { workspace: A, project: P, ...extra })).structuredContent;
  const first = await list({ limit: 2 });
  assert.deepEqual([first.total, first.tasks.map(task => task.title), first.nextOffset], [3, ['Now', 'Soon'], 2]);
  assert.deepEqual(Object.keys(first.tasks[0]).sort(), ['awaitingHuman', 'createdAt', 'id', 'priority', 'ready', 'status', 'title', 'type',
    'updatedAt'], 'no body, acceptance, metadata or dependency detail, and no field without a value');
  const rest = await list({ limit: 2, offset: first.nextOffset });
  assert.deepEqual([rest.total, rest.tasks.map(task => task.title), rest.nextOffset], [3, ['Later'], null]);
  assert.equal((await list({})).tasks.length, 3, 'the default page holds 50');
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 2.5 }, { offset: -1 }]) {
    assert.match((await call(f, 'list_tasks', { workspace: A, project: P, ...bad })).content[0].text, /^invalid arguments: (limit|offset)/u);
  }
  assert.equal((await call(f, 'get_task', { workspace: A, project: P, task: first.tasks[0].id })).structuredContent.task.title, 'Now');
});

test('a project with hundreds of ready tasks reads in small pages that hold each task once, in order', async () => {
  const f = fixture();
  // As large as a real project's ready list, each task with a long body the list leaves out.
  for (let n = 1; n <= 300; n++) {
    f.tasks.set(`tt-${n}`, { id: `tt-${n}`, title: `Task ${n}`, status: 'open', priority: n % 5,
      created_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(), description: 'x'.repeat(2048), acceptance_criteria: 'y'.repeat(512) });
  }
  const seen = [];
  let offset = 0, pages = 0;
  while (offset !== null) {
    const result = await call(f, 'list_tasks', { workspace: A, project: P, ready: true, offset });
    assert.ok(result.content[0].text.length < 25_000, `page ${pages + 1} is ${result.content[0].text.length} characters`);
    const page = result.structuredContent;
    assert.equal(page.total, 300);
    seen.push(...page.tasks);
    offset = page.nextOffset; pages += 1;
  }
  assert.equal(pages, 6);
  assert.equal(new Set(seen.map(task => task.id)).size, 300, 'every task once');
  assert.ok(seen.every((task, i) => i === 0 || seen[i - 1].priority < task.priority
    || seen[i - 1].priority === task.priority && seen[i - 1].createdAt < task.createdAt), 'most urgent first, then oldest');
});

const DAY = 86_400_000;
const filer = f => async (title, extra = {}) => (await call(f, 'create_task', { workspace: A, project: P, title,
  idempotency_key: `create-${title.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-0001`, ...extra })).structuredContent;

test('list_tasks searches live by words, parent, labels, type and date, and leaves out empty fields', async () => {
  const f = fixture();
  const create = filer(f);
  await create('Launch plan', { type: 'epic' });
  f.advance(DAY);
  await create('Pick the hosting', { type: 'decision', parent: 'tt-1', labels: ['human', 'infra'], description: 'Compare the two providers' });
  await create('Write the launch post', { parent: 'tt-1', labels: ['copy'] });
  f.advance(DAY);
  await call(f, 'update_task', { workspace: A, project: P, task: 'tt-3', priority: 1, idempotency_key: 'agent-update-0101' });
  const list = async extra => (await call(f, 'list_tasks', { workspace: A, project: P, ...extra })).structuredContent;
  const ids = async extra => (await list(extra)).tasks.map(task => task.id).sort();
  assert.deepEqual(await ids({ query: 'LAUNCH' }), ['tt-1', 'tt-3']);
  assert.deepEqual(await ids({ query: 'two providers' }), ['tt-2'], 'a description matches');
  assert.deepEqual(await ids({ query: 'infra' }), ['tt-2'], 'a label matches');
  assert.deepEqual(await ids({ query: 'launch hosting' }), [], 'every word must appear');
  assert.deepEqual(await ids({ parent: 'tt-1' }), ['tt-2', 'tt-3']);
  assert.deepEqual(await ids({ labels: ['human', 'infra'] }), ['tt-2']);
  assert.deepEqual(await ids({ labels: ['human', 'copy'] }), [], 'every label must be carried');
  assert.deepEqual(await ids({ type: ['decision', 'epic'] }), ['tt-1', 'tt-2']);
  assert.deepEqual(await ids({ created_after: '2026-10-08' }), ['tt-2', 'tt-3']);
  assert.deepEqual(await ids({ created_before: '2026-10-08T00:00:00Z' }), ['tt-1']);
  assert.deepEqual(await ids({ updated_after: '2026-10-09' }), ['tt-3']);
  assert.deepEqual(await ids({ updated_before: '2026-10-09', parent: 'tt-1' }), ['tt-2'], 'filters combine');
  assert.equal((await list({ query: 'launch', limit: 1 })).total, 2, 'total counts what the filters keep');
  const rows = Object.fromEntries((await list({})).tasks.map(task => [task.id, task]));
  assert.deepEqual([rows['tt-2'].parent, rows['tt-2'].labels, rows['tt-2'].type], ['tt-1', ['human', 'infra'], 'decision']);
  assert.equal(['parent', 'labels', 'assignee', 'deferUntil', 'closedAt'].some(field => field in rows['tt-1']), false, 'no empty field');
  for (const bad of [{ created_after: 'yesterday' }, { updated_before: '2026-13-40' }, { labels: 'human' }, { parent: 'no id' },
    { type: [3] }, { query: 7 }]) {
    assert.match((await call(f, 'list_tasks', { workspace: A, project: P, ...bad })).content[0].text, /^invalid arguments/u, JSON.stringify(bad));
  }
});

test('a changed, claimed or closed task comes back whole, with its parent and links', async () => {
  const f = fixture();
  const create = filer(f);
  await create('Epic', { type: 'epic' });
  await create('Other');
  await create('Child', { parent: 'tt-1', related: ['tt-2'] });
  const links = [{ id: 'tt-1', type: 'parent-child', title: 'Epic', status: 'open' }, { id: 'tt-2', type: 'related', title: 'Other', status: 'open' }];
  const changed = (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-3', priority: 0, idempotency_key: 'agent-update-0201' })).structuredContent;
  assert.deepEqual([changed.task.parent, changed.task.dependencies, changed.task.priority, changed.replayed], ['tt-1', links, 0, false]);
  const replayed = (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-3', priority: 0, idempotency_key: 'agent-update-0201' })).structuredContent;
  assert.deepEqual([replayed.task.parent, replayed.replayed], ['tt-1', true]);
  const claimed = (await call(f, 'claim_task', { workspace: A, project: P, task: 'tt-3', idempotency_key: 'agent-claim-0201' })).structuredContent;
  assert.deepEqual([claimed.task.parent, claimed.task.dependencies, claimed.task.assignee], ['tt-1', links, PERSON]);
  const closed = (await call(f, 'close_task', { workspace: A, project: P, task: 'tt-3', reason: 'Done in abc123', idempotency_key: 'agent-close-0201' })).structuredContent;
  assert.deepEqual([closed.task.parent, closed.task.status, closed.task.ready], ['tt-1', 'closed', false]);
});

test('create_task files a decision with its links and an approval in one call, and a retry files neither twice', async () => {
  const f = fixture();
  const create = filer(f);
  await create('Ship it', { acceptance: 'Live' });
  await create('Design', { acceptance: 'Drawn' });
  const args = { workspace: A, project: P, title: 'Pick the store', type: 'decision', labels: ['human'], depends_on: ['tt-2'], blocks: ['tt-1'],
    related: [], approval: 'Approve the spend', idempotency_key: 'agent-create-0301' };
  const made = (await call(f, 'create_task', args)).structuredContent;
  assert.deepEqual(made, { id: 'tt-3', project: 'example', replayed: false, approval: { id: 'tt-4', status: 'open', reason: 'Approve the spend' },
    held: true, note: 'tt-3 is out of ready work until a person approves tt-4 on Tasks in the Tower.', lint: { missing: ['## Decision'] } });
  const read = async id => (await call(f, 'get_task', { workspace: A, project: P, task: id })).structuredContent.task;
  assert.deepEqual((await read('tt-3')).dependencies.map(link => [link.id, link.type]), [['tt-2', 'blocks'], ['tt-4', 'blocks']]);
  assert.deepEqual((await read('tt-1')).dependencies.map(link => [link.id, link.type]), [['tt-3', 'blocks']]);
  const ready = (await call(f, 'list_tasks', { workspace: A, project: P, ready: true })).structuredContent.tasks.map(task => task.id);
  assert.deepEqual(ready, ['tt-2']);
  assert.deepEqual((await call(f, 'create_task', args)).structuredContent, { ...made, replayed: true });
  assert.deepEqual(f.effects.filter(([kind]) => kind === 'create' || kind === 'gate').map(([, id]) => id), ['tt-1', 'tt-2', 'tt-3', 'tt-4']);

  const error = async extra => (await call(f, 'create_task', { workspace: A, project: P, title: 'Linked', idempotency_key: 'agent-create-0302', ...extra })).content[0].text;
  assert.match(await error({ type: 'gate' }), /^invalid arguments: type \(a gate holds another task.*request_human_approval/u);
  assert.match(await error({ parent: 'tt-1', related: ['tt-1'] }), /^invalid arguments: the parent is linked already/u);
  assert.match(await error({ related: ['tt-1'], blocks: ['tt-1'] }), /^invalid arguments: a linked task is named twice/u);
  assert.match(await error({ depends_on: ['#0'] }), /^invalid arguments: depends_on/u, 'a place reference is only for create_tasks');
  assert.match(await error({ depends_on: ['tt-99'], idempotency_key: 'agent-create-0303' }), /^refused:/u);
  assert.equal(f.tasks.size, 4, 'a link to a missing task files nothing');
});

test('create_tasks files many in one call, links them by place, and a retry files none twice', async () => {
  const f = fixture();
  const batch = (tasks, idempotency_key) => call(f, 'create_tasks', { workspace: A, project: P, tasks, idempotency_key });
  const plan = [
    { title: 'Launch', type: 'epic' },
    { title: 'Pick the host', type: 'decision', parent: '#0', labels: ['human'] },
    { title: 'Deploy', parent: '#0', depends_on: ['#1'], acceptance: 'It serves' },
    { title: 'Announce', parent: '#0', depends_on: ['#2'], approval: 'Approve the post', acceptance: 'Posted' },
  ];
  const first = (await batch(plan, 'agent-batch-0001')).structuredContent;
  assert.deepEqual(first.created.map(row => [row.index, row.id, row.replayed]), [[0, 'tt-1', false], [1, 'tt-2', false], [2, 'tt-3', false], [3, 'tt-4', false]]);
  assert.deepEqual([first.project, first.created[1].lint, first.created[2].lint], ['example', { missing: ['## Decision'] }, { missing: [] }]);
  assert.deepEqual([first.created[3].approval, first.created[3].held], [{ id: 'tt-5', status: 'open', reason: 'Approve the post' }, true]);
  assert.match(first.note, /out of ready work until a person approves/u);
  assert.equal('failed' in first, false);
  const deploy = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-3' })).structuredContent.task;
  assert.deepEqual([deploy.parent, deploy.dependencies.map(link => [link.id, link.type])], ['tt-1', [['tt-1', 'parent-child'], ['tt-2', 'blocks']]]);
  const again = (await batch(plan, 'agent-batch-0001')).structuredContent;
  assert.deepEqual(again.created.map(row => [row.id, row.replayed]), [['tt-1', true], ['tt-2', true], ['tt-3', true], ['tt-4', true]]);
  assert.equal(f.effects.filter(([kind]) => kind === 'create' || kind === 'gate').length, 5, 'nothing filed twice');
  assert.match((await batch([...plan.slice(0, 3), { title: 'Changed' }], 'agent-batch-0001')).structuredContent.failed.error, /^conflict:/u,
    'a changed entry under the same key is refused, not filed');

  // A refused task stops the call there and says what was filed.
  const stopped = (await batch([{ title: 'Fine' }, { title: 'Broken', depends_on: ['tt-99'] }, { title: 'Never', depends_on: ['#1'] }],
    'agent-batch-0002')).structuredContent;
  assert.deepEqual([stopped.created.map(row => row.id), stopped.failed.index, stopped.notAttempted], [['tt-6'], 1, 1]);
  assert.match(stopped.failed.error, /^refused:/u);
  assert.match(stopped.retry, /same idempotency_key/u);

  // Every entry is read before any is filed.
  const before = f.effects.length;
  const invalid = async (tasks, pattern) => assert.match((await batch(tasks, 'agent-batch-0003')).content[0].text, pattern);
  await invalid([{ title: 'A' }, { title: '' }], /^invalid arguments: tasks\[1\]: title/u);
  await invalid([{ title: 'A', parent: '#0' }], /^invalid arguments: tasks\[0\]: parent \(#n names an earlier task/u);
  await invalid([{ title: 'A' }, { title: 'B', depends_on: ['#5'] }], /^invalid arguments: tasks\[1\]: depends_on/u);
  await invalid([{ title: 'A', owner: 'me' }], /^invalid arguments: tasks\[0\]: unknown owner/u);
  await invalid([], /^invalid arguments: tasks/u);
  await invalid(Array.from({ length: 26 }, (_, n) => ({ title: `T${n}` })), /^invalid arguments: tasks \(1–25\)/u);
  assert.equal(f.effects.length, before, 'a malformed call files nothing');
});

test('awaitingHuman reads as Your decisions does: an open human gate, or a ready task labelled human', async () => {
  const f = fixture();
  const create = filer(f);
  await create('Answer the question', { labels: ['human'] });
  await create('Prerequisite');
  await create('Later question', { labels: ['human'], depends_on: ['tt-2'] });
  await call(f, 'request_human_approval', { workspace: A, project: P, task: 'tt-2', reason: 'Approve the plan' });
  const rows = Object.fromEntries((await call(f, 'list_tasks', { workspace: A, project: P })).structuredContent.tasks.map(task => [task.id, task]));
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([id, task]) => [id, task.awaitingHuman])),
    { 'tt-1': true, 'tt-2': false, 'tt-3': false, 'tt-4': true }, 'a blocked task labelled human waits on its blocker first');
  assert.equal((await call(f, 'get_task', { workspace: A, project: P, task: 'tt-1' })).structuredContent.task.awaitingHuman, true);
  const marked = (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-2', add_labels: ['human'], idempotency_key: 'agent-update-0501' })).structuredContent;
  assert.deepEqual([marked.task.labels, marked.task.ready, marked.task.awaitingHuman], [['human'], false, false], 'held by its gate, so not yet');
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

test('an agent names its model on claim and close; the task shows who closed it with that model', async () => {
  const f = fixture();
  await call(f, 'create_task', { workspace: A, project: P, title: 'Fix the export button', idempotency_key: 'agent-create-0101' });
  const claimed = (await call(f, 'claim_task', { workspace: A, project: P, task: 'tt-1', model: 'Opus 5.5', idempotency_key: 'agent-claim-0101' })).structuredContent;
  assert.equal(claimed.task.metadata.noticeos_claimed_model, 'Opus 5.5');
  const closed = (await call(f, 'close_task', { workspace: A, project: P, task: 'tt-1', reason: 'Exports pass · 3f2a91c', model: 'Opus 5.5',
    idempotency_key: 'agent-close-0101' })).structuredContent;
  assert.deepEqual([closed.task.metadata.noticeos_closed_by, closed.task.metadata.noticeos_closed_model], [PERSON, 'Opus 5.5']);
  assert.match((await call(f, 'close_task', { workspace: A, project: P, task: 'tt-1', reason: 'Done', model: 'two\nlines',
    idempotency_key: 'agent-close-0102' })).content[0].text, /^invalid arguments: model/u);
});
