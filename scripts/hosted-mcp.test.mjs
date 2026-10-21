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
import { TASK_QUALITY, TASK_WORKFLOW, WHATS_CHANGED, taskGuide, taskRefusal } from './hosted-task-mcp.mjs';
import { createHostedTaskPlanner, TaskStateRefused } from './hosted-task-command.mjs';

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

/** `more`: the workspace's other projects, each { catalog, executor }; a null
 * executor is a project whose task store does not answer. */
function fixture({ profile = 'hosted', readModels, more = [] } = {}) {
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
  const directory = { catalog: async () => Object.freeze([{ projectId: P, logicalKey: 'example', displayName: 'Example', prefix: 'tt' },
    ...more.map(entry => entry.catalog)]) };
  const others = new Map(more.map(entry => [entry.catalog.projectId, entry.executor]));
  const executor = { async execute(proof, workspace, request, controls) {
    if (!others.has(request.projectId)) return fake.executor.execute(proof, workspace, request, controls);
    const other = others.get(request.projectId);
    if (!other) throw new Error('the task store did not answer');
    return other.execute(proof, workspace, request, controls);
  } };
  const selection = profile === 'demo' ? { demoWorkspaceId: DEMO } : {};
  const operations = createHostedTaskOperations({ admission, directory, executor, receipts, now: clock });
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
  const http = createHostedTasksApi({ profile, trustedOrigin: origin, ...selection, admission, directory, executor, receipts });
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
  // Every agent is told to name its model on each new task, claim and close, so its work is credited.
  assert.match(discovered.instructions, /On every create_task, create_tasks, claim_task and close_task, pass model/u);
  // And how to write a task: the one copy of the rules, in every session's instructions.
  assert.equal(init.result.instructions, discovered.instructions);
  for (const rule of TASK_QUALITY) assert.ok(discovered.instructions.includes(rule), rule);
  assert.match(discovered.instructions, /acceptance: the proof that completes it/u);
  // Search before filing, so one piece of work is one task.
  assert.match(discovered.instructions, /Before filing, search with list_tasks query for the title's key words, with no project to search every project\. Work already filed gets a comment, never a second task/u);
  assert.match(discovered.instructions, /list_workspaces returns its version as guideVersion, so read it again when that changes/u);
  // A person's pick is data the Tower draws as buttons, never lettered prose.
  assert.match(discovered.instructions, /When the person picks between options, pass them as choices/u);
  assert.doesNotMatch(discovered.instructions, /lettered options/u);
  assert.doesNotMatch(discovered.instructions, /get_panel/u, 'no panel tools here, so no word of them');
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  assert.deepEqual((await (await f.mcp(modern('tools/list'))).json()).result.tools, tools, 'one tool list in both eras');
  assert.deepEqual(tools.map(tool => tool.name), ['list_workspaces', 'get_task_guide', 'reconcile_task', 'list_projects', 'get_agent_stats', 'list_tasks', 'get_task', 'get_task_history',
    'create_task', 'create_tasks', 'claim_task', 'update_task', 'comment_on_task', 'add_dependency', 'remove_dependency', 'request_human_approval',
    'close_task', ...READ_MODEL_TOOL_NAMES]);
  for (const name of ['create_task', 'create_tasks', 'claim_task', 'close_task']) {
    const tool = tools.find(entry => entry.name === name);
    assert.match(tool.description, /naming your model/u, name);
    assert.match(tool.inputSchema.properties.model.description, /Pass it on every new task, claim and close/u, name);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.inputSchema.required.includes('workspace'), !['list_workspaces', 'get_task_guide'].includes(tool.name), `${tool.name} names its workspace`);
    assert.doesNotMatch(JSON.stringify(tool), /\bbeads?\b|\bbd\b|\bissue/iu, `${tool.name} speaks in tasks`);
  }
  // No human decision is a tool: write access never answers its own question.
  assert.equal(tools.some(tool => /respond|dismiss|resolve|gate|decide|choose|pick/u.test(tool.name)), false);
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

test('the guide opens with what changed, at most three dated lines, and list_workspaces returns its version', async () => {
  assert.ok(WHATS_CHANGED.length >= 1 && WHATS_CHANGED.length <= 3, `${WHATS_CHANGED.length} entries`);
  for (const entry of WHATS_CHANGED) {
    assert.match(entry, /^\d{4}-\d{2}-\d{2}: \S[^\n]*$/u, entry);
    assert.equal(new Date(entry.slice(0, 10)).toISOString().slice(0, 10), entry.slice(0, 10), entry);
  }
  for (const panels of [false, true]) {
    const { version, guide } = taskGuide(panels);
    const sections = guide.split('\n').filter(line => line.startsWith('## '));
    assert.equal(sections[0], '## What changed', 'the first section');
    assert.ok(guide.includes(`## What changed\n\n${WHATS_CHANGED.map(entry => `- ${entry}`).join('\n')}\n\n## Start`), guide);
    assert.match(guide, new RegExp(`^# Working with NoticeOS tasks\n\nGuide version ${version}; list_workspaces returns the current one as guideVersion\\.\n`, 'u'));
  }
  for (const profile of ['hosted', 'demo']) {
    const f = fixture({ profile });
    const bearer = profile === 'demo' ? null : READER;
    const listed = (await call(f, 'list_workspaces', {}, { bearer })).structuredContent;
    assert.equal(listed.guideVersion, (await call(f, 'get_task_guide', {}, { bearer })).structuredContent.version, profile);
  }
});

test('list_workspaces shows every workspace with what this connection may do there', async () => {
  const f = fixture();
  assert.deepEqual((await call(f, 'list_workspaces', {})).structuredContent, { guideVersion: taskGuide(false).version, workspaces: [
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
    note: 'tt-2 waits for the owner’s scoped approval of tt-3. Record an existing answer with reconcile_task; never ask for the same approval again.', created: true }, 'the reply says the task is held');
  assert.deepEqual((await call(f, 'request_human_approval', ask)).structuredContent, { ...opened, created: false }, 'a retry never asks twice');
  assert.deepEqual(await ready(), ['tt-1']);
  assert.equal((await call(f, 'request_human_approval', { ...ask, reason: 'Approve the rollout' })).structuredContent.approval.id, 'tt-4');
  assert.deepEqual(f.effects.filter(([kind]) => kind === 'gate'), [['gate', 'tt-3'], ['gate', 'tt-4']]);

  const error = async (name, args, options) => (await call(f, name, args, options)).content[0].text;
  assert.match(await error('add_dependency', { ...link, depends_on: 'tt-1' }), /cannot depend on itself/u);
  assert.match(await error('add_dependency', { ...link, type: 'parent-child' }), /^invalid arguments: type/u);
  assert.equal(await error('add_dependency', { ...link, task: 'tt-2', depends_on: 'tt-1', type: 'related' }),
    'refused: tt-2 already depends on tt-1 as discovered-from, and a dependency keeps the type it was added with. '
    + 'To record it as related, remove_dependency first, then add it again.', 'an edge is never retyped, and the refusal names the one that stands');
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
    held: true, note: 'tt-3 waits for the owner’s scoped approval of tt-4. Record an existing answer with reconcile_task; never ask for the same approval again.', lint: { missing: ['## Decision'] } });
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
  assert.match(first.note, /waits for the owner’s scoped approval/u);
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

const PICK = { question: 'Which page keeps the traffic?', options: [{ key: 'a', label: 'Keep the old page' },
  { key: 'b', label: 'Redirect to the new page', detail: 'The old page answers 301.', recommended: true }, { key: 'c', label: 'Keep both' }] };

test('a task that needs a person\'s pick carries its choices as data, read back by get_task and list_tasks', async () => {
  const f = fixture();
  const create = filer(f);
  const made = await create('Pick the page', { labels: ['human'], description: 'Choose which page keeps the traffic.', choices: PICK });
  assert.equal('advice' in made.lint, false, 'choices given: no advice');
  assert.deepEqual(f.tasks.get('tt-1').metadata.noticeos_choices, PICK, 'stored in the task\'s metadata');
  const read = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-1' })).structuredContent.task;
  assert.deepEqual([read.choices, read.choice], [PICK, null]);
  assert.deepEqual(read.choices.options.filter(option => option.recommended).map(option => option.key), ['b']);
  const listed = (await call(f, 'list_tasks', { workspace: A, project: P })).structuredContent.tasks;
  assert.deepEqual(listed.map(task => [task.id, task.choices, 'choice' in task]), [['tt-1', PICK, false]], 'a list leaves out a pick not made');
  await create('No pick');
  assert.equal('choices' in (await call(f, 'list_tasks', { workspace: A, project: P, query: 'No pick' })).structuredContent.tasks[0], false);

  // update_task replaces the set whole, or takes it off with null.
  const two = { question: 'Keep it?', options: [{ key: 'a', label: 'Yes', recommended: true }, { key: 'b', label: 'No' }] };
  const update = async (choices, key) => (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', choices, idempotency_key: key })).structuredContent;
  assert.deepEqual((await update(two, 'agent-update-0601')).task.choices, two);
  assert.equal((await update(null, 'agent-update-0602')).task.choices, null);
  assert.equal('noticeos_choices' in f.tasks.get('tt-1').metadata, false);

  // create_tasks takes choices on each entry.
  const batch = (await call(f, 'create_tasks', { workspace: A, project: P, idempotency_key: 'agent-batch-0601',
    tasks: [{ title: 'Ask', labels: ['human'], choices: two }] })).structuredContent;
  assert.deepEqual(f.tasks.get(batch.created[0].id).metadata.noticeos_choices, two);
});

test('a malformed set of choices is refused with the field at fault named, and files nothing', async () => {
  const f = fixture();
  const error = async (choices, name = 'create_task') => (await call(f, name, name === 'create_task'
    ? { workspace: A, project: P, title: 'Pick', choices, idempotency_key: 'agent-create-0701' }
    : { workspace: A, project: P, idempotency_key: 'agent-batch-0701', tasks: [{ title: 'Fine' }, { title: 'Pick', choices }] })).content[0].text;
  assert.equal(await error({ ...PICK, options: PICK.options.slice(1, 2) }), 'invalid arguments: choices.options (2 to 6 options)');
  assert.equal(await error({ ...PICK, options: PICK.options.map(option => ({ ...option, recommended: true })) }),
    'invalid arguments: choices.options (exactly one option with recommended: true; these have 3)');
  assert.equal(await error({ ...PICK, options: [PICK.options[0], { ...PICK.options[1], key: 'x' }, PICK.options[2]] }),
    'invalid arguments: choices.options[1].key (b: keys run a, b, c… in the order the options are shown)');
  assert.match(await error({ ...PICK, question: '' }), /^invalid arguments: choices\.question \(empty\)/u);
  assert.match(await error({ ...PICK, options: PICK.options.slice(1, 2) }, 'create_tasks'), /^invalid arguments: tasks\[1\]: choices\.options/u);
  assert.equal((await call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', choices: ['a', 'b'],
    idempotency_key: 'agent-update-0701' })).content[0].text, 'invalid arguments: choices (an object with question and options)');
  assert.equal(f.effects.length, 0);
  assert.equal(taskRefusal(new TaskStateRefused('tt-1', 'other', { kind: 'chosen', chosen: '(b) Redirect to the new page' })).message,
    'refused: tt-1 already carries a person\'s choice, (b) Redirect to the new page, and its choices stay as they were when it was made. '
    + 'get_task shows the choice; file work that remains with create_task.');
});

/** The line a client whose tool list predates this server is told. */
const staleLine = names => `${names} arrived as text: your client's copy of the task tools predates this server `
  + `(guide version ${taskGuide(false).version}); reconnect the noticeos server to get the current tools`;

test('choices a client sends as JSON text land, and the reply opens with a line saying its tool list is stale', async () => {
  const f = fixture();
  await filer(f)('Pick the page', { labels: ['human'] });
  const update = (choices, key) => call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', choices, idempotency_key: key });
  const landed = await update(JSON.stringify(PICK), 'agent-update-0901');
  assert.equal(landed.isError, undefined, JSON.stringify(landed));
  assert.equal(landed.structuredContent.staleClient, staleLine('choices'));
  assert.ok(landed.content[0].text.startsWith(`{"staleClient":${JSON.stringify(staleLine('choices'))},`), 'the first thing an agent reads');
  assert.deepEqual([landed.structuredContent.task.choices, f.tasks.get('tt-1').metadata.noticeos_choices], [PICK, PICK]);
  // "null" as text takes them off, where the argument takes null.
  const cleared = (await update('null', 'agent-update-0902')).structuredContent;
  assert.deepEqual([cleared.task.choices, cleared.staleClient], [null, staleLine('choices')]);
  // The same choices sent as an object carry no line.
  assert.equal('staleClient' in (await update(PICK, 'agent-update-0903')).structuredContent, false);

  // create_task, and each entry of create_tasks by its place, read text the same way.
  const made = (await call(f, 'create_task', { workspace: A, project: P, title: 'Pick again', choices: JSON.stringify(PICK),
    idempotency_key: 'agent-create-0901' })).structuredContent;
  assert.equal(made.staleClient, staleLine('choices'));
  assert.deepEqual(f.tasks.get(made.id).metadata.noticeos_choices, PICK);
  const batch = (await call(f, 'create_tasks', { workspace: A, project: P, idempotency_key: 'agent-batch-0901',
    tasks: [{ title: 'Fine' }, { title: 'Ask', choices: JSON.stringify(PICK) }, { title: 'Ask too', choices: JSON.stringify(PICK) }] })).structuredContent;
  assert.equal(batch.staleClient, staleLine('tasks[1].choices and tasks[2].choices'));
  assert.deepEqual(batch.created.map(entry => f.tasks.get(entry.id).metadata.noticeos_choices ?? null), [null, PICK, PICK]);
});

test('choices sent as text that is not an object are refused with the stale-client line, then the shape rule', async () => {
  const f = fixture();
  await filer(f)('Pick the page', { labels: ['human'] });
  const before = f.effects.length;
  const refusal = async (choices, key) => (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', choices,
    idempotency_key: key })).content[0].text;
  for (const text of ['a or b', '{"question":', '["a","b"]', '"a"', '7']) {
    assert.equal(await refusal(text, 'agent-update-1001'), `${staleLine('choices')}. invalid arguments: choices (an object with question and options)`, text);
  }
  // JSON text of an object with the wrong shape: the line, then the field at fault.
  assert.equal(await refusal(JSON.stringify({ ...PICK, options: PICK.options.slice(0, 1) }), 'agent-update-1002'),
    `${staleLine('choices')}. invalid arguments: choices.options (2 to 6 options)`);
  // An object with the wrong shape keeps the refusal it had: no line.
  assert.equal(await refusal({ ...PICK, options: PICK.options.slice(0, 1) }, 'agent-update-1003'), 'invalid arguments: choices.options (2 to 6 options)');
  assert.equal(f.effects.length, before, 'nothing written');
});

test('every object argument of the task tools refuses text that is not an object, and writes nothing', async () => {
  const f = fixture();
  await filer(f)('Target');
  const before = f.effects.length;
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  const typed = (schema, type) => schema.type === type || Array.isArray(schema.type) && schema.type.includes(type);
  const found = [];
  for (const tool of tools.filter(entry => !READ_MODEL_TOOL_NAMES.includes(entry.name))) for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
    if (typed(property, 'object')) found.push([tool, name, null]);
    if (typed(property, 'array') && property.items && typed(property.items, 'object')) {
      for (const [inner, entry] of Object.entries(property.items.properties ?? {})) if (typed(entry, 'object')) found.push([tool, name, inner]);
    }
  }
  const named = found.map(([tool, name, inner]) => `${tool.name}.${name}${inner ? `[].${inner}` : ''}`);
  for (const path of ['create_task.choices', 'create_tasks.tasks[].choices', 'update_task.choices']) assert.ok(named.includes(path), path);
  // The smallest call each tool takes: its required arguments, then the object as text.
  const least = { workspace: A, project: P, task: 'tt-1', title: 'Guarded', reason: 'Guarded', text: 'Guarded', idempotency_key: 'agent-guard-0001' };
  for (const [tool, name, inner] of found) {
    const args = Object.fromEntries(tool.inputSchema.required.map(key => [key, least[key]]));
    args[name] = inner ? [{ title: 'Guarded', [inner]: 'not json' }] : 'not json';
    const reply = await call(f, tool.name, args);
    assert.equal(reply.isError, true, `${tool.name}.${name}`);
    assert.ok(reply.content[0].text.startsWith(staleLine(inner ? `${name}[0].${inner}` : name)), reply.content[0].text);
  }
  assert.equal(f.effects.length, before, 'nothing written');
});

/** A project's list, two pages, as list_tasks answered it before it could read every project at once. */
const ONE_PROJECT_REPLY = [
  '{"project":"example","readAt":"2026-10-07T12:02:00.000Z","closedSince":"2026-09-30","total":3,"tasks":['
    + '{"id":"tt-1","title":"Pick the page","status":"open","priority":1,"type":"task","labels":["human"],"ready":true,"awaitingHuman":true,'
    + '"choices":{"question":"Which page keeps the traffic?","options":[{"key":"a","label":"Keep the old page"},'
    + '{"key":"b","label":"Redirect to the new page","detail":"The old page answers 301.","recommended":true},{"key":"c","label":"Keep both"}]},'
    + '"createdAt":"2026-10-07T12:00:00.000Z","updatedAt":"2026-10-07T12:00:00.000Z"},'
    + '{"id":"tt-2","title":"Ship the page","status":"in_progress","priority":2,"type":"task","assignee":"55555555-1111-4111-8111-111111111111",'
    + '"parent":"tt-1","ready":false,"awaitingHuman":false,"createdAt":"2026-10-07T12:01:00.000Z","updatedAt":"2026-10-07T12:01:00.000Z"}],'
    + '"nextOffset":2}',
  '{"project":"example","readAt":"2026-10-07T12:02:00.000Z","closedSince":"2026-09-30","total":3,"tasks":['
    + '{"id":"tt-3","title":"Old idea","status":"closed","priority":2,"type":"task","ready":false,"awaitingHuman":false,'
    + '"createdAt":"2026-10-07T12:02:00.000Z","updatedAt":"2026-10-07T12:02:00.000Z","closedAt":"2026-10-07T12:02:00.000Z","resolution":"wont-do"}],'
    + '"nextOffset":null}',
];

test('list_tasks with a project answers byte for byte as it did before it could read every project', async () => {
  const f = fixture();
  const create = filer(f);
  await create('Pick the page', { labels: ['human'], priority: 1, choices: PICK, description: 'Choose.' });
  f.advance(60_000);
  await create('Ship the page', { parent: 'tt-1', acceptance: 'Shipped' });
  await call(f, 'claim_task', { workspace: A, project: P, task: 'tt-2', model: 'Example Model 1', idempotency_key: 'agent-claim-1101' });
  f.advance(60_000);
  await create('Old idea');
  await call(f, 'close_task', { workspace: A, project: P, task: 'tt-3', reason: 'Not needed', resolution: 'wont-do', idempotency_key: 'agent-close-1101' });
  const pages = [];
  for (const offset of [0, 2]) pages.push((await call(f, 'list_tasks', { workspace: A, project: P, limit: 2, offset })).content[0].text);
  assert.deepEqual(pages, ONE_PROJECT_REPLY);
});

const [Q, R] = ['66666666', '77777777'].map(prefix => `${prefix}-1111-4111-8111-111111111111`);
/** The example project, a second project with tasks of its own (one held by
 * the caller, one by another agent), and a third whose task store does not answer. */
function portfolio() {
  const second = fakeTaskExecutor({ principal: () => PERSON, clock: () => Date.parse('2026-10-07T12:00:00.000Z') });
  const at = minutes => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString();
  for (const [id, title, priority, status, assignee] of [['yy-1', 'Second: held by me', 0, 'in_progress', PERSON],
    ['yy-2', 'Second: held by another', 1, 'in_progress', 'example-agent'], ['yy-3', 'Second: ready', 3, 'open', undefined]]) {
    second.tasks.set(id, { id, title, priority, status, ...(assignee ? { assignee } : {}), created_at: at(priority), updated_at: at(priority) });
  }
  return fixture({ more: [{ catalog: { projectId: Q, logicalKey: 'second', displayName: 'Second', prefix: 'yy' }, executor: second.executor },
    { catalog: { projectId: R, logicalKey: 'down', displayName: 'Down', prefix: 'dn' }, executor: null }] });
}

test('list_tasks with no project lists every project, each row naming its project, and names a project it could not read', async () => {
  const f = portfolio();
  const create = filer(f);
  await create('Example: urgent', { priority: 0 });
  await create('Example: later', { priority: 2 });
  const list = async extra => (await call(f, 'list_tasks', { workspace: A, ...extra })).structuredContent;
  const all = await list({});
  // Most urgent first across projects, then oldest.
  assert.deepEqual(all.tasks.map(task => [task.id, task.project, task.projectName, task.projectId]), [['yy-1', 'second', 'Second', Q],
    ['tt-1', 'example', 'Example', P], ['yy-2', 'second', 'Second', Q], ['tt-2', 'example', 'Example', P], ['yy-3', 'second', 'Second', Q]]);
  assert.deepEqual(Object.keys(all.tasks[0]).slice(0, 4), ['id', 'project', 'projectId', 'projectName']);
  assert.deepEqual([all.total, all.nextOffset, all.readAt, all.closedSince], [5, null, '2026-10-07T12:00:00.000Z', '2026-09-30']);
  assert.deepEqual(all.unavailable, [{ project: 'down', projectId: R, projectName: 'Down' }]);
  // Each project's rows are its own list's rows, with the project named.
  const strip = ({ project: _key, projectId: _id, projectName: _name, ...row }) => row;
  for (const [projectId, key] of [[P, 'example'], [Q, 'second']]) {
    const one = await list({ project: projectId });
    assert.deepEqual(all.tasks.filter(task => task.project === key).map(strip), one.tasks, key);
    assert.deepEqual(Object.keys(one).sort(), ['closedSince', 'nextOffset', 'project', 'readAt', 'tasks', 'total'], key);
  }
  // The same pages and filters as one project's list.
  const first = await list({ limit: 2 }), rest = await list({ limit: 2, offset: first.nextOffset });
  assert.deepEqual([first.total, first.nextOffset, rest.nextOffset], [5, 2, 4]);
  assert.deepEqual([...first.tasks, ...rest.tasks].map(task => task.id), all.tasks.slice(0, 4).map(task => task.id));
  assert.deepEqual((await list({ ready: true })).tasks.map(task => task.id), ['tt-1', 'tt-2', 'yy-3']);
  assert.deepEqual((await list({ query: 'later' })).tasks.map(task => task.id), ['tt-2']);
  // A project the call names must still be one of the workspace's, and the caller's own admission still refuses.
  assert.equal((await call(f, 'list_tasks', { workspace: A, project: 'nope' })).content[0].text, 'invalid arguments: project (a projectId from list_projects)');
  assert.equal((await call(f, 'list_tasks', { workspace: DEMO })).content[0].text, `refused: workspace ${DEMO} is not one of yours; list_workspaces lists yours.`);
});

test('get_agent_stats aggregates across projects and reports unavailable projects without task details', async () => {
  const f = fixture({ more: [{ catalog: { projectId: B, logicalKey: 'second', displayName: 'Second', prefix: 'ot' }, executor: null }] });
  f.tasks.set('tt-a', { id: 'tt-a', title: 'Private task body', status: 'closed', closed_at: '2026-10-07T10:00:00Z',
    started_at: '2026-10-07T08:00:00Z', metadata: { noticeos_claimed_model: 'Opus 5.5' } });
  const result = await call(f, 'get_agent_stats', { workspace: A }, { bearer: READER });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.projects, 2);
  assert.deepEqual(result.structuredContent.broken, ['Second']);
  assert.equal(result.structuredContent.stats.week, 1);
  assert.equal(JSON.stringify(result).includes('Private task body'), false);
  assert.deepEqual(f.calls.map(call => call.operation.kind), ['active-board', 'closed-board']);
  assert.equal((await call(f, 'get_agent_stats', { workspace: A, project: P })).structuredContent.projects, 1);
  assert.equal((await call(f, 'get_agent_stats', { workspace: DEMO })).isError, true);
});

test('list_tasks keeps the tasks an assignee holds, with "me" for the caller as a claim records it', async () => {
  const f = portfolio();
  const create = filer(f);
  await create('Example: mine');
  await create('Example: open');
  await call(f, 'claim_task', { workspace: A, project: P, task: 'tt-1', idempotency_key: 'agent-claim-1201' });
  const ids = async extra => (await call(f, 'list_tasks', { workspace: A, ...extra })).structuredContent.tasks.map(task => task.id);
  assert.deepEqual(await ids({ assignee: 'me' }), ['yy-1', 'tt-1'], 'every project');
  assert.deepEqual(await ids({ assignee: 'me', project: P }), ['tt-1'], 'one project');
  assert.deepEqual(await ids({ assignee: PERSON }), ['yy-1', 'tt-1'], 'the caller by name');
  assert.deepEqual(await ids({ assignee: 'example-agent' }), ['yy-2']);
  assert.deepEqual(await ids({ assignee: 'example_agent' }), ['yy-2'], 'matched as the task client matches a name');
  assert.deepEqual(await ids({ assignee: 'nobody' }), []);
  for (const bad of [{ assignee: '' }, { assignee: 7 }, { assignee: ' me' }, { assignee: 'a\nb' }]) {
    assert.match((await call(f, 'list_tasks', { workspace: A, ...bad })).content[0].text, /^invalid arguments: assignee/u, JSON.stringify(bad));
  }
});

test('only a person picks: the pick hands the task back to ready work, and an agent\'s request is refused', async () => {
  const f = fixture();
  await filer(f)('Pick the page', { labels: ['human'], choices: PICK, acceptance: 'Picked' });
  await call(f, 'claim_task', { workspace: A, project: P, task: 'tt-1', idempotency_key: 'agent-claim-0901' });
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: A };
  const person = (path, body) => f.http(new Request(origin + path, { method: 'POST', headers: { ...headers, [WORKSPACE_SESSION_HEADER]: S },
    body: JSON.stringify({ projectId: P, ...body }) }));
  const agent = (path, body) => f.http(new Request(origin + path, { method: 'POST', headers: { ...headers, authorization: `Bearer ${FULL}` },
    body: JSON.stringify({ projectId: P, ...body }) }));
  const capabilities = await (await f.http(new Request(origin + '/api/tasks/capabilities',
    { headers: { origin, 'sec-fetch-site': 'same-origin', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S } }))).json();
  assert.ok(capabilities.operations.includes('choose'));
  for (const body of [{ option: 'b' }, { option: 'b', note: 'From an agent' }]) assert.equal((await agent('/api/tasks/tt-1/choose', body)).status, 403);
  assert.equal(f.effects.some(([kind]) => kind === 'choose'), false, 'an agent\'s pick never reaches the task');
  for (const body of [{}, { option: 'g' }, { option: 'b', extra: 1 }, { option: 'b', note: '' }]) {
    assert.equal((await person('/api/tasks/tt-1/choose', body)).status, 400, JSON.stringify(body));
  }

  assert.equal((await person('/api/tasks/tt-1/choose', { option: 'b', note: 'Ship it Friday' })).status, 200);
  const { task, comments } = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-1' })).structuredContent;
  assert.deepEqual([task.status, task.assignee, task.labels, task.choice.option, task.choice.label, task.choice.by, task.choice.note],
    ['open', null, [], 'b', 'Redirect to the new page', PERSON, 'Ship it Friday']);
  assert.deepEqual(comments.map(comment => comment.text), ['Chose (b) Redirect to the new page. Ship it Friday']);
  assert.ok((await call(f, 'list_tasks', { workspace: A, project: P, ready: true })).structuredContent.tasks.some(row => row.id === 'tt-1'),
    'ready for any agent');
  const again = await person('/api/tasks/tt-1/choose', { option: 'a' });
  assert.deepEqual([again.status, await again.json()], [409, { error: 'task_refused', detail: 'tt-1 already has a choice: (b) Redirect to the new page.' }]);
  await filer(f)('Plain', { acceptance: 'Done' });
  const none = await person('/api/tasks/tt-2/choose', { option: 'a' });
  assert.deepEqual([none.status, (await none.json()).detail], [409, 'tt-2 offers no options to choose from.']);
});

test('a close names how it ended: each resolution reads back from get_task and list_tasks, and a duplicate links the other task', async () => {
  const f = fixture();
  for (const index of [1, 2, 3, 4, 5, 6, 7]) {
    await call(f, 'create_task', { workspace: A, project: P, title: `Task ${index}`, idempotency_key: `agent-create-091${index}` });
  }
  const close = (task, extra, key) => call(f, 'close_task', { workspace: A, project: P, task, reason: 'What decided it', ...extra, idempotency_key: key });
  const ended = { 'tt-1': 'done', 'tt-2': 'done', 'tt-3': 'wont-do', 'tt-4': 'cant-reproduce', 'tt-5': 'already-handled', 'tt-6': 'duplicate' };
  await close('tt-1', {}, 'agent-close-0911');
  await close('tt-2', { resolution: 'done' }, 'agent-close-0912');
  await close('tt-3', { resolution: 'wont-do' }, 'agent-close-0913');
  await close('tt-4', { resolution: 'cant-reproduce' }, 'agent-close-0914');
  await close('tt-5', { resolution: 'already-handled' }, 'agent-close-0915');
  const duplicate = (await close('tt-6', { resolution: 'duplicate', duplicate_of: 'tt-7' }, 'agent-close-0916')).structuredContent.task;
  assert.deepEqual([duplicate.closeReason, duplicate.resolution, duplicate.duplicateOf], ['What decided it', 'duplicate', 'tt-7'],
    'the reason stays the caller\'s own text');
  assert.ok(f.edges.some(edge => edge.from === 'tt-6' && edge.to === 'tt-7' && edge.type === 'related'));
  for (const [id, resolution] of Object.entries(ended)) {
    const { task } = (await call(f, 'get_task', { workspace: A, project: P, task: id })).structuredContent;
    assert.deepEqual([task.status, task.resolution, task.duplicateOf], ['closed', resolution, id === 'tt-6' ? 'tt-7' : null], id);
  }
  const listed = (await call(f, 'list_tasks', { workspace: A, project: P })).structuredContent.tasks;
  assert.deepEqual(Object.fromEntries(listed.map(row => [row.id, row.resolution ?? null])), { ...ended, 'tt-7': null },
    'an open task carries no resolution');
  assert.equal(listed.find(row => row.id === 'tt-6').duplicateOf, 'tt-7');

  // A close recorded before resolutions existed, or for an earlier close, reads as done.
  f.tasks.get('tt-3').closed_at = '2026-10-08T12:00:00Z';
  assert.equal((await call(f, 'get_task', { workspace: A, project: P, task: 'tt-3' })).structuredContent.task.resolution, 'done');

  const refused = async (extra, cause) => {
    const before = f.effects.length;
    const reply = await close('tt-7', extra, `agent-close-0919-${f.effects.length}-${Object.keys(extra).join('')}`);
    assert.equal(reply.isError, true, String(cause));
    assert.match(reply.content[0].text, cause);
    assert.equal(f.effects.length, before, 'nothing closed');
  };
  await refused({ resolution: 'fixed' }, /^invalid arguments: resolution \(one of done, wont-do, duplicate, cant-reproduce, already-handled\)$/u);
  await refused({ resolution: 'duplicate' }, /^invalid arguments: duplicate_of \(required with resolution duplicate/u);
  await refused({ duplicate_of: 'tt-1' }, /^invalid arguments: duplicate_of \(only with resolution duplicate\)$/u);
  await refused({ resolution: 'duplicate', duplicate_of: 'tt-9' }, /^refused: tt-9 is not a task in projectId .* \(Example\)/u);

  // The Tower's close action carries the same two fields, and names a refused one's cause.
  const person = (id, body) => f.http(new Request(`${origin}/api/tasks/${id}/close`, { method: 'POST', headers: { origin,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S },
    body: JSON.stringify({ projectId: P, ...body }) }));
  assert.equal((await person('tt-7', { reason: 'Nobody asked', resolution: 'fixed' })).status, 400);
  const missing = await person('tt-7', { reason: 'Same work', resolution: 'duplicate', duplicateOf: 'tt-9' });
  assert.deepEqual([missing.status, (await missing.json()).detail], [409, 'tt-9 is not a task in Example.']);
  assert.equal((await person('tt-7', { reason: 'Nobody asked for it' , resolution: 'wont-do' })).status, 200);
  const seven = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-7' })).structuredContent.task;
  assert.deepEqual([seven.closeReason, seven.resolution, seven.metadata.noticeos_closed_by], ['Nobody asked for it', 'wont-do', PERSON]);

  // Dismiss on a person's ask closes as won't do, or as the resolution the person names; never as done.
  const dismiss = (id, body) => f.http(new Request(`${origin}/api/tasks/${id}/dismiss`, { method: 'POST', headers: { origin,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S },
    body: JSON.stringify({ projectId: P, ...body }) }));
  for (const [index, title] of ['Should we?', 'Is it still needed?'].entries()) {
    await call(f, 'create_task', { workspace: A, project: P, title, labels: ['human'], idempotency_key: `agent-create-092${index}` });
  }
  assert.equal((await dismiss('tt-8', { resolution: 'done' })).status, 400);
  assert.equal((await dismiss('tt-8', {})).status, 200);
  assert.equal((await dismiss('tt-9', { reason: 'tt-5 covered it', resolution: 'already-handled' })).status, 200);
  for (const [id, reason, resolution] of [['tt-8', 'Dismissed', 'wont-do'], ['tt-9', 'Dismissed: tt-5 covered it', 'already-handled']]) {
    const asked = (await call(f, 'get_task', { workspace: A, project: P, task: id })).structuredContent.task;
    assert.deepEqual([asked.status, asked.closeReason, asked.resolution], ['closed', reason, resolution], id);
  }
});

test('an answer hands a task that is not a decision back to ready work; a decision still closes on it', async () => {
  const f = fixture();
  const create = filer(f);
  await create('Which host?', { labels: ['human'], acceptance: 'Answered' });
  await create('Pick the host', { type: 'decision', labels: ['human'] });
  const answer = (id, response) => f.http(new Request(`${origin}/api/tasks/${id}/respond`, { method: 'POST', headers: { origin,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S },
    body: JSON.stringify({ projectId: P, response }) }));
  assert.equal((await answer('tt-1', 'Use the managed one')).status, 200);
  const first = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-1' })).structuredContent;
  assert.deepEqual([first.task.status, first.task.labels, first.comments.map(comment => comment.text)], ['open', [], ['Answered: Use the managed one']]);
  assert.equal((await answer('tt-2', 'The managed one')).status, 200);
  const second = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-2' })).structuredContent.task;
  assert.deepEqual([second.status, second.closeReason], ['closed', 'Responded']);
});

test('lint advises a person\'s task whose description offers lettered options as prose', async () => {
  const f = fixture();
  const create = filer(f);
  const advice = lint => lint.advice ?? [];
  for (const [index, description] of ['Pick one.\n(a) Keep it\n(b) Drop it', 'Pick one.\na) Keep it\nb) Drop it', 'Pick one.\n- (a) Keep it\n- (b) Drop it',
    'Pick one.\na. Keep it\nb. Drop it', 'FIX: Choose one. (a) Keep it (b) Drop it (c) Wait'].entries()) {
    const made = await create(`Ask ${index}`, { labels: ['human'], description, acceptance: 'Answered' });
    assert.deepEqual([made.lint.missing, advice(made.lint).length], [[], 1], description);
    assert.match(advice(made.lint)[0], /^choices: the description offers lettered options/u);
  }
  assert.deepEqual(advice((await create('Not a person\'s', { description: '(a) Keep it\n(b) Drop it' })).lint), [], 'only a human task');
  assert.deepEqual(advice((await create('Prose', { labels: ['human'], description: 'Pick a plan (a draft) and ship.' })).lint), []);
  // A change that adds the human label to lettered prose is advised too, and choices settle it.
  await create('Later ask', { description: '(a) Keep it\n(b) Drop it', acceptance: 'Answered' });
  const id = [...f.tasks.values()].find(task => task.title === 'Later ask').id;
  const marked = (await call(f, 'update_task', { workspace: A, project: P, task: id, add_labels: ['human'], idempotency_key: 'agent-update-0801' })).structuredContent;
  assert.equal(advice(marked.lint).length, 1);
  const settled = (await call(f, 'update_task', { workspace: A, project: P, task: id, choices: PICK, idempotency_key: 'agent-update-0802' })).structuredContent;
  assert.deepEqual(settled.lint, { missing: [] });
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

const CARD = { valuePerMonth: 400, likelihood: 0.4, reviewMinutes: 20, daysToSignal: 28, measurability: 'cohort',
  kill: { state: 'RPM below 12 on the changed pages', date: '2026-12-31' } };
/** The task client's arguments for the last write of this kind the executor ran. */
const plannedArgv = (f, kind) => createHostedTaskPlanner([{ workspaceId: A, projectId: P, capability: Symbol() }])(A,
  { projectId: P, operation: f.calls.filter(entry => entry.operation.kind === kind).at(-1).operation }).argv;

test('the tool list documents a card\'s figures with their units and ranges, and the guide says when a task carries one', async () => {
  const f = fixture();
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  const input = name => tools.find(tool => tool.name === name).inputSchema;
  for (const properties of [input('create_task').properties, input('create_tasks').properties.tasks.items.properties, input('update_task').properties]) {
    assert.deepEqual(properties.card.required, ['valuePerMonth', 'likelihood', 'reviewMinutes', 'daysToSignal', 'measurability']);
    const { likelihood, valuePerMonth, daysToSignal, kill } = properties.card.properties;
    assert.deepEqual([likelihood.minimum, likelihood.maximum, daysToSignal.type], [0.01, 0.99, 'integer']);
    assert.match(likelihood.description, /0\.01 to 0\.99/u);
    assert.match(valuePerMonth.description, /USD a month, -1000000 to 1000000/u);
    assert.match(kill.properties.date.description, /due date/u);
    assert.deepEqual(properties.change_class.enum.filter(Boolean), ['content-data', 'copy', 'template', 'feature', 'infra']);
  }
  assert.deepEqual([input('update_task').properties.card.type, input('update_task').properties.change_class.type], [['object', 'null'], ['string', 'null']]);
  const { guide } = taskGuide(false);
  assert.match(guide, /- Work meant to change money carries a card: .*a task without one is listed, not ranked\./u);
  assert.match(guide, /- change_class names the kind of change a task makes, one of content-data, copy, template, feature and infra/u);
});

test('a card and a change class are stored with who wrote the card and when, its kill date is the due date, and get_task and list_tasks return them', async () => {
  const f = fixture();
  const made = (await call(f, 'create_task', { workspace: A, project: P, title: 'Speed up the recipe pages', change_class: 'template',
    card: { ...CARD, by: 'someone else', at: '2020-01-01T00:00:00Z' }, idempotency_key: 'agent-card-0001' })).structuredContent;
  const stored = { ...CARD, by: PERSON, at: '2026-10-07T12:00:00.000Z' };
  assert.deepEqual([f.tasks.get(made.id).metadata.noticeos_card, f.tasks.get(made.id).metadata.noticeos_change_class], [stored, 'template'],
    'the server\'s by and at, never the caller\'s');
  assert.equal(plannedArgv(f, 'create').filter(arg => arg.startsWith('--due=')).join(), '--due=2026-12-31');
  const read = (await call(f, 'get_task', { workspace: A, project: P, task: made.id })).structuredContent.task;
  assert.deepEqual([read.card, read.changeClass], [stored, 'template']);
  await call(f, 'create_task', { workspace: A, project: P, title: 'Tidy the backlog', idempotency_key: 'agent-card-0002' });
  const listed = (await call(f, 'list_tasks', { workspace: A, project: P })).structuredContent.tasks;
  assert.deepEqual(listed.map(task => [task.id, task.card ?? 'none', task.changeClass ?? 'none']),
    [[made.id, stored, 'template'], ['tt-2', 'none', 'none']], 'a list leaves out a card and class a task lacks');
  const plain = (await call(f, 'get_task', { workspace: A, project: P, task: 'tt-2' })).structuredContent.task;
  assert.deepEqual([plain.card, plain.changeClass], [null, null]);

  // create_tasks takes them on each entry.
  const batch = (await call(f, 'create_tasks', { workspace: A, project: P, idempotency_key: 'agent-card-0003',
    tasks: [{ title: 'Fine' }, { title: 'Worth it', card: CARD, change_class: 'copy' }] })).structuredContent;
  assert.deepEqual(batch.created.map(entry => [f.tasks.get(entry.id).metadata.noticeos_card ?? null, f.tasks.get(entry.id).metadata.noticeos_change_class ?? null]),
    [[null, null], [stored, 'copy']]);

  // update_task replaces the card whole, stamped again, and its new kill date moves the due date.
  f.advance(DAY);
  const later = { ...CARD, likelihood: 0.6, kill: { state: 'RPM still below 12', date: '2027-01-31' } };
  const updated = (await call(f, 'update_task', { workspace: A, project: P, task: made.id, card: later, idempotency_key: 'agent-card-0004' })).structuredContent;
  assert.deepEqual(updated.task.card, { ...later, by: PERSON, at: '2026-10-08T12:00:00.000Z' });
  assert.equal(plannedArgv(f, 'update').filter(arg => arg.startsWith('--due=')).join(), '--due=2027-01-31');
  // null takes either off, and leaves the other.
  const uncarded = (await call(f, 'update_task', { workspace: A, project: P, task: made.id, card: null, idempotency_key: 'agent-card-0005' })).structuredContent.task;
  assert.deepEqual([uncarded.card, 'noticeos_card' in uncarded.metadata, uncarded.changeClass], [null, false, 'template']);
  assert.equal(plannedArgv(f, 'update').some(arg => arg.startsWith('--due')), false, 'taking the card off leaves the due date');
  const unclassed = (await call(f, 'update_task', { workspace: A, project: P, task: made.id, change_class: null, idempotency_key: 'agent-card-0006' })).structuredContent.task;
  assert.deepEqual([unclassed.changeClass, 'noticeos_change_class' in unclassed.metadata], [null, false]);
  assert.deepEqual((await call(f, 'update_task', { workspace: A, project: P, task: made.id, change_class: 'feature',
    idempotency_key: 'agent-card-0007' })).structuredContent.task.changeClass, 'feature');
});

test('a card that breaks a rule is refused with the field at fault named, and nothing is written', async () => {
  const f = fixture();
  await filer(f)('Target');
  const before = f.effects.length;
  const error = async (card, name = 'create_task', extra = {}) => (await call(f, name, name === 'create_task'
    ? { workspace: A, project: P, title: 'Worth it', card, idempotency_key: 'agent-card-0101', ...extra }
    : name === 'update_task' ? { workspace: A, project: P, task: 'tt-1', card, idempotency_key: 'agent-card-0102', ...extra }
    : { workspace: A, project: P, idempotency_key: 'agent-card-0103', tasks: [{ title: 'Fine' }, { title: 'Worth it', card, ...extra }] })).content[0].text;
  assert.equal(await error({ ...CARD, likelihood: 1.5 }), 'invalid arguments: card.likelihood (between 0.01 and 0.99)');
  assert.equal(await error({ ...CARD, likelihood: 1.5 }, 'update_task'), 'invalid arguments: card.likelihood (between 0.01 and 0.99)');
  assert.equal(await error({ ...CARD, likelihood: 1.5 }, 'create_tasks'), 'invalid arguments: tasks[1]: card.likelihood (between 0.01 and 0.99)');
  assert.equal(await error({ ...CARD, daysToSignal: 2.5 }), 'invalid arguments: card.daysToSignal (a whole number)');
  assert.equal(await error({ ...CARD, measurability: 'guess' }), 'invalid arguments: card.measurability (one of cohort, holdout, unmeasured)');
  assert.equal(await error({ ...CARD, kill: { state: 'Flat', date: '31/12/2026' } }), 'invalid arguments: card.kill.date (a calendar date, YYYY-MM-DD)');
  assert.match(await error({ ...CARD, score: 3 }), /^invalid arguments: card\.score \(not a field of a card, which takes /u);
  assert.equal(await error(null), 'invalid arguments: card (an object with valuePerMonth, likelihood, reviewMinutes, daysToSignal and measurability)');
  assert.equal(await error(undefined, 'create_task', { change_class: 'refactor' }),
    'invalid arguments: change_class (one of content-data, copy, template, feature, infra)');
  assert.equal(await error(CARD, 'update_task', { change_class: null }), 'invalid arguments: card and change_class (a call either sets these '
    + 'or takes them off with null, not both; take them off in a call of their own)');
  assert.equal(f.effects.length, before);
});

test('a card is set on a closed task as any other edit is', async () => {
  const f = fixture();
  await filer(f)('Shipped already');
  await call(f, 'close_task', { workspace: A, project: P, task: 'tt-1', reason: 'Shipped in abc1234', idempotency_key: 'agent-card-0201' });
  const titled = (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', title: 'Shipped', idempotency_key: 'agent-card-0202' })).structuredContent;
  assert.equal(titled.task.title, 'Shipped', 'an edit to a closed task lands');
  const carded = (await call(f, 'update_task', { workspace: A, project: P, task: 'tt-1', card: CARD, change_class: 'copy',
    idempotency_key: 'agent-card-0203' })).structuredContent;
  assert.deepEqual([carded.task.status, carded.task.card?.likelihood, carded.task.changeClass], ['closed', CARD.likelihood, 'copy']);
});
