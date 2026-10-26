import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedMcp } from './hosted-mcp.mjs';
import { openStandaloneMcp } from './standalone-mcp.mjs';
import { WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { AGENT_SCOPES } from './agent-access.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-1111-4111-8111-111111111111';
const origin = 'http://localhost';
const definition = () => ({ id: 'recipe-save', label: 'Recipe to cookbook', goal: 'Save a recipe',
  kind: 'funnel', status: 'active', steps: [
    { id: 'intent', label: 'Save selected', alternatives: [{ eventName: 'recipe_save_click' }] },
    { id: 'saved', label: 'Recipe saved', withinSeconds: 3600, alternatives: [
      { eventName: 'recipe_save', pagePath: '/recipes/example', parameters: [{ name: 'action', value: 'save' }] },
      { eventName: 'recipe_quickadd', parameters: [{ name: 'action', value: 'save' }] },
    ] },
  ] });
const operations = { write: async () => { throw new Error('task command must not run'); } };
function endpoint(journeys) {
  return createHostedMcp({ profile: 'standalone', trustedOrigin: origin, standaloneWorkspaceId: WORKSPACE,
    operations, ...(journeys ? { journeys } : {}) });
}
async function rpc(handle, method, params, headers = {}) {
  return (await handle(new Request(origin + '/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))).json();
}
const call = (handle, name, args, headers) => rpc(handle, 'tools/call', { name, arguments: args }, headers);

test('journey tools are offered only through an explicitly configured standalone transport', async () => {
  const transport = async () => Response.json({ journeys: [] });
  for (const [configured, handle] of [[false, endpoint()], [true, endpoint(transport)]]) {
    const listed = (await rpc(handle, 'tools/list')).result.tools;
    assert.deepEqual(listed.filter(tool => /journey/u.test(tool.name)).map(tool => tool.name),
      configured ? ['get_journeys', 'save_journey'] : []);
    const access = (await call(handle, 'list_workspaces', {})).result.structuredContent.workspaces[0].access;
    assert.deepEqual(access, ['tasks:read', 'tasks:write', ...(configured ? ['journeys:read', 'journeys:write'] : [])]);
    if (configured) for (const tool of listed.filter(tool => /journey/u.test(tool.name))) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.inputSchema.required.includes('workspace'));
      assert.ok(tool.inputSchema.required.includes('asset'));
    }
  }
  for (const profile of ['hosted', 'demo']) {
    assert.throws(() => createHostedMcp({ profile, trustedOrigin: origin, operations, journeys: transport,
      ...(profile === 'hosted' ? { agents: { verify: async () => ({ scopes: ['tasks:write'] }), workspaces: async () => [] } }
        : { demoWorkspaceId: WORKSPACE }),
    }), /MCP configuration refused/u);
  }
  assert.equal(Object.hasOwn(AGENT_SCOPES, 'journeys:write'), false);
  const missing = await call(endpoint(), 'save_journey', { workspace: WORKSPACE, asset: 'example.com', journey: definition(), edit_token: null });
  assert.match(missing.error.message, /no tool named/u);
});

test('get and save use only the typed journey resource and preserve exact conditions and tokens', async () => {
  const forwarded = [];
  const handle = endpoint(async request => {
    forwarded.push({ method: request.method, path: new URL(request.url).pathname,
      workspace: request.headers.get(WORKSPACE_SELECTION_HEADER), actor: request.headers.get('x-noticeos-actor'),
      readModel: request.headers.get('x-noticeos-mcp-part'), body: request.method === 'PUT' ? await request.json() : null });
    return Response.json(request.method === 'GET' ? { asset: 'example.com', journeys: [], edit_tokens: {} }
      : { saved: true, journey: { ...definition(), version: 1 }, edit_token: 'opaque-token' });
  });
  const headers = { 'x-noticeos-actor': 'codex:journey' };
  assert.equal((await call(handle, 'get_journeys', { workspace: WORKSPACE, asset: 'example.com' }, headers)).result.isError, undefined);
  for (const edit_token of [null, 'opaque-token']) {
    const result = await call(handle, 'save_journey', { workspace: WORKSPACE, asset: 'example.com',
      journey: definition(), edit_token, dry_run: true }, headers);
    assert.equal(result.result.structuredContent.saved, true);
  }
  assert.deepEqual(forwarded, [
    { method: 'GET', path: '/api/assets/example.com/journeys', workspace: WORKSPACE, actor: 'codex:journey', readModel: null, body: null },
    ...[null, 'opaque-token'].map(edit_token => ({ method: 'PUT', path: '/api/assets/example.com/journeys/recipe-save',
      workspace: WORKSPACE, actor: 'codex:journey', readModel: null, body: { journey: definition(), edit_token, dry_run: true } })),
  ]);
});

test('invalid workspace, unknown properties and malformed exact conditions never reach the transport', async () => {
  let sent = 0;
  const handle = endpoint(async () => { sent++; return Response.json({}); });
  const save = { workspace: WORKSPACE, asset: 'example.com', journey: definition(), edit_token: null };
  const variants = [
    { ...save, workspace: OTHER }, { ...save, workspace: 'invalid' },
    { ...save, config_pointer: '/assets/example.com' }, { ...save, asset: '../constants' },
    { ...save, journey: { ...definition(), version: 55 } },
    { ...save, journey: { ...definition(), unknown: true } },
    { ...save, journey: { ...definition(), steps: [] } },
    { ...save, journey: { ...definition(), steps: [{ ...definition().steps[0], withinSeconds: 1 }, definition().steps[1]] } },
    { ...save, journey: { ...definition(), steps: [{ ...definition().steps[0], alternatives: [{ eventName: 'click', unknown: true }] }, definition().steps[1]] } },
    { ...save, journey: { ...definition(), steps: [{ ...definition().steps[0], alternatives: [{ eventName: 'click', pagePath: '/path?query' }] }, definition().steps[1]] } },
    { ...save, journey: { ...definition(), steps: [{ ...definition().steps[0], alternatives: [{ eventName: 'click',
      parameters: [{ name: 'action', value: 'save', extra: true }] }] }, definition().steps[1]] } },
    { ...save, edit_token: 4 }, { ...save, edit_token: '' }, { ...save, edit_token: ' '.repeat(4) },
    { ...save, dry_run: 'yes' },
  ];
  const noToken = { ...save }; delete noToken.edit_token; variants.push(noToken);
  for (const args of variants) {
    const reply = await call(handle, 'save_journey', args);
    assert.equal(reply.result.isError, true, JSON.stringify(args));
    assert.match(reply.result.content[0].text, /^invalid arguments:/u);
  }
  assert.equal((await call(handle, 'get_journeys', { workspace: WORKSPACE, asset: 'example.com', refresh: true })).result.isError, true);
  assert.equal(sent, 0);
});

test('typed endpoint conflicts and failures are tool errors without a provider retry', async () => {
  for (const [status, payload, message] of [
    [409, { error: 'stale_edit', detail: 'Read get_journeys again.' }, /^conflict: Read get_journeys again\./u],
    [403, { error: 'not_allowed' }, /^refused: not_allowed/u],
    [503, { error: 'store_unavailable' }, /^unavailable: store_unavailable/u],
  ]) {
    let sent = 0;
    const handle = endpoint(async () => { sent++; return Response.json(payload, { status }); });
    const reply = await call(handle, 'save_journey', { workspace: WORKSPACE, asset: 'example.com', journey: definition(), edit_token: 'old' });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, message);
    assert.equal(sent, 1);
  }
  const disconnected = endpoint(async () => { throw new Error('connection unavailable'); });
  assert.match((await call(disconnected, 'get_journeys', { workspace: WORKSPACE, asset: 'example.com' })).result.content[0].text,
    /^unavailable: journey management/u);
  const malformed = endpoint(async () => new Response('bad JSON'));
  assert.match((await call(malformed, 'get_journeys', { workspace: WORKSPACE, asset: 'example.com' })).result.content[0].text,
    /^unavailable: journey management/u);
});

test('standalone runtime forwards journey HTTP with actor validation and no read-model marker', async t => {
  const forwarded = [];
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE,
    close: async () => {}, inWorkspace: async () => { throw new Error('unexpected store access'); } },
    receipts: memoryReceipts(Date.now), projects: async () => [], tower: 'http://127.0.0.1:5173',
    fetch: async (url, init) => {
      forwarded.push({ url, method: init.method, headers: new Headers(init.headers), body: init.body });
      return Response.json({ asset: 'example.com', journeys: [] });
    } });
  t.after(() => mcp.close());
  for (const name of ['get_journeys', 'save_journey']) {
    const args = { workspace: WORKSPACE, asset: 'example.com',
      ...(name === 'save_journey' ? { journey: definition(), edit_token: null } : {}) };
    assert.equal((await call(mcp.handle, name, args, { 'x-noticeos-actor': 'codex' })).result.isError, undefined);
    const invalid = await call(mcp.handle, name, args, { 'x-noticeos-actor': 'bad actor' });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /^refused: invalid actor/u);
  }
  assert.equal(forwarded.length, 2);
  assert.deepEqual(forwarded.map(row => [row.url, row.method, row.headers.get(WORKSPACE_SELECTION_HEADER),
    row.headers.get('x-noticeos-actor'), row.headers.get('x-noticeos-mcp-part')]), [
    ['http://127.0.0.1:5173/api/assets/example.com/journeys', 'GET', WORKSPACE, 'codex', null],
    ['http://127.0.0.1:5173/api/assets/example.com/journeys/recipe-save', 'PUT', WORKSPACE, 'codex', null],
  ]);
  assert.deepEqual(JSON.parse(forwarded[1].body), { journey: definition(), edit_token: null });
});

test('journey forwarding preserves browser proof instead of converting it to a native request', async () => {
  const proof = { origin, referer: origin + '/assets', 'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-user': '?1' };
  let forwarded;
  const handle = endpoint(async request => { forwarded = request; return Response.json({ saved: true }); });
  assert.equal((await call(handle, 'save_journey', { workspace: WORKSPACE, asset: 'example.com',
    journey: definition(), edit_token: null }, proof)).result.isError, undefined);
  for (const [name, value] of Object.entries(proof)) assert.equal(forwarded.headers.get(name), value, name);
});

test('standalone journey writes reject cross-site browser proof before the Tower request', async t => {
  const forwarded = [];
  const tower = 'http://127.0.0.1:5173';
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE,
    close: async () => {}, inWorkspace: async () => { throw new Error('unexpected store access'); } },
    receipts: memoryReceipts(Date.now), projects: async () => [], tower,
    fetch: async (url, init) => { forwarded.push({ url, headers: new Headers(init.headers) }); return Response.json({ saved: true }); } });
  t.after(() => mcp.close());
  const args = { workspace: WORKSPACE, asset: 'example.com', journey: definition(), edit_token: null };
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' },
    { 'sec-fetch-site': 'same-origin', referer: 'https://elsewhere.example/page' },
    { referer: 'https://elsewhere.example/page' },
    { origin },
  ]) {
    const reply = await call(mcp.handle, 'save_journey', args, headers);
    assert.equal(reply.result.isError, true, JSON.stringify(headers));
    assert.match(reply.result.content[0].text, /^refused: forbidden/u);
  }
  assert.equal(forwarded.length, 0, 'browser requests must not become headerless local writes');
  const valid = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', referer: tower + '/assets' };
  assert.equal((await call(mcp.handle, 'save_journey', args, valid)).result.isError, undefined);
  assert.equal(forwarded.length, 1);
  for (const [name, value] of Object.entries(valid)) assert.equal(forwarded[0].headers.get(name), value, name);
});


test('save schema and transport admit first-party exploration without GA4 event conditions', async () => {
  let forwarded;
  const handle = endpoint(async request => { forwarded = await request.json(); return Response.json({ saved: true }); });
  const listed = (await rpc(handle, 'tools/list')).result.tools;
  const journeySchema = listed.find(tool => tool.name === 'save_journey').inputSchema.properties.journey;
  assert.equal(journeySchema.anyOf.length, 2);
  assert.deepEqual(journeySchema.anyOf[1].properties.source.enum, ['first-party']);
  assert.deepEqual(journeySchema.anyOf[1].properties.kind.enum, ['exploration']);
  assert.equal(journeySchema.anyOf[1].properties.steps.maxItems, 0);
  assert.deepEqual(journeySchema.anyOf[1].properties.reportingLagDays, { type: 'integer', minimum: 1, maximum: 14, description: 'Complete-report delay in days; defaults to one.' });
  assert.ok(journeySchema.anyOf[1].required.includes('source'));
  const journey = { id: 'section-exploration', label: 'Section exploration', goal: 'First-party session paths between site sections', kind: 'exploration', source: 'first-party', reportingLagDays: 2, status: 'planned', steps: [] };
  const reply = await call(handle, 'save_journey', { workspace: WORKSPACE, asset: 'example.com', journey, edit_token: null, dry_run: true });
  assert.equal(reply.result.structuredContent.saved, true);
  assert.deepEqual(forwarded, { journey, edit_token: null, dry_run: true });
  for (const invalid of [{ ...journey, reportingLagDays: 0 }, { ...journey, reportingLagDays: 15 }, { ...journey, source: 'ga4' }, { ...journey, kind: 'funnel' }, { ...journey, steps: definition().steps }]) {
    forwarded = null;
    assert.equal((await call(handle, 'save_journey', { workspace: WORKSPACE, asset: 'example.com', journey: invalid, edit_token: null })).result.isError, true);
    assert.equal(forwarded, null);
  }
});
