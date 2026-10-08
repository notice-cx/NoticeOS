import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { atDeadline, fakeClock } from './test-deadline.mjs';
import { configReadFiles, assetMutationArguments, configWriteArguments, connectionReadinessArguments, credentialWriteArguments, providerCollectionArguments, requireStandaloneWorkspace, withWorkspaceEntry, withLiveProviderReadEntry, storedResearchArguments, watchQueryHistoryArguments, workspaceProfile } from './workspace-entry.mjs';
import { TOWER_CONFIG_FILES } from '../packages/contract/src/configuration.mjs';

const [a, b, demo, principal, session] = Array.from({ length: 5 }, () => randomUUID());
const origin = 'https://entry.example.test';
const env = {
  NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
  NOTICEOS_WORKSPACE_DATABASE_URL: 'postgresql://noticeos_app@localhost/fixture',
  NOTICEOS_IDENTITY_DATABASE_URL: 'postgresql://noticeos_identity@localhost/fixture',
  NOTICEOS_IDENTITY_SESSION_SECRET: 'synthetic-local-signing-fixture-key-only',
  NOTICEOS_DEMO_WORKSPACE_ID: demo,
};
const ops = [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: 'UTC', value: 'Europe/London' }];
function request({ workspace = a, method = 'GET', headers = {}, body = { ops }, path = '/api/config', target = origin } = {}) {
  return new Request(target + path, { method, headers: {
    ...(workspace === null ? {} : { 'x-noticeos-workspace-id': workspace }),
    [WORKSPACE_SESSION_HEADER]: session,
    ...(method === 'PUT' ? { origin, 'content-type': 'application/json' } : {}), ...headers,
  }, ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}) });
}
function fixture() {
  const memberships = new Map([[a, 'owner'], [b, 'viewer']]);
  const agents = new Map([['agent-token-evidence-0001', ['evidence:read']], ['agent-token-tasks-only-0002', ['tasks:read', 'tasks:write']]]);
  const states = new Map([[a, 'active'], [b, 'active'], [demo, 'active']]);
  const calls = { opened: 0, closed: 0, memberships: 0, summaries: 0, stores: [] };
  let expiry = new Date(Date.now() + 60_000).toISOString();
  const adapters = {
    async openIdentity(options) {
      calls.opened++; assert.equal(options.connectionString, env.NOTICEOS_IDENTITY_DATABASE_URL);
      return {
        async admissionMembership(headers, workspaceId) {
          calls.memberships++; assert.equal(headers.get('x-noticeos-workspace-id'), workspaceId);
          const role = memberships.get(workspaceId);
          return role ? { principalId: principal, sessionId: session, expiresAt: expiry,
            workspaceId, role, workspaceStatus: states.get(workspaceId) } : null;
        },
        async workspaceSummary(workspaceId) { calls.summaries++; return { workspaceId, displayName: 'Fixture', status: states.get(workspaceId) }; },
        async agentAuthority(request, workspaceId) {
          calls.agents = (calls.agents ?? 0) + 1;
          const scopes = agents.get(request.headers.get('authorization')?.slice('Bearer '.length));
          const role = memberships.get(workspaceId);
          return scopes && role ? { principalId: principal, clientId: 'example-agent', workspaceId,
            role, workspaceStatus: states.get(workspaceId), expiresAt: expiry, scopes } : null;
        },
        async close() { calls.closed++; },
      };
    },
    async withStore(selection, _ctx, work) {
      assert.equal(selection.transport.connectionString, env.NOTICEOS_WORKSPACE_DATABASE_URL);
      calls.stores.push(selection.workspace.workspaceId);
      return work({ workspaceId: selection.workspace.workspaceId });
    },
  };
  return { calls, adapters, memberships, states, expiry: value => { expiry = value; } };
}
const use = async call => call.withStore({}, async store => ({ workspace: store.workspaceId, actor: call.context.principalId }));

test('D1 selection, export and private SQL reads use fresh owner admission and demo refusal', async () => {
  const accountId = 'a'.repeat(32), databaseId = randomUUID(), runId = randomUUID();
  const requests = workspace => [
    new Request(origin + '/api/integrations/cloudflare/d1?view=databases', { headers: { origin, 'x-noticeos-workspace-id': workspace, [WORKSPACE_SESSION_HEADER]: session } }),
    ...[['PUT', { version: 1, accountId, targets: [{ databaseId, asset: 'example.com' }] }], ['POST', { accountId, databaseId }]].map(([method, body]) => new Request(origin + '/api/integrations/cloudflare/d1', {
      method, headers: { origin, 'content-type': 'application/json', 'x-noticeos-workspace-id': workspace, [WORKSPACE_SESSION_HEADER]: session }, body: JSON.stringify(body),
    })),
    new Request(origin + `/api/integrations/cloudflare/d1?view=artifact&accountId=${accountId}&databaseId=${databaseId}&runId=${runId}`, { headers: { origin, 'x-noticeos-workspace-id': workspace, [WORKSPACE_SESSION_HEADER]: session } }),
  ];
  const f = fixture();
  for (const original of requests(a)) assert.deepEqual(await withWorkspaceEntry(env, original, use, f.adapters), { workspace: a, actor: principal });
  assert.equal(f.calls.memberships, 4); assert.equal(f.calls.closed, 4);
  for (const original of requests(b)) await assert.rejects(withWorkspaceEntry(env, original, use, f.adapters));
  const before = f.calls.opened;
  for (const original of requests(demo)) await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, original, use, f.adapters));
  assert.equal(f.calls.opened, before);
  const foreign = requests(a)[2];
  const changed = new Request(foreign, { headers: { origin: 'https://foreign.example.test', 'content-type': 'application/json', 'x-noticeos-workspace-id': a } });
  await assert.rejects(withWorkspaceEntry(env, changed, use, f.adapters));
  assert.equal(f.calls.opened, before);
});

test('profile is explicit and malformed/absent inputs never select standalone', () => {
  for (const input of [{}, null, { NOTICEOS_WORKSPACE_PROFILE: '' }, { NOTICEOS_WORKSPACE_PROFILE: ' standalone ' }, { NOTICEOS_WORKSPACE_PROFILE: {} }]) {
    assert.throws(() => workspaceProfile(input));
  }
  for (const value of ['standalone', 'hosted', 'demo']) assert.equal(workspaceProfile({ NOTICEOS_WORKSPACE_PROFILE: value }), value);
  requireStandaloneWorkspace({ NOTICEOS_WORKSPACE_PROFILE: 'standalone' });
  assert.throws(() => requireStandaloneWorkspace(env));
});

test('fixed config inventory refuses subsets, foreign files, duplicates and reorder', () => {
  const files = Object.values(TOWER_CONFIG_FILES);
  assert.deepEqual(configReadFiles(files), files);
  for (const input of [null, files.slice(1), [...files, 'host-only.json'], [...files, files[0]], [...files].reverse()]) assert.throws(() => configReadFiles(input));
});

test('PUT duplicate binding ignores claimed actor but compares every other field without key-order dependence', async () => {
  const proof = request({ method: 'PUT', body: { ops, reason: 'Fixture setting', expectVersions: { 'config/constants.json': 1 }, slug: 'fixture' } });
  const input = { actor: 'forged-owner', expectVersions: { 'config/constants.json': 1 }, reason: 'Fixture setting', slug: 'fixture', ops };
  const bound = await configWriteArguments(input, proof);
  assert.deepEqual(bound, { ops, slug: 'fixture', reason: 'Fixture setting', expectVersions: { 'config/constants.json': 1 } });
  assert.equal('actor' in bound, false);
  assert.deepEqual(await proof.json(), { ops, reason: 'Fixture setting', expectVersions: { 'config/constants.json': 1 }, slug: 'fixture' });
});

test('PUT duplicate extra keys, mismatched body, protected operations and wrong helper edge refuse', async () => {
  const input = { ops, reason: null, expectVersions: null };
  for (const value of [{ ...input, workspaceId: b }, { ...input, action: 'settings.write' }, { ...input, profile: 'standalone' }, { ...input, ops: [] }, { ...input, reason: 'different' }, { ...input, slug: '' }]) {
    await assert.rejects(configWriteArguments(value, request({ method: 'PUT' })));
  }
  await assert.rejects(configWriteArguments(input, request()));
  await assert.rejects(configWriteArguments(input, request({ method: 'PUT', path: '/api/settings' })));
  await assert.rejects(configWriteArguments(input, request({ method: 'PUT', body: { ops, actor: 'forged' } })));
});

test('two server-selected workspaces bind distinct stores and actor facts', async () => {
  const f = fixture();
  assert.deepEqual(await withWorkspaceEntry(env, request(), use, f.adapters), { workspace: a, actor: principal });
  assert.deepEqual(await withWorkspaceEntry(env, request({ workspace: b }), use, f.adapters), { workspace: b, actor: principal });
  assert.deepEqual(f.calls.stores, [a, b]); assert.equal(f.calls.closed, 2);
});

test('receiver independently reloads revoked/expired membership and lifecycle', async () => {
  const f = fixture();
  await withWorkspaceEntry(env, request(), use, f.adapters);
  f.memberships.delete(a);
  await assert.rejects(withWorkspaceEntry(env, request(), use, f.adapters));
  f.memberships.set(a, 'owner'); f.expiry(new Date(Date.now() - 1).toISOString());
  await assert.rejects(withWorkspaceEntry(env, request(), use, f.adapters));
  f.expiry(new Date(Date.now() + 60_000).toISOString()); f.states.set(a, 'suspended');
  await assert.rejects(withWorkspaceEntry(env, request(), use, f.adapters));
  assert.deepEqual(f.calls.stores, [a]); assert.equal(f.calls.closed, 4);
});

test('viewer PUT refuses before store and owner PUT retains readable original body', async () => {
  const f = fixture();
  await assert.rejects(withWorkspaceEntry(env, request({ workspace: b, method: 'PUT' }), use, f.adapters));
  const proof = request({ method: 'PUT' });
  const result = await withWorkspaceEntry(env, proof, async call => {
    assert.deepEqual(await proof.clone().json(), { ops });
    return use(call);
  }, f.adapters);
  assert.equal(result.actor, principal); assert.deepEqual(await proof.json(), { ops });
  assert.deepEqual(f.calls.stores, [a]);
});

test('malformed selector, missing proof/config, unsupported entries and conflicting origins deny before identity I/O', async () => {
  const f = fixture();
  for (const proof of [request({ workspace: null }), request({ workspace: `${a}, ${b}` }), request({ workspace: '../foreign' }),
    request({ path: '/api/tasks' }), request({ target: 'https://foreign.example.test' }),
    request({ method: 'PUT', headers: { origin: 'https://foreign.example.test' } }),
    request({ method: 'PUT', headers: { 'sec-fetch-site': 'cross-site' } }), { verified: true }]) {
    await assert.rejects(withWorkspaceEntry(env, proof, use, f.adapters));
  }
  for (const key of Object.keys(env).filter(key => key !== 'NOTICEOS_DEMO_WORKSPACE_ID')) {
    const broken = { ...env }; delete broken[key];
    await assert.rejects(withWorkspaceEntry(broken, request(), use, f.adapters));
  }
  assert.equal(f.calls.opened, 0); assert.deepEqual(f.calls.stores, []);
});

test('fixed demo remains anonymous, refuses foreign selector and writes before opening identity', async () => {
  const f = fixture(), selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' };
  const result = await withWorkspaceEntry(selected, request({ workspace: null, headers: { cookie: 'customer-session' } }), use, f.adapters);
  assert.deepEqual(result, { workspace: demo, actor: 'demo-reader' });
  await assert.rejects(withWorkspaceEntry(selected, request({ workspace: a }), use, f.adapters));
  await assert.rejects(withWorkspaceEntry(selected, request({ workspace: demo, method: 'PUT' }), use, f.adapters));
  assert.equal(f.calls.opened, 1); assert.equal(f.calls.memberships, 0); assert.equal(f.calls.summaries, 1);
});

test('escaped capabilities and operation failures await identity cleanup without disclosing transport details', async () => {
  const f = fixture();
  const escaped = await withWorkspaceEntry(env, request(), async call => call, f.adapters);
  await assert.rejects(async () => escaped.withStore({}, async () => undefined));
  await assert.rejects(withWorkspaceEntry(env, request(), async () => { throw new Error('synthetic private transport'); }, f.adapters), error => !error.message.includes('transport'));
  assert.equal(f.calls.closed, 2); assert.deepEqual(f.calls.stores, []);
});


test('missing session binding refuses before identity; a stale binding closes fresh lookup without store access', async () => {
  const f = fixture();
  const missing = request(); missing.headers.delete(WORKSPACE_SESSION_HEADER);
  for (const proof of [missing, request({ headers: { [WORKSPACE_SESSION_HEADER]: 'malformed' } })])
    await assert.rejects(withWorkspaceEntry(env, proof, use, f.adapters));
  assert.equal(f.calls.opened, 0);
  await assert.rejects(withWorkspaceEntry(env, request({ headers: { [WORKSPACE_SESSION_HEADER]: randomUUID() } }), use, f.adapters));
  assert.equal(f.calls.opened, 1); assert.equal(f.calls.closed, 1); assert.equal(f.calls.memberships, 1); assert.deepEqual(f.calls.stores, []);
});

test('fixed Google discovery reuses provider admission and truthful browser GET evidence', async () => {
  const f = fixture(), path = '/api/integrations/google/properties';
  const sameOrigin = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
  assert.deepEqual(await withWorkspaceEntry(env, request({ path, headers: sameOrigin }), use, f.adapters), { workspace: a, actor: principal });
  f.memberships.set(b, 'operator');
  await withWorkspaceEntry(env, request({ path, workspace: b, headers: sameOrigin }), use, f.adapters);
  assert.deepEqual(f.calls.stores, [a, b]);
  f.memberships.set(b, 'viewer');
  await assert.rejects(withWorkspaceEntry(env, request({ path, workspace: b, headers: sameOrigin }), use, f.adapters));
  const before = f.calls.opened;
  for (const headers of [{}, { origin: 'https://foreign.example.test' },
    { origin, 'sec-fetch-site': 'cross-site' }, { ...sameOrigin, 'sec-fetch-mode': 'navigate' }]) {
    await assert.rejects(withWorkspaceEntry(env, request({ path, headers }), use, f.adapters));
  }
  await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' },
    request({ path, workspace: demo, headers: sameOrigin }), use, f.adapters));
  assert.equal(f.calls.opened, before);
  assert.deepEqual(f.calls.stores, [a, b]);
});

test('readiness binds duplicate provider arguments and refuses browser/role failures before store access', async () => {
  const f = fixture();
  const sites = request({ path: '/api/integrations/bing-webmaster/sites', headers: { origin } });
  const probe = new Request(origin + '/api/integrations/discord/test', { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-noticeos-workspace-id': a, [WORKSPACE_SESSION_HEADER]: session }, body: '{}' });
  assert.equal(await connectionReadinessArguments('bing-webmaster', sites, 'discoverSites'), 'bing-webmaster');
  assert.equal(await connectionReadinessArguments('discord', probe, 'probeCredential'), 'discord');
  for (const [provider, original, method] of [['google', sites, 'discoverSites'], ['bing-webmaster', sites, 'probeCredential'],
    ['google', probe, 'probeCredential'], ['discord', probe, 'discoverSites'], [{ provider: 'discord' }, probe, 'probeCredential']]) {
    await assert.rejects(connectionReadinessArguments(provider, original, method));
  }
  await withWorkspaceEntry(env, sites, use, f.adapters);
  await withWorkspaceEntry(env, probe, use, f.adapters);
  const opened = f.calls.opened;
  for (const original of [sites, probe]) {
    const foreign = original.clone(); foreign.headers.set('origin', 'https://foreign.example.test');
    await assert.rejects(withWorkspaceEntry(env, foreign, use, f.adapters));
    await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, original, use, f.adapters));
  }
  assert.equal(f.calls.opened, opened); assert.deepEqual(f.calls.stores, [a, a]);
  f.memberships.set(a, 'viewer');
  await assert.rejects(withWorkspaceEntry(env, probe, use, f.adapters));
  f.memberships.set(a, 'operator'); f.expiry(new Date(Date.now() - 1000).toISOString());
  await assert.rejects(withWorkspaceEntry(env, sites, use, f.adapters));
  assert.deepEqual(f.calls.stores, [a, a]);
});

test('a stalled readiness body refuses before opening identity or store', { timeout: 5000 }, async (t) => {
  fakeClock(t);
  const f = fixture();
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const original = new Request(origin + '/api/integrations/discord/test', {
    method: 'POST', duplex: 'half', body,
    headers: { origin, 'content-type': 'application/json',
      'x-noticeos-workspace-id': a, [WORKSPACE_SESSION_HEADER]: session },
  });
  try {
    // Refused at the 2 s whole-read deadline, not before (scripts/test-deadline.mjs).
    await assert.rejects(atDeadline(t, withWorkspaceEntry(env, original, use, f.adapters), 2_000));
    assert.equal(f.calls.opened, 0);
    assert.deepEqual(f.calls.stores, []);
  } finally {
    controller.close();
    await original.body.cancel();
  }
});

test('credential writes bind exact original payloads and current owner without accepting claimed metadata', async () => {
  const f = fixture(), fields = { apiKey: randomUUID() };
  const original = (suffix, method, body, workspace = a) => new Request(origin + '/api/integrations/bing-webmaster/' + suffix, {
    method, headers: { origin, 'x-noticeos-workspace-id': workspace, [WORKSPACE_SESSION_HEADER]: session,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cases = [
    ['credential', 'PUT', 'putCredential', { fields }, { provider: 'bing-webmaster', fields }],
    ['connect', 'POST', 'connectCredential', { fields }, { provider: 'bing-webmaster', fields }],
    ['credential', 'DELETE', 'deleteCredential', undefined, 'bing-webmaster'],
    ['expiry', 'PUT', 'setCredentialExpiry', { expiresAt: null }, { provider: 'bing-webmaster', expiresAt: null }],
    ['site-token', 'PUT', 'putSiteToken', { asset: 'example.test', token: randomUUID() }, null],
  ];
  cases.at(-1)[4] = { provider: 'bing-webmaster', ...cases.at(-1)[3] };
  for (const [suffix, method, rpc, body, input] of cases) {
    const proof = original(suffix, method, body);
    assert.deepEqual(await credentialWriteArguments(input, proof, rpc), input);
    assert.equal((await withWorkspaceEntry(env, proof, use, f.adapters)).actor, principal);
    const forged = typeof input === 'string' ? 'google' : { ...input, provider: 'google' };
    await assert.rejects(credentialWriteArguments(forged, proof, rpc));
    if (typeof input === 'object') {
      for (const key of ['metadata', 'actor', 'workspaceId', 'action'])
        await assert.rejects(credentialWriteArguments({ ...input, [key]: 'forged' }, proof, rpc));
    }
    await assert.rejects(credentialWriteArguments(input, proof, rpc === 'putCredential' ? 'connectCredential' : 'putCredential'));
    f.memberships.set(a, 'viewer');
    await assert.rejects(withWorkspaceEntry(env, proof, use, f.adapters));
    f.memberships.set(a, 'operator');
    await withWorkspaceEntry(env, proof, use, f.adapters);
    const opened = f.calls.opened;
    const foreign = proof.clone(); foreign.headers.set('origin', 'https://foreign.example.test');
    await assert.rejects(withWorkspaceEntry(env, foreign, use, f.adapters));
    await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, proof, use, f.adapters));
    assert.equal(f.calls.opened, opened);
  }
  assert.deepEqual(f.calls.stores, Array(10).fill(a));
});

test('stalled credential JSON and DELETE streams refuse before identity I/O', { timeout: 7000 }, async (t) => {
  fakeClock(t);
  for (const method of ['PUT', 'DELETE']) {
    const f = fixture(); let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    const proof = new Request(origin + '/api/integrations/google/credential', { method, duplex: 'half', body,
      headers: { origin, 'content-type': 'application/json', 'x-noticeos-workspace-id': a, [WORKSPACE_SESSION_HEADER]: session } });
    try {
      await assert.rejects(atDeadline(t, withWorkspaceEntry(env, proof, use, f.adapters), 2_000));
      assert.equal(f.calls.opened, 0); assert.deepEqual(f.calls.stores, []);
    } finally { controller.close(); await proof.body.cancel(); }
  }
});


test('collection original fields and fixed methods bind one current workflow actor', async () => {
  const f = fixture();
  const make = (path, body, workspace = a) => new Request(origin + path, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-noticeos-workspace-id': workspace,
      [WORKSPACE_SESSION_HEADER]: session }, body: JSON.stringify(body) });
  for (const [path, method, body, input] of [
    ['/api/integrations/bing-webmaster/collect', 'collectNow', { assets: ['example.test'] },
      { provider: 'bing-webmaster', assets: ['example.test'] }],
    ['/api/integrations/mediavine/sync', 'syncMediavine', { asset: 'example.test' }, { asset: 'example.test' }],
    ['/api/integrations/mediavine/sync', 'syncMediavine',
      { asset: 'example.test', start: '2026-09-01', end: '2026-09-02' },
      { asset: 'example.test', start: '2026-09-01', end: '2026-09-02' }],
  ]) {
    const proof = make(path, body);
    assert.deepEqual(await providerCollectionArguments(input, proof, method), input);
    assert.equal((await withWorkspaceEntry(env, proof, use, f.adapters)).actor, principal);
    for (const field of ['actor', 'workspaceId', 'lane', 'serviceId', 'action']) {
      await assert.rejects(providerCollectionArguments({ ...input, [field]: 'forged' }, proof, method));
      await assert.rejects(withWorkspaceEntry(env, make(path, { ...body, [field]: 'forged' }), use, f.adapters));
    }
    const changed = method === 'collectNow' ? { ...input, assets: ['foreign.test'] } : { ...input, asset: 'foreign.test' };
    await assert.rejects(providerCollectionArguments(changed, proof, method));
    await assert.rejects(providerCollectionArguments(input, proof, method === 'collectNow' ? 'syncMediavine' : 'collectNow'));
    f.memberships.set(a, 'viewer');
    await assert.rejects(withWorkspaceEntry(env, proof, use, f.adapters));
    f.memberships.set(a, 'operator'); await withWorkspaceEntry(env, proof, use, f.adapters);
    const opened = f.calls.opened;
    const foreign = proof.clone(); foreign.headers.set('origin', 'https://foreign.example.test');
    await assert.rejects(withWorkspaceEntry(env, foreign, use, f.adapters));
    await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, make(path, body, demo), use, f.adapters));
    assert.equal(f.calls.opened, opened);
  }
  assert.deepEqual(f.calls.stores, Array(6).fill(a));
});

test('live panel admission uses fresh facts and truthful browser evidence without caller provider scope', async () => {
  const f = fixture();
  const paths = ['/api/ga4/realtime', '/api/calendar/upcoming', '/api/site-name?domain=example.com'];
  const evidence = { referer: origin + '/wall', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty' };
  for (const path of paths) {
    const result = await withWorkspaceEntry(env, request({ path, headers: evidence }), use, f.adapters);
    assert.deepEqual(result, { workspace: a, actor: principal });
    const before = f.calls.opened;
    for (const headers of [{ ...evidence, origin: 'https://foreign.example.test' }, { ...evidence, 'sec-fetch-site': 'cross-site' }, {}]) {
      await assert.rejects(withWorkspaceEntry(env, request({ path, headers }), use, f.adapters));
    }
    await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, request({ path, workspace: demo, headers: evidence }), use, f.adapters));
    assert.equal(f.calls.opened, before, 'browser/demo refusal precedes identity I/O');
    f.expiry(new Date(Date.now() - 1000).toISOString());
    await assert.rejects(withWorkspaceEntry(env, request({ path, headers: evidence }), use, f.adapters));
    f.expiry(new Date(Date.now() + 60000).toISOString());
    f.states.set(a, 'suspended');
    await assert.rejects(withWorkspaceEntry(env, request({ path, headers: evidence }), use, f.adapters));
    f.states.set(a, 'active');
  }
  assert.deepEqual(f.calls.stores, [a, a, a]);
  assert.equal(f.calls.opened, f.calls.closed);
  for (const [method, path] of [['ga4Realtime', '/api/calendar/upcoming'], ['calendarUpcoming', '/api/ga4/realtime'], ['ga4Realtime', '/api/ga4/realtime?property=foreign']]) {
    await assert.rejects(withLiveProviderReadEntry(env, method, request({ path, headers: evidence }), use));
  }
});

const storedReplay = { asset: 'example.test', ruleId: 'pulse_gap', config: { alpha: 0.05, minBaselinePerDay: 3, lowVolumeWindowHours: 72 } };
function question(path = '/api/alerts/backtest', body = storedReplay, evidence = {}, workspace = a) {
  return new Request(origin + path, { method: 'POST', headers: {
    'content-type': 'application/json', origin, 'x-noticeos-workspace-id': workspace,
    [WORKSPACE_SESSION_HEADER]: session, ...evidence }, body: JSON.stringify(body) });
}
const researchBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
  name: 'research_lookup', arguments: { endpoint: 'fixture/report', params: { target: 'example.test', country: 1 }, windowDays: 7 } } };
test('stored receiver arguments compare the full question and cannot claim another method, provider or owner', async () => {
  const q = { provider: 'dataforseo', ...researchBody.params.arguments };
  assert.deepEqual(await storedResearchArguments(q, question('/api/mcp', researchBody), 'researchLookup'), q);
  const expected = { ...storedReplay, metric: null };
  assert.deepEqual(await storedResearchArguments(expected, question(), 'backtestRule'), expected);
  for (const value of [{ ...expected, asset: 'foreign.test' }, { ...expected, metric: 'different' },
    { ...expected, actor: undefined }, { ...expected, config: { ...expected.config, alpha: 0.01 } }])
    await assert.rejects(storedResearchArguments(value, question(), 'backtestRule'));
  for (const value of [{ ...q, provider: 'other' }, { ...q, endpoint: 'other' },
    { ...q, params: { target: 'different.test', country: 1 } }, { ...q, windowDays: 8 }, { ...q, workspaceId: b }])
    await assert.rejects(storedResearchArguments(value, question('/api/mcp', researchBody), 'researchLookup'));
  await assert.rejects(storedResearchArguments(q, question(), 'researchLookup'));
  await assert.rejects(storedResearchArguments(expected, question('/api/mcp', researchBody), 'backtestRule'));
});
test('credentialed stored POSTs validate original browser evidence before any identity or store I/O', async () => {
  const bodies = [['/api/alerts/backtest', storedReplay], ['/api/mcp', researchBody]];
  for (const [path, body] of bodies) {
    for (const evidence of [{ origin: 'https://foreign.example.test' }, { origin: 'null' },
      { origin: '', 'sec-fetch-site': 'same-origin' }, { origin, 'sec-fetch-site': 'cross-site' },
      { origin: '', referer: 'https://foreign.example.test/' }]) {
      const f = fixture();
      await assert.rejects(withWorkspaceEntry(env, question(path, body, evidence), use, f.adapters));
      assert.equal(f.calls.opened, 0); assert.equal(f.calls.stores.length, 0);
    }
    const f = fixture();
    assert.equal((await withWorkspaceEntry(env, question(path, body), use, f.adapters)).workspace, a);
    f.memberships.set(a, 'viewer');
    assert.equal((await withWorkspaceEntry(env, question(path, body), use, f.adapters)).workspace, a);
    const d = fixture();
    const demoRequest = question(path, body, {}, demo);
    assert.equal((await withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, demoRequest, use, d.adapters)).workspace, demo);
    assert.equal(d.calls.memberships, 0);
    const noOrigin = question(path, body); noOrigin.headers.delete('origin');
    const empty = fixture();
    await assert.rejects(withWorkspaceEntry(env, noOrigin, use, empty.adapters));
    assert.equal(empty.calls.opened, 0);
    noOrigin.headers.set('referer', origin + '/alerts'); noOrigin.headers.set('sec-fetch-site', 'same-origin');
    assert.equal((await withWorkspaceEntry(env, noOrigin, use, empty.adapters)).workspace, a);
  }
});
test('stalled and oversized stored POSTs refuse boundedly with no identity or store acquisition', async (t) => {
  fakeClock(t);
  // A stalled body is refused at the 2 s whole-read deadline, not before; an
  // oversized one at once, on its size.
  for (const [stalled, body] of [[true, new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })],
    [false, new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); } })]]) {
    const f = fixture();
    const proof = new Request(origin + '/api/mcp', { method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'x-noticeos-workspace-id': a, [WORKSPACE_SESSION_HEADER]: session },
      body, duplex: 'half' });
    const entry = withWorkspaceEntry(env, proof, use, f.adapters);
    await assert.rejects(stalled ? atDeadline(t, entry, 2_000) : entry);
    assert.equal(f.calls.opened, 0); assert.equal(f.calls.stores.length, 0);
  }
});


const mutationProof = (path, method, body, evidence = {}) => new Request(origin + path, {
  method, headers: { origin, 'content-type': 'application/json', 'x-noticeos-workspace-id': a,
    [WORKSPACE_SESSION_HEADER]: session, ...evidence }, body: JSON.stringify(body),
});
test('fixed asset receiver binds every original input and preserves the browser body', async () => {
  const cases = [
    ['moveAsset', '/api/assets/example.test/order', 'PATCH', { to: 'other.test' }, { asset: 'example.test', to: 'other.test' }],
    ['moveAsset', '/api/assets/example.test/order', 'PATCH', { to: 'other.test', expectRevision: 'a'.repeat(64) }, { asset: 'example.test', to: 'other.test', expectRevision: 'a'.repeat(64) }],
    ['createAsset', '/api/assets', 'POST', { id: 'example.test', displayName: 'Example' }, { id: 'example.test', displayName: 'Example' }],
    ['readAssetState', '/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'build' }, 'example.test'],
    ['writeAssetColumn', '/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'build' }, { asset: 'example.test', column: 'status', value: 'live', expect: 'build' }],
    ['createAnnotation', '/api/assets/example.test/annotations', 'POST', { kind: 'ship', ref: ' ', note: '' }, { asset: 'example.test', kind: 'ship', at: undefined, ref: null, note: null }],
  ];
  for (const [method, path, verb, body, input] of cases) {
    const proof = mutationProof(path, verb, body);
    await assetMutationArguments(input, proof, method);
    assert.deepEqual(await proof.json(), body);
    await assert.rejects(assetMutationArguments(typeof input === 'string' ? 'foreign.test' : { ...input, workspaceId: b }, mutationProof(path, verb, body), method));
    await assert.rejects(assetMutationArguments(input, mutationProof(path, verb, body), method === 'createAsset' ? 'createAnnotation' : 'createAsset'));
  }
  await assert.rejects(assetMutationArguments({ asset: 'example.test', column: 'status', value: 'retired' }, mutationProof('/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'build' }), 'writeAssetColumn'));
  for (const expect of [null, false, 0]) {
    const body = { column: 'sense_only', value: 1, expect };
    await assetMutationArguments({ asset: 'example.test', ...body }, mutationProof('/api/assets/example.test', 'PATCH', body), 'writeAssetColumn');
    await assert.rejects(assetMutationArguments({ asset: 'example.test', column: 'sense_only', value: 1 }, mutationProof('/api/assets/example.test', 'PATCH', body), 'writeAssetColumn'));
    await assert.rejects(assetMutationArguments({ asset: 'example.test', ...body, expect: 'substituted' }, mutationProof('/api/assets/example.test', 'PATCH', body), 'writeAssetColumn'));
  }
  await assert.rejects(assetMutationArguments({ asset: 'example.test', column: 'status', value: 'live' }, mutationProof('/api/assets/example.test', 'PATCH', { column: 'status', value: 'live' }), 'writeAssetColumn'));
});
test('all hosted mutation families require strict original browser evidence before identity I/O', async () => {
  const f = fixture();
  for (const [path, method, body] of [
    ['/api/assets/example.test/order', 'PATCH', { to: 'other.test' }],
    ['/api/assets', 'POST', { id: 'example.test', displayName: 'Example' }],
    ['/api/assets/example.test', 'PATCH', { column: 'status', value: 'live', expect: 'build' }],
    ['/api/assets/example.test/annotations', 'POST', { kind: 'ship' }],
    ['/api/assets/example.test/decisions', 'POST', { kind: 'query', key: 'fixture', status: 'marked' }],
    ['/api/flags/17', 'PATCH', { action: 'acknowledge' }],
  ]) {
    for (const evidence of [{ origin: 'https://foreign.example.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])
      await assert.rejects(withWorkspaceEntry(env, mutationProof(path, method, body, evidence), use, f.adapters));
    const missing = mutationProof(path, method, body); missing.headers.delete('origin');
    await assert.rejects(withWorkspaceEntry(env, missing, use, f.adapters));
    await withWorkspaceEntry(env, mutationProof(path, method, body), use, f.adapters);
  }
  assert.equal(f.calls.opened, 6); assert.equal(f.calls.closed, 6);
});
test('viewer/demo mutation and protected tune/watch refuse without operational store access', async () => {
  const f = fixture();
  for (const [path, body] of [['/api/flags/17', { action: 'tune', tuned: {} }], ['/api/assets/example.test/watch-windows', {}]])
    await assert.rejects(withWorkspaceEntry(env, mutationProof(path, path.includes('flags') ? 'PATCH' : 'POST', body), use, f.adapters));
  const create = mutationProof('/api/assets', 'POST', { id: 'example.test', displayName: 'Example' });
  create.headers.set('x-noticeos-workspace-id', b);
  await assert.rejects(withWorkspaceEntry(env, create, use, f.adapters));
  const anon = mutationProof('/api/assets', 'POST', { id: 'example.test', displayName: 'Example' });
  anon.headers.set('x-noticeos-workspace-id', demo);
  await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, anon, use, f.adapters));
  assert.deepEqual(f.calls.stores, []);
});


test('watch history duplicate arguments bind exactly to original query and fixed UTC calibration window', async () => {
  const path = '/api/assets/example.test/watch-query-history?query=Shared%20query&metric=clicks';
  const original = request({ path });
  const now = Date.parse('2026-08-04T12:00:00Z');
  const input = { asset: 'example.test', query: 'Shared query', metric: 'clicks', first_day: '2026-02-06', last_day: '2026-08-04' };
  assert.deepEqual(await watchQueryHistoryArguments(input, original, now), input);
  for (const patch of [{ asset: 'foreign.test' }, { query: 'Other query' }, { metric: 'position' },
    { first_day: '2026-02-05' }, { last_day: '2026-08-05' }, { workspaceId: b }, { actor: 'owner' }]) {
    await assert.rejects(watchQueryHistoryArguments({ ...input, ...patch }, original, now));
  }
  await assert.rejects(watchQueryHistoryArguments(input, request(), now));
  const f = fixture();
  assert.equal((await withWorkspaceEntry(env, request({ path, workspace: b }), use, f.adapters)).workspace, b);
  assert.equal((await withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, request({ path, workspace: null }), use, f.adapters)).workspace, demo);
  f.memberships.delete(b);
  await assert.rejects(withWorkspaceEntry(env, request({ path, workspace: b }), use, f.adapters));
  f.states.set(demo, 'suspended');
  await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, request({ path }), use, f.adapters));
  assert.deepEqual(f.calls.stores, [b, demo]);
});

test('an agent token reaches the MCP read models in each of its person\'s workspaces, as that person (agent sign-in, epic ro-cvl9)', async () => {
  const question = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_properties', arguments: {} } };
  const agentRequest = (token, { path = '/api/mcp', workspace = a, headers = {}, body = question } = {}) => new Request(origin + path, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(workspace === null ? {} : { 'x-noticeos-workspace-id': workspace }), ...headers }, body: JSON.stringify(body) });
  const f = fixture();
  // No browser evidence: the token names the person, the call names the workspace.
  assert.deepEqual(await withWorkspaceEntry(env, agentRequest('agent-token-evidence-0001'), async call => ({
    workspace: call.context.workspaceId, actor: call.context.principalId, kind: call.context.principalKind, client: call.context.agentClientId,
  }), f.adapters), { workspace: a, actor: principal, kind: 'agent', client: 'example-agent' });
  assert.equal(f.calls.memberships, 0, 'an agent request never reads a browser session');
  // The same token reads in the person's other workspace, where they are a viewer.
  assert.deepEqual(await withWorkspaceEntry(env, agentRequest('agent-token-evidence-0001', { workspace: b }), use, f.adapters), { workspace: b, actor: principal });
  // No workspace named, one the person is not in, a token without the
  // read-model scope, an unknown token, and a lapsed workspace all refuse.
  for (const original of [agentRequest('agent-token-evidence-0001', { workspace: null }),
    agentRequest('agent-token-evidence-0001', { workspace: demo }),
    agentRequest('agent-token-tasks-only-0002'), agentRequest('agent-token-unknown-000000000')]) {
    await assert.rejects(withWorkspaceEntry(env, original, use, f.adapters));
  }
  f.states.set(a, 'suspended');
  await assert.rejects(withWorkspaceEntry(env, agentRequest('agent-token-evidence-0001'), use, f.adapters));
  f.states.set(a, 'active');
  // Anywhere but the MCP endpoint, in the demo, or malformed: refused before identity I/O.
  const opened = f.calls.opened;
  for (const [original, profile] of [
    [new Request(origin + '/api/config', { headers: { authorization: 'Bearer agent-token-evidence-0001', 'x-noticeos-workspace-id': a } }), 'hosted'],
    [agentRequest('agent-token-evidence-0001', { path: '/api/alerts/backtest', body: { asset: 'example.com', ruleId: 'r', config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 } } }), 'hosted'],
    [agentRequest('agent-token-evidence-0001', { workspace: null }), 'demo'],
    [new Request(agentRequest('x'), { headers: { authorization: 'Basic abc', 'content-type': 'application/json', 'x-noticeos-workspace-id': a } }), 'hosted'],
  ]) await assert.rejects(withWorkspaceEntry({ ...env, NOTICEOS_WORKSPACE_PROFILE: profile }, original, use, f.adapters));
  assert.equal(f.calls.opened, opened);
});
