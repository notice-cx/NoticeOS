import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { serveMcpStdio } from './mcp-stdio.mjs';
import { MCP_MODERN_VERSIONS, serveMcp } from './mcp-protocol.mjs';

// scripts/mcp-stdio.mts: MCP's stdio transport in front of an MCP POST
// handler. One line in is one message; one line out is its answer.

const URL = 'http://localhost/api/mcp';
const SERVER = { info: { name: 'example', version: '1' }, tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } },
  { name: 'élan', description: 'Echo.', inputSchema: { type: 'object' } }],
  async call(name, args) { if (args.slow) await new Promise(resolve => setTimeout(resolve, 30)); return { name, args }; } };

async function exchange(lines, handle = request => serveMcp(request, SERVER), headers) {
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  const served = serveMcpStdio(handle, { input, output, url: URL, ...(headers ? { headers } : {}) });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await served;
  return written.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const message = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('each line is one message and each answer one line, in either protocol era', async () => {
  const modern = { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSIONS[0], 'io.modelcontextprotocol/clientCapabilities': {} } };
  const answers = await exchange([
    message(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    '',
    message(2, 'tools/call', { name: 'echo', arguments: { a: 1 } }),
    message(3, 'tools/call', { name: 'élan', arguments: {}, ...modern }),
  ]);
  assert.deepEqual(answers.map(answer => answer.id).sort(), [1, 2, 3], 'a notification and a blank line get no answer');
  assert.equal(answers.find(answer => answer.id === 1).result.serverInfo.name, 'example');
  assert.deepEqual(answers.find(answer => answer.id === 2).result.structuredContent, { name: 'echo', args: { a: 1 } });
  // The modern era's routing headers come from the message, a non-ASCII name included.
  assert.equal(answers.find(answer => answer.id === 3).result.resultType, 'complete');
});

test('messages are answered as they finish, each with its own id, and input\'s end waits for them all', async () => {
  const answers = await exchange([message(1, 'tools/call', { name: 'echo', arguments: { slow: true } }),
    message(2, 'tools/call', { name: 'echo', arguments: {} })]);
  assert.deepEqual(answers.map(answer => answer.id), [2, 1]);
});

test('every message carries the headers the server was started with, as an HTTP client\'s would', async () => {
  const seen = [];
  await exchange([message(1, 'ping', {})], async request => { seen.push([request.headers.get('x-noticeos-actor'), request.headers.get('content-type')]);
    return Response.json({ jsonrpc: '2.0', id: 1, result: {} }); }, { 'x-noticeos-actor': 'claude', 'content-type': 'text/plain' });
  assert.deepEqual(seen, [['claude', 'application/json']]);
});

test('an unreadable line or a failed handler is still answered, without the failure\'s details', async () => {
  const [parse] = await exchange(['{not json']);
  assert.deepEqual([parse.id, parse.error.code], [null, -32700]);
  const [failed] = await exchange([message(7, 'ping', {})], async () => { throw new Error('PRIVATE-SENTINEL'); });
  assert.deepEqual([failed.id, failed.error.code], [7, -32603]);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-SENTINEL/u);
});
