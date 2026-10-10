import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_LEGACY_VERSIONS, MCP_MODERN_VERSIONS, McpRefused, McpToolError, parseMcpMessage, serveMcp,
} from './mcp-protocol.mjs';

// scripts/mcp-protocol.mts: one POST route speaking both MCP
// eras — 2026-07-28's self-describing requests and the initialize handshake
// before it — for the task endpoint and the Tower's /api/mcp alike.

const url = 'https://tower.example.test/api/mcp';
const MODERN = MCP_MODERN_VERSIONS[0];
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };

function server() {
  const calls = [];
  return { calls, info: { name: 'example-server', version: '1.0.0' }, instructions: 'Start with echo.',
    tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'refuse', description: 'Refuse.', inputSchema: { type: 'object' } },
      { name: 'fault', description: 'Fault.', inputSchema: { type: 'object' } }],
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'refuse') throw new McpToolError('refused: not yours');
      if (name === 'fault') throw new Error('password=secret in a SQL error');
      return { echoed: args };
    } };
}
function post(body, headers = {}, method = 'POST') {
  return new Request(url, { method, headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
function legacy(method, params, { headers = {}, id = 1 } = {}) {
  return post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, headers);
}
function modern(method, params = {}, { headers = {}, meta = META, id = 1 } = {}) {
  return post({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }, { 'mcp-protocol-version': MODERN,
    'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}), ...headers });
}
async function answer(request, target = server(), options) {
  const response = await serveMcp(request, target, options);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

test('2026-07-28: discovery, cacheable lists and calls with no handshake', async () => {
  const target = server();
  const discovered = await answer(modern('server/discover'), target);
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.body.result, { resultType: 'complete', supportedVersions: [MODERN], capabilities: { tools: {} },
    instructions: 'Start with echo.', ttlMs: 300000, cacheScope: 'public',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'example-server', version: '1.0.0' } } });
  const listed = (await answer(modern('tools/list'), target)).body.result;
  assert.deepEqual([listed.resultType, listed.ttlMs, listed.cacheScope], ['complete', 300000, 'public']);
  assert.deepEqual(listed.tools.map(tool => tool.name), ['echo', 'refuse', 'fault'], 'a deterministic order');
  assert.deepEqual(Object.keys(listed.tools[0]), ['name', 'description', 'inputSchema', 'annotations']);
  assert.deepEqual((await answer(modern('ping'), target)).body.result.resultType, 'complete');

  const called = (await answer(modern('tools/call', { name: 'echo', arguments: { a: 1 } }), target)).body.result;
  assert.deepEqual([called.resultType, called.structuredContent, JSON.parse(called.content[0].text)],
    ['complete', { echoed: { a: 1 } }, { echoed: { a: 1 } }]);
  // A name a header cannot carry plainly arrives base64-encoded and still matches.
  const encoded = `=?base64?${Buffer.from('echo').toString('base64')}?=`;
  assert.equal((await answer(modern('tools/call', { name: 'echo' }, { headers: { 'mcp-name': encoded } }), target)).status, 200);
  // Client info is optional; the client's capabilities are not.
  const withClient = { ...META, 'io.modelcontextprotocol/clientInfo': { name: 'agent', version: '1' } };
  assert.equal((await answer(modern('ping', {}, { meta: withClient }), target)).status, 200);
  const refused = (await answer(modern('tools/call', { name: 'refuse' }), target)).body.result;
  assert.deepEqual([refused.resultType, refused.isError, refused.content[0].text], ['complete', true, 'refused: not yours']);
});

test('2026-07-28: a request whose meta or headers disagree is refused before any tool runs', async () => {
  const target = server();
  const refusal = async (request, status, code) => {
    const { status: got, body } = await answer(request, target);
    assert.deepEqual([got, body.error.code], [status, code], JSON.stringify(body));
    return body.error;
  };
  await refusal(modern('ping', {}, { meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }), 400, -32602);
  const unsupported = await refusal(modern('ping', {}, { meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' },
    headers: { 'mcp-protocol-version': '2027-01-01' } }), 400, -32022);
  assert.deepEqual(unsupported.data, { supported: [MODERN], requested: '2027-01-01' });
  for (const headers of [{ 'mcp-protocol-version': '2025-06-18' }, { 'mcp-protocol-version': '' }, { 'mcp-method': 'tools/list' },
    { 'mcp-name': 'refuse' }, { 'mcp-name': '=?base64?not base64?=' }]) {
    await refusal(modern('tools/call', { name: 'echo' }, { headers }), 400, -32020);
  }
  const missing = modern('tools/call', { name: 'echo' }); missing.headers.delete('mcp-name');
  await refusal(missing, 400, -32020);
  await refusal(modern('resources/list'), 404, -32601);
  await refusal(modern('initialize', { protocolVersion: MODERN }), 404, -32601);
  await refusal(modern('tools/list', { cursor: 'next' }), 200, -32602);
  await refusal(modern('tools/call', { name: 'missing' }), 200, -32602);
  assert.deepEqual(target.calls, []);
});

test('the initialize era: version negotiation, then the version header on every request', async () => {
  const target = server();
  for (const [requested, agreed] of [['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2024-11-05', MCP_LEGACY_VERSIONS[0]],
    [MODERN, MCP_LEGACY_VERSIONS[0]]]) {
    const { body } = await answer(legacy('initialize', { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'agent', version: '1' } }), target);
    assert.deepEqual(body.result, { protocolVersion: agreed, capabilities: { tools: {} },
      serverInfo: { name: 'example-server', version: '1.0.0' }, instructions: 'Start with echo.' });
  }
  assert.equal((await answer(legacy('initialize', { capabilities: {} }), target)).body.error.code, -32602);
  const notified = await serveMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), target);
  assert.equal(notified.status, 202); assert.equal(await notified.text(), '');
  for (const headers of [{}, { 'mcp-protocol-version': '2025-11-25' }, { 'mcp-protocol-version': '2025-03-26' }]) {
    const listed = await answer(legacy('tools/list', undefined, { headers }), target);
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.body.result), ['tools'], 'no 2026-07-28 fields in an older answer');
  }
  const called = (await answer(legacy('tools/call', { name: 'echo', arguments: { b: 'x' } }), target)).body.result;
  assert.deepEqual(called, { content: [{ type: 'text', text: '{"echoed":{"b":"x"}}' }], structuredContent: { echoed: { b: 'x' } } });

  const unsupported = await answer(legacy('ping', undefined, { headers: { 'mcp-protocol-version': '2024-01-01' } }), target);
  assert.deepEqual([unsupported.status, unsupported.body.error.code, unsupported.body.error.data.requested], [400, -32022, '2024-01-01']);
  // A 2026-07-28 header or discovery without the meta is a modern request missing its version.
  for (const request of [legacy('ping', undefined, { headers: { 'mcp-protocol-version': MODERN } }), legacy('server/discover')]) {
    const { status, body } = await answer(request, target);
    assert.deepEqual([status, body.error.code], [400, -32602]);
  }
  const unknown = await answer(legacy('resources/list'), target);
  assert.deepEqual([unknown.status, unknown.body.error.code], [200, -32601], 'never a 404 an older client reads as a lost session');
  assert.equal((await answer(legacy('tools/call', { name: 'missing' }), target)).body.error.code, -32602);
});

test('a tool fault is logged by name only and never echoed', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  for (const request of [legacy('tools/call', { name: 'fault' }), modern('tools/call', { name: 'fault' })]) {
    const { status, body } = await answer(request);
    assert.deepEqual([status, body.error.code, body.error.message], [200, -32603, 'tool fault failed; see the server log']);
    assert.doesNotMatch(JSON.stringify(body), /secret|SQL/u);
  }
  assert.deepEqual(logged.mock.calls.map(call => call.arguments), [['MCP tool failed', 'example-server', 'fault'],
    ['MCP tool failed', 'example-server', 'fault']]);
});

test('the transport: POST only, same origin, bounded strict JSON, one message, and the screen first', async () => {
  const target = server();
  const got = await serveMcp(post(null, {}, 'GET'), target);
  assert.deepEqual([got.status, got.headers.get('allow'), (await got.json()).error.code], [405, 'POST', -32600]);
  assert.equal((await answer(legacy('ping', undefined, { headers: { origin: 'https://elsewhere.example' } }), target)).status, 403);
  assert.equal((await answer(legacy('ping', undefined, { headers: { origin: 'https://tower.example.test' } }), target)).status, 200);
  assert.equal((await answer(legacy('ping', undefined, { headers: { origin: 'https://tower.example.test' } }), target,
    { origin: 'https://public.example' })).status, 403, 'a configured origin replaces the request\'s own');
  assert.equal((await answer(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' }), target)).status, 415);
  for (const [body, status, code] of [
    ['{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/list"}', 400, -32700],
    ['{"jsonrpc":"2.0","id":1,"method":"ping"} trailing', 400, -32700],
    [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { pad: 'x'.repeat(70 * 1024) } } }, 400, -32700],
    [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 400, -32600],
    [{ jsonrpc: '2.0', id: null, method: 'ping' }, 400, -32600],
    [{ jsonrpc: '2.0', id: 1.5, method: 'ping' }, 400, -32600],
    [{ jsonrpc: '1.0', id: 1, method: 'ping' }, 400, -32600],
    [{ jsonrpc: '2.0', id: 1, method: 'ping', extra: true }, 400, -32600],
    [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { action: 'write' } }, 400, -32602],
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: [] } }, 400, -32602],
  ]) {
    const { status: got, body: reply } = await answer(post(body), target);
    assert.deepEqual([got, reply.error.code], [status, code], JSON.stringify(body).slice(0, 80));
  }
  // Parsed objects are ordinary ones a Worker RPC can carry, and "__proto__" stays a field.
  const echoed = await answer(post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"__proto__":{"x":1}}}}'), target);
  assert.deepEqual(Object.getPrototypeOf(target.calls[0][1]), Object.prototype);
  assert.deepEqual(Object.keys(target.calls[0][1]), ['__proto__']);
  assert.equal(JSON.parse(echoed.body.result.content[0].text).echoed.__proto__.x, 1);
  target.calls.length = 0;
  assert.equal((await answer(post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { pad: 'x'.repeat(70 * 1024) } } }),
    target, { maxBytes: 128 * 1024 })).status, 200, 'the bound is the caller\'s');
  const screened = await serveMcp(legacy('tools/call', { name: 'echo' }), target,
    { screen: body => body.method === 'tools/call' ? Response.json({ error: 'screened' }, { status: 403 }) : null });
  assert.equal(screened.status, 403);
  assert.deepEqual(target.calls, []);
});

test('every reader of an MCP body agrees on its shape', () => {
  assert.deepEqual(parseMcpMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'echo', _meta: META } }),
    { id: 'a', method: 'tools/call', params: { name: 'echo', _meta: META }, version: MODERN });
  assert.deepEqual(parseMcpMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'stop' } }),
    { method: 'notifications/cancelled', params: { requestId: 1, reason: 'stop' }, version: null });
  // A method no reader knows parses, and each reader decides; its params are not checked.
  assert.equal(parseMcpMessage({ jsonrpc: '2.0', id: 1, method: 'future/method', params: { any: 1 } }).method, 'future/method');
  for (const value of [null, [], {}, { jsonrpc: '2.0', id: 1, method: '' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] },
    { jsonrpc: '2.0', id: 'x'.repeat(513), method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: [] } },
    { jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': 7 } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }]) {
    assert.throws(() => parseMcpMessage(value), McpRefused, JSON.stringify(value));
  }
});
