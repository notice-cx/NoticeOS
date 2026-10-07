import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { atDeadline, fakeClock } from './test-deadline.mjs';
import { GOOGLE_INTEGRATION_START, googleOAuthRequest, OperationRefused, ingestOperation, towerOperation, providerCollectionInput, liveProviderReadRequest, storedResearchReadRequest, watchQueryHistoryRequest } from './workspace-operations.mjs';

const origin = 'https://fixture.example.test';
const request = (path, method = 'GET', body, headers = {}) => new Request(origin + path, {
  method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const set = (file, pointer, value, expect = null) => ({ kind: 'file-json-set', file, pointer, value, expect });
const config = ops => request('/api/config', 'PUT', { ops });
const mcp = (name, args = {}) => request('/api/mcp', 'POST', { jsonrpc: '2.0', id: 1,
  method: 'tools/call', params: { name, arguments: args } });

test('D1 fixed Request edges reject caller-selected URLs, authority, duplicates and malformed selectors', async () => {
  const path = '/api/integrations/cloudflare/d1', accountId = 'a'.repeat(32), databaseId = randomUUID(), runId = randomUUID();
  for (const [original, action] of [
    [request(path), 'integrations.summary.read'], [request(path + '?view=databases'), 'provider.read'],
    [request(path, 'PUT', { version: 1, accountId, targets: [{ databaseId, asset: 'example.com' }] }), 'integrations.write'],
    [request(path, 'POST', { accountId, databaseId }), 'workflows.run'],
    [request(`${path}?view=artifact&accountId=${accountId}&databaseId=${databaseId}&runId=${runId}`), 'workflows.run'],
  ]) {
    assert.equal((await ingestOperation('cloudflareD1', original)).action, action);
    await assert.rejects(ingestOperation('putCredential', original));
  }
  for (const original of [request(path + '?view=databases&view=databases'), request(path + '?url=https://other.example'),
    request(path, 'POST', { accountId, databaseId, workspaceId: randomUUID() }), request(path, 'POST', { accountId: '../account', databaseId }),
    request(path, 'PUT', { version: 1, accountId, targets: [{ databaseId, asset: 'example.com' }, { databaseId, asset: 'other.example' }] }),
    request(`${path}?view=artifact&accountId=${accountId}&databaseId=${databaseId}&runId=../object`),
    request(path, 'PUT', { version: 1, accountId, targets: [], profile: 'standalone' }),
  ]) await assert.rejects(towerOperation(original));
});

test('stored GET and POST evidence keep semantic action across exact helper edges', async () => {
  assert.equal((await towerOperation(request('/api/wall'))).action, 'evidence.read');
  const original = request('/api/alerts/backtest', 'POST', { asset: 'example.test', ruleId: 'pulse_gap', config: { alpha: 0.05, minBaselinePerDay: 3, lowVolumeWindowHours: 72 } });
  const result = await ingestOperation('backtestRule', original);
  assert.equal(result.action, 'evidence.read');
  await assert.rejects(ingestOperation('ga4Realtime', original), OperationRefused);
  await assert.rejects(ingestOperation('getConfigDocuments', original), OperationRefused);
  assert.equal((await ingestOperation('getConfigDocuments', request('/api/financials'))).action, 'evidence.read');
  assert.equal((await ingestOperation('readAssetState', request('/api/assets/example.com', 'PATCH', { column: 'status', value: 'live', expect: 'build' }))).action, 'assets.write');
});

test('provider GET and connection tests are effects, not stored summaries', async () => {
  for (const [path, method, receiver] of [
    ['/api/ga4/realtime', 'GET', 'ga4Realtime'],
    ['/api/calendar/upcoming', 'GET', 'calendarUpcoming'],
    ['/api/integrations/google/properties', 'GET', 'discoverGoogleProperties'],
    ['/api/integrations/google/sites', 'GET', 'discoverSites'],
    ['/api/integrations/google/test', 'POST', 'probeCredential'],
  ]) assert.equal((await ingestOperation(receiver, request(path, method, method === 'POST' ? {} : undefined))).action, 'provider.read');
  assert.equal((await towerOperation(request('/api/site-name?domain=example.com'))).action, 'provider.read');
  assert.equal((await ingestOperation('integrationHealth', request('/api/integrations/health'))).action, 'integrations.summary.read');
  assert.equal((await ingestOperation('listCredentialSummaries', request('/api/integrations/providers'))).action, 'integrations.summary.read');
  assert.equal((await ingestOperation('mediavineStatus', request('/api/integrations/mediavine/status'))).action, 'integrations.summary.read');
  await assert.rejects(ingestOperation('probeCredential', request('/api/integrations/providers')), OperationRefused);
});

test('fixed Google discovery has no caller scope and cannot enter another RPC', async () => {
  const path = '/api/integrations/google/properties';
  for (const suffix of ['?workspace=foreign', '?asset=example.test', '?', '#fragment']) {
    await assert.rejects(ingestOperation('discoverGoogleProperties', request(path + suffix)), OperationRefused);
  }
  for (const method of ['POST', 'PUT', 'HEAD']) {
    await assert.rejects(ingestOperation('discoverGoogleProperties', request(path, method)), OperationRefused);
  }
  await assert.rejects(ingestOperation('discoverGoogleProperties', request('/api/integrations/google/sites')), OperationRefused);
  await assert.rejects(ingestOperation('getConfigDocuments', request(path)), OperationRefused);
});

test('connection readiness accepts only canonical provider paths and the existing empty test JSON', async () => {
  for (const provider of ['google', 'bing-webmaster', 'discord']) {
    assert.equal((await ingestOperation('discoverSites', request(`/api/integrations/${provider}/sites`))).action, 'provider.read');
    assert.equal((await ingestOperation('probeCredential', request(`/api/integrations/${provider}/test`, 'POST', {}))).action, 'provider.read');
  }
  for (const path of ['/api/integrations/google/sites?', '/api/integrations/google/sites?provider=discord',
    '/api/integrations/google%2Ftest/sites', '/api/integrations/Google/sites',
    '/api/integrations/google/test#fragment']) {
    await assert.rejects(towerOperation(request(path, path.includes('/test') ? 'POST' : 'GET', path.includes('/test') ? {} : undefined)), OperationRefused);
  }
  for (const body of [undefined, [], null, { provider: 'discord' }, { actor: 'owner' }, '{', ' '.repeat(65537)]) {
    await assert.rejects(ingestOperation('probeCredential', request('/api/integrations/google/test', 'POST', body)), OperationRefused);
  }
  await assert.rejects(ingestOperation('discoverSites', request('/api/integrations/google/test', 'POST', {})), OperationRefused);
  await assert.rejects(ingestOperation('probeCredential', request('/api/integrations/google/sites')), OperationRefused);
  await assert.rejects(ingestOperation('probeCredential', request('/api/integrations/google/test', 'GET')), OperationRefused);
});

test('a stalled test-body clone refuses within the whole-read budget without waiting for its original branch', { timeout: 5000 }, async (t) => {
  fakeClock(t);
  let release;
  const body = new ReadableStream({ start(controller) { release = () => controller.close(); } });
  const original = new Request(origin + '/api/integrations/google/test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
  });
  try { await assert.rejects(atDeadline(t, ingestOperation('probeCredential', original), 2_000), OperationRefused); }
  finally { release(); await original.body.cancel(); }
});

test('JSON refuses an already aborted request before pulling its body', async () => {
  const controller = new AbortController(); controller.abort();
  let pulls = 0;
  const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
  const original = new Request(origin + '/api/integrations/google/test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half', signal: controller.signal,
  });
  try {
    await assert.rejects(ingestOperation('probeCredential', original), OperationRefused);
    assert.equal(pulls, 0);
  } finally { await original.body.cancel(); }
});

test('JSON cancellation interrupts a pending read before the ordinary body deadline', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let pulled, timer;
  const entered = new Promise(resolve => { pulled = resolve; });
  const body = new ReadableStream({ pull() { pulled(); } }, { highWaterMark: 0 });
  const original = new Request(origin + '/api/integrations/google/test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half', signal: controller.signal,
  });
  const reading = ingestOperation('probeCredential', original);
  try {
    await entered; controller.abort();
    await Promise.race([
      assert.rejects(reading, OperationRefused),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Aborted body still waiting')), 250); }),
    ]);
  } finally { clearTimeout(timer); await original.body.cancel(); await reading.catch(() => undefined); }
});

test('JSON tolerates bounded empty chunks and refuses streams that make no progress', async () => {
  for (const count of [8, 1000]) {
    let pulls = 0;
    const body = new ReadableStream({ pull(controller) {
      if (++pulls <= count) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }
    } }, { highWaterMark: 0 });
    const original = new Request(origin + '/api/integrations/google/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
    });
    try {
      if (count === 8) assert.equal((await ingestOperation('probeCredential', original)).action, 'provider.read');
      else {
        await assert.rejects(ingestOperation('probeCredential', original), OperationRefused);
        assert.ok(pulls < 80, `Stopped reading after ${pulls} chunks`);
      }
    } finally { await original.body.cancel(); }
  }
});

test('mutations and execution use fixed receiver-specific catalog edges', async () => {
  for (const [path, method, receiver, action] of [
    ['/api/assets', 'POST', 'createAsset', 'assets.write'],
    ['/api/assets/example.com/order', 'PATCH', 'moveAsset', 'assets.write'],
    ['/api/assets/example.com', 'PATCH', 'writeAssetColumn', 'assets.write'],
    ['/api/assets/example.com/annotations', 'POST', 'createAnnotation', 'annotations.write'],
    ['/api/assets/example.com/watch-windows', 'POST', 'createWatchWindow', 'measurement.write'],
    ['/api/assets/example.com/watch-query-history?query=fixture&metric=clicks', 'GET', 'watchQueryHistory', 'evidence.read'],
    ['/api/integrations/google/credential', 'PUT', 'putCredential', 'integrations.write'],
    ['/api/integrations/google/credential', 'DELETE', 'deleteCredential', 'integrations.write'],
    ['/api/integrations/google/expiry', 'PUT', 'setCredentialExpiry', 'integrations.write'],
    ['/api/integrations/google/connect', 'POST', 'connectCredential', 'integrations.write'],
    ['/api/integrations/clarity/site-token', 'PUT', 'putSiteToken', 'integrations.write'],
    ['/api/integrations/mediavine/settings', 'PUT', 'saveMediavineSettings', 'integrations.write'],
    ['/api/integrations/google/collect', 'POST', 'collectNow', 'workflows.run'],
    ['/api/integrations/mediavine/sync', 'POST', 'syncMediavine', 'workflows.run'],
  ]) {
    const body = ['putCredential', 'connectCredential'].includes(receiver) ? { fields: { apiKey: randomUUID() } }
      : receiver === 'setCredentialExpiry' ? { expiresAt: null }
      : receiver === 'putSiteToken' ? { asset: 'example.test', token: randomUUID() }
      : receiver === 'collectNow' ? { assets: ['example.test'] }
      : receiver === 'syncMediavine' ? { asset: 'example.test' }
      : receiver === 'moveAsset' ? { to: 'other.test' }
      : receiver === 'createAsset' ? { id: 'example.com', displayName: 'Example' }
      : receiver === 'writeAssetColumn' ? { column: 'status', value: 'live', expect: 'build' }
      : receiver === 'createAnnotation' ? { kind: 'ship' } : undefined;
    assert.equal((await ingestOperation(receiver, request(path, method, body))).action, action);
  }
  assert.equal((await towerOperation(request('/api/flags/17', 'PATCH', { action: 'acknowledge' }))).action, 'findings.write');
  assert.equal((await towerOperation(request('/api/assets/example.com/decisions', 'DELETE', { kind: 'query', key: 'fixture' }))).action, 'findings.write');
});

test('credential lifecycle grammar preserves the fixed body and rejects extra authority or secret metadata', async () => {
  const fields = { apiKey: randomUUID() };
  for (const [suffix, method, rpc, body] of [
    ['credential', 'PUT', 'putCredential', { fields }],
    ['credential', 'DELETE', 'deleteCredential', undefined],
    ['connect', 'POST', 'connectCredential', { fields }],
    ['expiry', 'PUT', 'setCredentialExpiry', { expiresAt: null }],
    ['site-token', 'PUT', 'putSiteToken', { asset: 'example.test', token: randomUUID() }],
  ]) {
    const proof = request(`/api/integrations/clarity/${suffix}`, method, body);
    const selected = await ingestOperation(rpc, proof);
    assert.equal(selected.action, 'integrations.write'); assert.deepEqual(selected.rpcMethods, [rpc]);
    if (body !== undefined) assert.deepEqual(await proof.json(), body);
    for (const extra of ['?workspace=foreign', '?', '#fragment'])
      await assert.rejects(towerOperation(request(`/api/integrations/clarity/${suffix}` + extra, method, body)), OperationRefused);
  }
  for (const suffix of ['credential', 'connect']) {
    const method = suffix === 'connect' ? 'POST' : 'PUT';
    for (const body of [undefined, null, [], {}, { fields: [] }, { fields: { apiKey: 1 } },
      { fields, provider: 'google' }, { fields, metadata: { account: 'forged@example.test' } },
      { fields, actor: 'owner' }, { fields, workspaceId: randomUUID() }, { fields, action: 'settings.write' }])
      await assert.rejects(towerOperation(request(`/api/integrations/clarity/${suffix}`, method, body)), OperationRefused);
  }
  for (const body of [undefined, {}, { expiresAt: 1 }, { expiresAt: null, actor: 'owner' }])
    await assert.rejects(towerOperation(request('/api/integrations/google/expiry', 'PUT', body)), OperationRefused);
  for (const body of [undefined, { asset: 'example.test' }, { asset: 1, token: randomUUID() },
    { asset: 'example.test', token: randomUUID(), provider: 'google' }])
    await assert.rejects(towerOperation(request('/api/integrations/clarity/site-token', 'PUT', body)), OperationRefused);
  await assert.rejects(towerOperation(request('/api/integrations/google/credential', 'DELETE', {})), OperationRefused);
});

test('classification never accepts claimed action, actor, profile or serialized results', async () => {
  const forged = request('/api/wall?actor=owner&profile=standalone&action=tasks.write', 'GET', undefined,
    { 'x-noticeos-action': 'tasks.write', 'x-noticeos-profile': 'standalone', 'x-noticeos-actor': 'owner' });
  const result = await towerOperation(forged);
  assert.equal(result.action, 'evidence.read');
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.rpcMethods), true);
  assert.throws(() => { result.action = 'tasks.write'; }, TypeError);
  await assert.rejects(towerOperation(JSON.parse(JSON.stringify(result))), OperationRefused);
  await assert.rejects(ingestOperation(result, forged), OperationRefused);
});

test('unsupported methods, paths and receiver names cannot inherit classification', async () => {
  for (const [path, method] of [['/api/wall', 'POST'], ['/api/future', 'GET'],
    ['/api/assets/example.com%2Fdecisions', 'GET'], ['/api/runner/future', 'GET'],
    ['/api/tasks/x/reopen', 'POST'], ['/api/integrations/google/status', 'GET']]) {
    await assert.rejects(towerOperation(request(path, method)), OperationRefused);
  }
  for (const receiver of ['future', '__proto__', 'getConfigDocument', 'runScheduled', 'fetch', 'createAsset']) {
    await assert.rejects(ingestOperation(receiver, request('/api/wall')), OperationRefused);
  }
});

test('native task/workflow reads classify without granting native capability', async () => {
  for (const path of ['/api/tasks', '/api/tasks/capabilities', '/api/tasks/demo-123']) {
    assert.equal((await towerOperation(request(path))).action, 'tasks.read');
  }
  for (const [path, method] of [['/api/tasks', 'POST'], ['/api/tasks/demo-123', 'PATCH'],
    ['/api/tasks/demo-123/comments', 'POST'], ['/api/tasks/demo-123/close', 'POST']]) {
    assert.equal((await towerOperation(request(path, method))).action, 'tasks.write');
  }
  assert.equal((await towerOperation(request('/api/workflows?run=fixture'))).action, 'workflows.read');
  for (const path of ['/api/tasks/demo-123/respond', '/api/tasks/demo-123/dismiss', '/api/gates/demo-123/resolve']) {
    assert.equal((await towerOperation(request(path, 'POST'))).kind, 'standalone-only');
  }
});

test('public liveness and standalone runner/import are distinct from workspace authority', async () => {
  assert.deepEqual(await towerOperation(request('/api/health')), { kind: 'public', action: null, rpcMethods: [] });
  assert.equal((await ingestOperation('runScheduled', request('/api/runner/scheduled?cron=fixture'))).kind, 'standalone-only');
  assert.equal((await ingestOperation('fetch', request('/api/runner/ingest/api/pulse', 'POST'))).kind, 'standalone-only');
  assert.equal((await towerOperation(request('/api/integrations/import-env'))).kind, 'standalone-only');
  await assert.rejects(ingestOperation('fetch', request('/api/runner/scheduled')), OperationRefused);
  await assert.rejects(towerOperation(request('/api/runner/ingest/api/future')), OperationRefused);
});

test('OAuth callback stays protocol-only until durable custody qualifies', async () => {
  assert.equal((await ingestOperation('beginGoogleOAuth', request('/api/integrations/google/oauth/start'))).action, 'integrations.write');
  const callback = await ingestOperation('completeGoogleOAuth', request('/api/integrations/google/oauth/callback?state=fixture'));
  assert.equal(callback.kind, 'protocol'); assert.equal(callback.action, null);
  await assert.rejects(ingestOperation('completeGoogleOAuth', request('/api/integrations/google/oauth/start')), OperationRefused);
});

test('config keeps ordinary clock changes and denies protected or mixed semantics', async () => {
  const ordinary = set('config/constants.json', '/os_time_zone', 'UTC', 'UTC');
  assert.equal((await ingestOperation('applyConfigOps', config([ordinary]))).action, 'settings.write');
  for (const pointer of ['/flag_defaults/alpha', '/flag_defaults', '/monthly_caps/data_usd', '/explore_sleeve']) {
    assert.equal((await towerOperation(config([ordinary, set('config/constants.json', pointer, 1)]))).action, 'measurement.write');
  }
  for (const pointer of ['', '/unknown', '/flag_defaults~1alpha', '/flag_defaults~0alpha', '/flag_defaults~2alpha']) {
    await assert.rejects(towerOperation(config([set('config/constants.json', pointer, 1)])), OperationRefused);
  }
  for (const unknown of [{ ...ordinary, kind: 'raw-sql' }, { ...ordinary, actor: 'owner' },
    { ...ordinary, file: '../private.json' }, { kind: 'store-asset-set', asset: 'example.com', column: 'status', expect: 'live', value: 'retired' }]) {
    await assert.rejects(towerOperation(config([unknown])), OperationRefused);
  }
});

test('declared ordinary fields remain distinct from protected funnels and ancestor replacement', async () => {
  const lane = (pointer, value, expect) => set('config/integrations.json', pointer, value, expect);
  assert.equal((await towerOperation(config([lane('/assets/example.com/ga4/propertyId', '12345', '23456')]))).action, 'settings.write');
  assert.equal((await towerOperation(config([lane('/assets/example.com/posthog/status', 'needs-setup', 'skipped')]))).action, 'settings.write');
  const funnels = [{ id: 'signup', name: 'Signup', steps: [{ event: '$pageview' }, { event: 'signup' }] }];
  assert.equal((await towerOperation(config([lane('/assets/example.com/posthog/funnels', funnels, [])]))).action, 'measurement.write');
  assert.equal((await towerOperation(config([lane('/assets/example.com/posthog', { status: 'needs-setup', since: '2026-10-01' }, { status: 'skipped', since: '2026-09-01', funnels })]))).action, 'measurement.write');
  assert.equal((await towerOperation(config([lane('/assets/example.com', {}, { posthog: { funnels } })]))).action, 'measurement.write');
  await assert.rejects(towerOperation(config([lane('/assets', {}, {})])), OperationRefused);
  await assert.rejects(towerOperation(config([lane('/catalog/-', { id: 'future' })])), OperationRefused);
  await assert.rejects(towerOperation(config([lane('/assets/example.com/ga4/future', 1)])), OperationRefused);
});

test('bounded JSON parsing preserves the actual handler body and denies authority keys', async () => {
  const source = config([set('config/constants.json', '/os_time_zone', 'UTC', 'UTC')]);
  await towerOperation(source);
  assert.equal((await source.json()).ops[0].pointer, '/os_time_zone');
  for (const body of ['{', '[]', 'null', { ops: [], actor: 'owner' }, { ops: [], action: 'settings.write' }]) {
    await assert.rejects(towerOperation(request('/api/config', 'PUT', body)), OperationRefused);
  }
  await assert.rejects(towerOperation(request('/api/config', 'PUT', '{}', { 'content-type': 'text/plain' })), OperationRefused);
  await assert.rejects(towerOperation(request('/api/config', 'PUT', '{}', { 'content-length': '999999' })), OperationRefused);
  await assert.rejects(towerOperation(request('/api/config', 'PUT', ' '.repeat(256 * 1024 + 1))), OperationRefused);
});

test('MCP helper selection inspects the bounded actual tool request', async () => {
  assert.equal((await towerOperation(mcp('list_properties'))).action, 'evidence.read');
  assert.equal((await towerOperation(mcp('property_report', { asset: 'example.com' }))).action, 'evidence.read');
  assert.equal((await ingestOperation('researchLookup', mcp('research_lookup', { endpoint: 'fixture/report', params: {} }))).action, 'evidence.read');
  await assert.rejects(ingestOperation('researchLookup', mcp('list_properties')), OperationRefused);
  for (const [name, args] of [['run_job', {}], ['property_report', {}], ['property_report', { asset: 'example.com', actor: 'owner' }],
    ['research_lookup', { endpoint: 'fixture/report', params: {}, windowDays: -1 }]]) {
    await assert.rejects(towerOperation(mcp(name, args)), OperationRefused);
  }
  await assert.rejects(towerOperation(request('/api/mcp', 'POST', { jsonrpc: '2.0', method: 'future' })), OperationRefused);
});

test('incomplete streamed classification ends at the whole-read deadline', { timeout: 5000 }, async (t) => {
  fakeClock(t);
  const controller = new AbortController();
  const proof = new Request(origin + '/api/config', { method: 'PUT', duplex: 'half',
    signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); } }) });
  // Still reading a millisecond before its 2 s deadline, ended at it, on a
  // fake clock (scripts/test-deadline.mjs).
  await assert.rejects(atDeadline(t, towerOperation(proof), 2_000), OperationRefused);
  // Only the owned synthetic original branch remains; retire it explicitly.
  await proof.body.cancel();
});


test('Google start accepts actual empty HTTP streams and preserves the handler body', async () => {
  const workspaceId = '12345678-1234-1234-1234-123456789abc';
  const start = body => new Request(origin + GOOGLE_INTEGRATION_START, {
    method: 'POST', headers: { 'x-noticeos-workspace-id': workspaceId, 'content-length': '0' },
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  });
  for (const body of [undefined, '', new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array()); controller.enqueue(new Uint8Array()); controller.close();
  } })]) {
    const original = start(body);
    assert.deepEqual(await googleOAuthRequest(original, origin, 'start'), { workspaceId });
    assert.equal(original.bodyUsed, false);
    assert.equal(await original.text(), '');
  }
  for (const body of ['x', '{}', new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array()); controller.enqueue(new TextEncoder().encode('x')); controller.close();
  } })]) {
    const original = start(body);
    await assert.rejects(googleOAuthRequest(original, origin, 'start'), OperationRefused);
    assert.equal(original.bodyUsed, false);
    assert.ok((await original.text()).length > 0);
  }
});

test('Google start refuses unfinished, excessive empty chunks, failed and aborted streams', async (t) => {
  fakeClock(t);
  const headers = { 'x-noticeos-workspace-id': '12345678-1234-1234-1234-123456789abc' };
  const make = (body, signal) => new Request(origin + GOOGLE_INTEGRATION_START, { method: 'POST', headers, body, signal, duplex: 'half' });
  const endless = make(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); } }));
  await assert.rejects(googleOAuthRequest(endless, origin, 'start'), OperationRefused);
  // These synthetic original branches belong to this test, never the parser.
  await endless.body.cancel();
  const failed = make(new ReadableStream({ start(controller) { controller.error(new Error('Synthetic stream failure')); } }));
  await assert.rejects(googleOAuthRequest(failed, origin, 'start'), OperationRefused);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(googleOAuthRequest(make('', aborted.signal), origin, 'start'), OperationRefused);
  // An unfinished body ends at the 2 s whole-read deadline, not before
  // (scripts/test-deadline.mjs).
  const stalled = make(new ReadableStream({ start() {} }));
  await assert.rejects(atDeadline(t, googleOAuthRequest(stalled, origin, 'start'), 2_000), OperationRefused);
  await stalled.body.cancel();
});


test('collection workflow effects refuse unknown fields and noncanonical selector paths', async () => {
  const collect = '/api/integrations/bing-webmaster/collect', sync = '/api/integrations/mediavine/sync';
  const original = request(collect, 'POST', { assets: ['example.test'] });
  assert.equal((await ingestOperation('collectNow', original)).action, 'workflows.run');
  await assert.rejects(ingestOperation('discoverSites', original), OperationRefused);
  await assert.rejects(ingestOperation('getConfigDocuments', original), OperationRefused);
  const snapshot = await providerCollectionInput(original);
  assert.ok(Object.isFrozen(snapshot.input.assets));
  assert.throws(() => snapshot.input.assets.push('foreign.test'));
  for (const path of [collect + '?', collect + '?workspace=foreign', collect + '#fragment',
    '/api/integrations/Bing-webmaster/collect', '/api/integrations/bing%2Fwebmaster/collect']) {
    await assert.rejects(towerOperation(request(path, 'POST', { assets: ['example.test'] })), OperationRefused);
  }
  for (const body of [null, [], {}, { assets: [1] }, { assets: [''] }, { assets: Array(101).fill('example.test') },
    { assets: ['example.test'], provider: 'google' }, { assets: ['example.test'], lane: 'google' }]) {
    await assert.rejects(towerOperation(request(collect, 'POST', body)), OperationRefused);
  }
  for (const body of [{}, { asset: '' }, { asset: 'example.test', start: 1 },
    { asset: 'example.test', end: 'tomorrow' }, { asset: 'example.test', automatic: true }]) {
    await assert.rejects(towerOperation(request(sync, 'POST', body)), OperationRefused);
  }
  assert.equal((await ingestOperation('syncMediavine', request(sync, 'POST', { asset: 'example.test' }))).action, 'workflows.run');
  await assert.rejects(ingestOperation('saveMediavineSettings', request(sync, 'POST', { asset: 'example.test' })), OperationRefused);
});

test('live panels admit only their fixed method and bounded original selector', async () => {
  for (const [path, method] of [['/api/ga4/realtime', 'ga4Realtime'], ['/api/calendar/upcoming', 'calendarUpcoming']]) {
    const parsed = liveProviderReadRequest(request(path));
    assert.deepEqual(parsed, { method }); assert.ok(Object.isFrozen(parsed));
    assert.equal((await ingestOperation(method, request(path))).action, 'provider.read');
    for (const suffix of ['?', '?asset=example.com', '?workspaceId=foreign', '#fragment']) {
      assert.equal(liveProviderReadRequest(request(path + suffix)), null);
      await assert.rejects(ingestOperation(method, request(path + suffix)), OperationRefused);
    }
    for (const verb of ['HEAD', 'POST', 'PUT']) await assert.rejects(ingestOperation(method, request(path, verb)), OperationRefused);
    await assert.rejects(ingestOperation(method === 'ga4Realtime' ? 'calendarUpcoming' : 'ga4Realtime', request(path)), OperationRefused);
  }
  const path = '/api/site-name?domain=example.com';
  assert.deepEqual(liveProviderReadRequest(request(path)), { method: 'siteName', domain: 'example.com' });
  assert.equal((await towerOperation(request(path))).action, 'provider.read');
  for (const query of ['', '?domain=', '?domain=example.com&domain=foreign.com', '?domain=example.com&actor=forged', '?domain=%20example.com', '?domain=' + 'a'.repeat(513)]) {
    assert.equal(liveProviderReadRequest(request('/api/site-name' + query)), null);
    await assert.rejects(towerOperation(request('/api/site-name' + query)), OperationRefused);
  }
  await assert.rejects(ingestOperation('ga4Realtime', request(path)), OperationRefused);
});

const replay = { asset: 'example.test', ruleId: 'pulse_gap', config: { alpha: 0.05, minBaselinePerDay: 3, lowVolumeWindowHours: 72 } };
test('stored research grammar binds only named tools and exact candidate replay fields', async () => {
  for (const body of [replay, { ...replay, metric: null, through: '2026-07-05' }]) {
    const parsed = await storedResearchReadRequest(request('/api/alerts/backtest', 'POST', body));
    assert.equal(parsed.method, 'backtestRule'); assert.equal(parsed.input.asset, body.asset);
    assert.deepEqual(parsed.input.config, body.config);
    assert.equal((await towerOperation(request('/api/alerts/backtest', 'POST', body))).action, 'evidence.read');
  }
  for (const body of [{ ...replay, actor: 'claimed' }, { ...replay, workspaceId: randomUUID() },
    { ...replay, config: { ...replay.config, saved: true } }, { ...replay, through: 'not-a-day' },
    { ...replay, asset: '' }, { ...replay, config: [] }, { settings: {} }]) {
    await assert.rejects(towerOperation(request('/api/alerts/backtest', 'POST', body)), OperationRefused);
  }
  for (const suffix of ['?', '?workspace=other', '#fragment'])
    await assert.rejects(towerOperation(request('/api/alerts/backtest' + suffix, 'POST', replay)), OperationRefused);
  for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list'])
    assert.equal((await towerOperation(request('/api/mcp', 'POST', { jsonrpc: '2.0', method }))).action, 'evidence.read');
  // A 2026-07-28 request names its version in _meta and may discover first.
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  for (const body of [{ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'property_report', arguments: { asset: 'example.test' }, _meta: meta } }])
    assert.equal((await towerOperation(request('/api/mcp', 'POST', body))).action, 'evidence.read');
  for (const body of [{ jsonrpc: '2.0', method: 'ping', actor: 'claimed' },
    { jsonrpc: '2.0', method: 'ping', params: { action: 'provider.read' } },
    { jsonrpc: '2.0', id: null, method: 'ping' }, [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'property_report', arguments: { asset: 'example.test' }, _meta: [] } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'research_lookup', arguments: { endpoint: 'report', params: {}, provider: 'other' } } }])
    await assert.rejects(towerOperation(request('/api/mcp', 'POST', body)), OperationRefused);
});


test('hosted mutation grammar rejects extra actor/selectors and keeps measurement assignments protected', async () => {
  for (const [path, method, body] of [
    ['/api/assets', 'POST', { id: 'example.test', displayName: 'Example', actor: 'forged' }],
    ['/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'build', workspaceId: 'foreign' }],
    ['/api/assets/example.test/annotations', 'POST', { kind: 'ship', asset: 'foreign.test' }],
    ['/api/assets/example.test/decisions', 'POST', { kind: 'query', key: 'fixture', status: 'marked', sessionId: 'forged' }],
    ['/api/flags/17', 'PATCH', { action: 'resolve', actor: 'forged' }],
  ]) await assert.rejects(towerOperation(request(path, method, body)), OperationRefused);
  assert.equal((await towerOperation(request('/api/flags/17', 'PATCH', { action: 'tune', tuned: {} }))).action, 'measurement.write');
  assert.equal((await towerOperation(request('/api/assets/example.test/watch-windows', 'POST', {}))).action, 'measurement.write');
  for (const path of ['/api/assets/example.test?workspace=foreign', '/api/assets/example.test/annotations?actor=forged'])
    await assert.rejects(towerOperation(request(path, path.includes('annotations') ? 'POST' : 'PATCH', {})));
});


test('stored watch history fixes asset, query and released GSC metric without caller ranges', async () => {
  const base = '/api/assets/example.test/watch-query-history';
  for (const metric of ['clicks', 'impressions', 'ctr', 'position']) {
    const original = request(base + '?query=%20Shared%20query%20&metric=' + metric);
    assert.deepEqual(watchQueryHistoryRequest(original), { asset: 'example.test', query: 'Shared query', metric });
    assert.equal((await ingestOperation('watchQueryHistory', original)).action, 'evidence.read');
    await assert.rejects(ingestOperation('researchLookup', original), OperationRefused);
  }
  for (const suffix of ['?query=&metric=clicks', '?query=q&metric=sessions', '?query=q&metric=clicks&workspace=foreign',
    '?query=q&query=q', '?query=q&metric=clicks&first_day=2026-01-01', '?query=q&metric=clicks#fragment',
    '?metric=clicks', '?query=' + 'x'.repeat(2001) + '&metric=clicks']) {
    assert.equal(watchQueryHistoryRequest(request(base + suffix)), null);
    await assert.rejects(ingestOperation('watchQueryHistory', request(base + suffix)), OperationRefused);
  }
  for (const path of ['/api/assets/example%2Ftest/watch-query-history', '/api/assets/example.test/watch-query-history/']) {
    assert.equal(watchQueryHistoryRequest(request(path + '?query=q&metric=clicks')), null);
  }
  await assert.rejects(ingestOperation('watchQueryHistory', request(base + '?query=q&metric=clicks', 'POST', {})), OperationRefused);
});


test('Product use presentation is exact and cannot replace neighboring measurement authority', async () => {
  const file = 'config/value-events.json';
  const stages = [{ eventName: 'document_open', label: 'Opened a document', group: 'primary' }];
  const classify = async (op) => (await towerOperation(config([op]))).action;
  assert.equal(await classify({kind: 'file-json-insert', file, pointer: '/assets/example.com', value: {productUseStages: stages}}), 'settings.write');
  assert.equal(await classify({kind: 'file-json-insert', file, pointer: '/assets/example.com/productUseStages', value: stages}), 'settings.write');
  assert.equal(await classify(set(file, '/assets/example.com/productUseStages/0/label', 'Opened', 'Opened a document')), 'settings.write');
  assert.equal(await classify({kind: 'file-json-delete', file, pointer: '/assets/example.com/productUseStages', expect: stages}), 'settings.write');
  assert.equal(await classify({kind: 'file-json-insert', file, pointer: '/assets/example.com/valueEvents', value: ['purchase']}), 'measurement.write');
  for (const pointer of ['', '/assets', '/assets/example.com']) {
    await assert.rejects(classify(set(file, pointer, {}, {})), OperationRefused);
  }
  for (const op of [
    {kind: 'file-json-delete', file, pointer: '/assets/example.com', expect: {productUseStages: stages}},
    {kind: 'file-json-insert', file, pointer: '/assets/example.com', value: {productUseStages: stages, valueEvents: ['purchase']}},
    set(file, '/assets/example.com/valueEvents/0', 'purchase', 'signup'),
    set('config/ga4-custom-dimensions.json', '/assets/example.com/eventParams/0', 'error', 'message')]) {
    assert.equal(await classify(op), 'measurement.write');
  }
  for (const pointer of ['/assets/example.com/productUseStages~1valueEvents', '/assets/example.com/productUseStages/0/valueEvents', '/assets/example.com/productUseStages~2']) {
    await assert.rejects(classify(set(file, pointer, 'x', 'y')), OperationRefused);
  }
});
