import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedMcp, MCP_PATH, READ_MODELS_HEADER } from './hosted-mcp.mjs';
import { McpToolError, MCP_MODERN_VERSIONS } from './mcp-protocol.mjs';
import { READ_MODEL_TOOL_NAMES } from './read-model-tools.mjs';
import { WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { noTasksGuide, TASK_MCP_TOOLS, taskGuide } from './hosted-task-mcp.mjs';

// scripts/hosted-mcp.mts: NoticeOS's one MCP endpoint. One connection and one
// token reach every tool in every workspace its person belongs to; each call
// names its workspace, where the person's role bounds the token's scopes.
// Read-model tools are forwarded to the Worker. A hosted workspace has no task
// service; the demo's task tools run in the demo's own Ntasks.

const [A, B, PERSON] = ['11111111', '22222222', '55555555'].map(prefix => `${prefix}-1111-4111-8111-111111111111`);
const DEMO = '99999999-1111-4111-8111-111111111111';
const origin = 'https://tower.example.test';
const FULL = 'agent-token-full-0000000001', READER = 'agent-token-read-0000000002';
const TOKENS = new Map([[FULL, ['tasks:read', 'tasks:write', 'evidence:read']], [READER, ['tasks:read', 'evidence:read']]]);
const token = request => request.headers.get('authorization')?.slice('Bearer '.length);

/** `taskTools`: the demo's Ntasks, recording each task tool call it is sent. */
function fixture({ profile = 'hosted', readModels, taskTools } = {}) {
  const forwarded = [], ran = [];
  const agents = profile === 'demo' ? undefined : {
    verify: async request => TOKENS.has(token(request)) ? { scopes: TOKENS.get(token(request)) } : null,
    workspaces: async () => [{ workspaceId: A, displayName: 'Operated', role: 'operator', status: 'active' },
      { workspaceId: B, displayName: 'Viewed', role: 'viewer', status: 'active' }],
  };
  const mcp = createHostedMcp({ profile, trustedOrigin: origin, ...(profile === 'demo' ? { demoWorkspaceId: DEMO,
    taskTools: async (name, args) => { ran.push({ name, args }); return taskTools ? taskTools(name, args) : { tasks: [] }; } } : {}),
    ...(agents ? { agents } : {}),
    readModels: readModels ?? (async request => {
      forwarded.push({ url: request.url, headers: new Headers(request.headers), body: await request.json() });
      const { name, arguments: args } = forwarded.at(-1).body.params;
      return Response.json({ jsonrpc: '2.0', id: 1, result: name === 'property_report' && args.asset === 'missing'
        ? { content: [{ type: 'text', text: 'no property with id missing' }], isError: true }
        : { content: [{ type: 'text', text: '{}' }], structuredContent: { properties: [{ asset: 'example.com' }] } } });
    }) });
  return { mcp, forwarded, ran };
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
  assert.equal(init.result.instructions, discovered.instructions);
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()).result;
  assert.deepEqual((await (await f.mcp(modern('tools/list'))).json()).result.tools, tools, 'one tool list in both eras');
  // A hosted workspace has no task service: no task tool is listed.
  assert.deepEqual(tools.map(tool => tool.name), ['list_workspaces', 'get_task_guide', ...READ_MODEL_TOOL_NAMES]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.inputSchema.required.includes('workspace'), !['list_workspaces', 'get_task_guide'].includes(tool.name), `${tool.name} names its workspace`);
  }
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
  assert.deepEqual(f.forwarded, [], 'no transport refusal reaches the Worker');
});

test('get_task_guide returns the whole guide with a version, and the instructions are lines of it', async () => {
  for (const [profile, expected] of [['hosted', noTasksGuide(false)], ['demo', taskGuide(false)]]) {
    const f = fixture({ profile });
    const bearer = profile === 'demo' ? null : READER;
    const instructions = (await (await f.mcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { bearer }))).json()).result.instructions;
    const reply = await call(f, 'get_task_guide', {}, { bearer });
    const { version, guide } = reply.structuredContent;
    assert.deepEqual(reply.structuredContent, expected, profile);
    assert.match(version, /^[0-9a-f]{12}$/u);
    // One source: every instruction line but the pointer to the guide is a line of the guide.
    if (profile === 'demo') for (const line of instructions.split('\n').filter(line => line && !line.startsWith('get_task_guide returns'))) {
      assert.ok(guide.includes(line), `${profile}: ${line}`);
    }
    else assert.match(instructions, /has no task service connected/u);
    assert.equal((await call(f, 'list_workspaces', {}, { bearer })).structuredContent.guideVersion, version, profile);
    assert.match((await call(f, 'get_task_guide', { workspace: A }, { bearer })).content[0].text, /takes none/u);
    assert.deepEqual(f.ran, [], 'the guide runs no task tool');
  }
  assert.notEqual(taskGuide(true).version, taskGuide(false).version);
});

test('list_workspaces shows every workspace with what this connection may do there', async () => {
  const f = fixture();
  assert.deepEqual((await call(f, 'list_workspaces', {})).structuredContent, { guideVersion: noTasksGuide(false).version, workspaces: [
    { workspaceId: A, name: 'Operated', role: 'operator', status: 'active', access: ['tasks:read', 'tasks:write', 'evidence:read'] },
    { workspaceId: B, name: 'Viewed', role: 'viewer', status: 'active', access: ['tasks:read', 'evidence:read'] }] });
  assert.match((await call(f, 'list_workspaces', { workspace: A })).content[0].text, /^invalid arguments/u);
});

test('a hosted task tool call is refused with where the tasks are, after the token\'s scopes are checked', async () => {
  const f = fixture();
  const refused = await call(f, 'list_tasks', { workspace: A, project: 'example' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^refused: This installation has no task service connected/u);
  // A read-only token is asked to step up before anything else.
  const narrow = await call(f, 'create_task', { workspace: A, title: 'x' }, { bearer: READER, status: 403 });
  assert.equal(narrow.headers.get('www-authenticate'), `Bearer error="insufficient_scope", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:write"`);
  assert.match((await call(f, 'list_tasks', { project: 'example' })).content[0].text, /^invalid arguments: workspace/u);
  assert.deepEqual(f.forwarded, []);
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

test('the demo takes no credential, lists its one workspace and its task tools, and runs each in its own Ntasks', async () => {
  const demo = fixture({ profile: 'demo', taskTools: async name => {
    if (name === 'create_task') throw new McpToolError('refused: the demo only reads.');
    if (name === 'get_task') throw new Error('the Ntasks behind it failed');
    return { tasks: [{ id: 'ex-1' }] };
  } });
  const anonymous = async (name, args) => (await (await demo.mcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { bearer: null }))).json()).result;
  const { tools } = (await (await demo.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { bearer: null }))).json()).result;
  assert.deepEqual(tools.map(tool => tool.name), ['list_workspaces', 'get_task_guide', ...TASK_MCP_TOOLS.map(tool => tool.name), ...READ_MODEL_TOOL_NAMES]);
  for (const tool of tools) assert.doesNotMatch(JSON.stringify(tool), /\bbeads?\b|\bbd\b|\bissue/iu, `${tool.name} speaks in tasks`);
  // No human decision is a tool: write access never answers its own question.
  assert.equal(tools.some(tool => /respond|dismiss|resolve|gate|decide|choose|pick/u.test(tool.name)), false);
  assert.equal((await anonymous('list_workspaces', {})).structuredContent.workspaces[0].workspaceId, DEMO);
  assert.deepEqual((await anonymous('list_tasks', { workspace: DEMO, project: 'ex' })).structuredContent, { tasks: [{ id: 'ex-1' }] });
  assert.deepEqual(demo.ran, [{ name: 'list_tasks', args: { workspace: DEMO, project: 'ex' } }]);
  assert.equal((await anonymous('create_task', { workspace: DEMO, title: 'x' })).content[0].text, 'refused: the demo only reads.');
  assert.match((await anonymous('get_task', { workspace: DEMO, project: 'ex', task: 'ex-1' })).content[0].text, /^refused:/u);
  assert.match((await anonymous('list_tasks', { workspace: A, project: 'ex' })).content[0].text, /^invalid arguments: workspace/u);
  assert.equal(demo.ran.length, 3, 'a call naming another workspace runs nothing');
  assert.equal((await demo.mcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }))).status, 400, 'a demo token is never accepted');
});

test('task card schemas preserve required fields, bounds and nullable edits', async () => {
  const f = fixture({ profile: 'demo' });
  const { tools } = (await (await f.mcp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { bearer: null }))).json()).result;
  const input = name => tools.find(tool => tool.name === name).inputSchema;
  for (const properties of [input('create_task').properties, input('create_tasks').properties.tasks.items.properties, input('update_task').properties]) {
    assert.deepEqual(properties.card.required, ['valuePerMonth', 'likelihood', 'reviewMinutes', 'daysToSignal', 'measurability']);
    const { likelihood, daysToSignal } = properties.card.properties;
    assert.deepEqual([likelihood.minimum, likelihood.maximum, daysToSignal.type], [0.01, 0.99, 'integer']);
    assert.deepEqual(properties.change_class.enum.filter(Boolean), ['content-data', 'copy', 'template', 'feature', 'infra']);
  }
  assert.deepEqual([input('update_task').properties.card.type, input('update_task').properties.change_class.type], [['object', 'null'], ['string', 'null']]);
});

test('each profile takes only its own way to tasks', () => {
  const agents = { verify: async () => null, workspaces: async () => [] };
  const taskTools = async () => ({});
  const taskHome = async () => ({ kind: 'none' });
  for (const options of [
    { profile: 'demo', demoWorkspaceId: DEMO },
    { profile: 'demo', demoWorkspaceId: DEMO, taskTools, taskHome },
    { profile: 'standalone', standaloneWorkspaceId: A },
    { profile: 'standalone', standaloneWorkspaceId: A, taskHome, taskTools },
    { profile: 'hosted', agents, taskHome },
    { profile: 'hosted', agents, taskTools },
  ]) assert.throws(() => createHostedMcp({ trustedOrigin: origin, ...options }), /MCP configuration refused/u, JSON.stringify(Object.keys(options)));
  for (const options of [{ profile: 'demo', demoWorkspaceId: DEMO, taskTools }, { profile: 'standalone', standaloneWorkspaceId: A, taskHome },
    { profile: 'hosted', agents }]) assert.equal(typeof createHostedMcp({ trustedOrigin: origin, ...options }), 'function');
});
