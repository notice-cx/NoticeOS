import assert from 'node:assert/strict';
import test from 'node:test';
import { main, parseOptions } from './local-mcp.mjs';
import { actorOf, openStandaloneMcp } from './standalone-mcp.mjs';

// scripts/standalone-mcp.mts and local-mcp.mjs: a standalone installation's MCP
// endpoint (the Tower's /api/mcp and pnpm os:mcp). Where its tasks live is
// proved in task-service.test.mjs; the served tools in hosted-mcp.test.mjs,
// panel-mcp.test.mjs and journey-mcp.test.mjs. This is their setup.

test('an agent is named with --actor, in the grammar a record takes, or is "agent"', () => {
  assert.deepEqual(parseOptions([]), { actor: 'agent' });
  assert.deepEqual(parseOptions(['--actor', 'claude:review-1']), { actor: 'claude:review-1' });
  for (const argv of [['--actor'], ['--actor', '-x'], ['--actor', 'a b'], ['--http'], ['--actor', 'a', 'b']]) {
    assert.throws(() => parseOptions(argv), /Usage: local-mcp\.mjs \[--actor <name>\]/u, argv.join(' '));
  }
});

test('a refused option stops before anything is read, and a missing database is one sentence', async () => {
  let said = '';
  const err = { write: text => { said += text; } };
  assert.equal(await main(['--actor', 'a b'], { err }), 2);
  assert.match(said, /^Usage/u);
  said = '';
  assert.equal(await main([], { err, secretFiles: { secretsFile: '/nonexistent/.dev.secrets.json', varsFile: '/nonexistent/.dev.vars' } }), 1);
  assert.match(said, /^NoticeOS MCP could not reach the installation's database: could not read \/nonexistent\/\.dev\.vars/u);
});

test('a request acts as the agent its header names, or as agent', () => {
  const named = value => new Request('http://localhost/api/mcp', { headers: value === undefined ? {} : { 'x-noticeos-actor': value } });
  assert.equal(actorOf(named(undefined)), 'agent');
  assert.equal(actorOf(named('claude:review-1')), 'claude:review-1');
  for (const value of ['-x', 'a b', 'x'.repeat(129)]) assert.equal(actorOf(named(value)), null, value);
});

test('the endpoint serves the store\'s one workspace and the Tower\'s read models, with no task tools', async () => {
  const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6', forwarded = [];
  let closed = false;
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => { closed = true; } },
    tower: 'http://127.0.0.1:5173', fetch: async (url, init) => { forwarded.push([url, init.headers.get('x-noticeos-mcp-part')]); return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { properties: [] } } }); } });
  const send = (method, params = {}) => mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))
    .then(response => response.json());
  const call = (name, args) => send('tools/call', { name, arguments: args });
  assert.equal((await call('list_workspaces', {})).result.structuredContent.workspaces[0].workspaceId, WORKSPACE);
  const { tools } = (await send('tools/list')).result;
  assert.equal(tools.some(tool => tool.name === 'list_tasks'), false);
  // With no task service passed, none is connected.
  assert.match((await call('list_tasks', { workspace: WORKSPACE })).result.content[0].text, /^refused: This installation has no task service connected/u);
  assert.deepEqual((await call('list_properties', { workspace: WORKSPACE })).result.structuredContent, { properties: [] });
  assert.deepEqual(forwarded, [['http://127.0.0.1:5173/api/mcp', 'read-models']]);
  await mcp.close();
  assert.equal(closed, true);
  await assert.rejects(openStandaloneMcp({ store: { onlyWorkspace: async () => { throw new Error('no single workspace'); }, close: async () => { closed = 'again'; } } }),
    /no single workspace/u);
  assert.equal(closed, 'again', 'a store that names no workspace is closed');
});
