import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AdmissionRefused, createWorkspaceAdmission } from './workspace-admission.mjs';

const [a, b, demo, person, session] = Array.from({ length: 5 }, () => randomUUID());
const origin = 'https://fixture.example.test';
const now = Date.parse('2026-10-01T12:00:00Z');
const expiresAt = new Date(now + 60_000).toISOString();
const selection = (workspaceId = a) => ({ requestedWorkspaceId: workspaceId, correlationId: 'fixture-request' });
const request = (headers = {}, method = 'GET', url = origin) => new Request(url, { method, headers: { [WORKSPACE_SESSION_HEADER]: session, ...headers } });
function hosted() {
  const memberships = new Map([[a, 'owner'], [b, 'viewer']]);
  const states = new Map([[a, 'active'], [b, 'active']]);
  let expires = expiresAt, calls = 0, clock = now;
  const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
    now: () => clock, membership: async (_headers, workspaceId) => {
      calls++;
      const role = memberships.get(workspaceId);
      return role ? { principalId: person, sessionId: session, expiresAt: expires,
        workspaceId, role, workspaceStatus: states.get(workspaceId) } : null;
    } });
  return { admission, memberships, states, calls: () => calls,
    expiry: value => { expires = value; }, clock: value => { clock = value; } };
}
const run = (admission, action = 'evidence.read', pick = selection(), proof = request(), work = async value => value) =>
  admission.withAdmission(action, pick, proof, work);

test('human decisions require a current person operator or explicit standalone operator, never a service grant', async () => {
  const f = hosted(); let effects = 0;
  for (const role of ['owner', 'operator']) {
    f.memberships.set(a, role);
    const context = await run(f.admission, 'tasks.decide', selection(), request({ origin }, 'POST'), async context => {
      effects++; assert.equal(context.principalKind, 'person'); return context;
    });
    assert.ok(context.allowedActions.includes('tasks.decide'));
  }
  f.memberships.set(a, 'viewer');
  await assert.rejects(run(f.admission, 'tasks.decide', selection(), request({ origin }, 'POST'), async () => effects++), AdmissionRefused);
  f.memberships.delete(a);
  await assert.rejects(run(f.admission, 'tasks.decide', selection(), request({ origin }, 'POST'), async () => effects++), AdmissionRefused);
  const anonymous = createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: demo, workspaceStatus: async () => 'active' });
  await assert.rejects(run(anonymous, 'tasks.decide', selection(demo), request({ origin }, 'POST'), async () => effects++), AdmissionRefused);
  const service = createWorkspaceAdmission({ kind: 'service', profile: Symbol(), now: () => now,
    authority: async () => ({ principalId: 'service-questions', workspaceId: a, workspaceStatus: 'active', expiresAt,
      actions: ['tasks.write', 'tasks.decide'] }) });
  await assert.rejects(run(service, 'tasks.decide', selection(), request(), async () => effects++), AdmissionRefused);
  const standalone = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol(), authority: async () =>
    ({ principalId: 'operator', workspaceId: a, workspaceStatus: 'active' }) });
  await run(standalone, 'tasks.decide', selection(), request(), async context => {
    effects++; assert.equal(context.principalKind, 'standalone-operator');
  });
  assert.equal(effects, 3);
});

test('permission metadata and admission use one fresh policy; metadata never admits later writes', async () => {
  const fixture = hosted();
  const owner = await run(fixture.admission);
  assert.ok(Object.isFrozen(owner.allowedActions));
  assert.ok(owner.allowedActions.includes('settings.write'));
  assert.ok(owner.allowedActions.includes('memberships.manage'));
  assert.equal(owner.allowedActions.includes('measurement.write'), false);
  fixture.memberships.set(a, 'operator');
  const operator = await run(fixture.admission);
  assert.ok(operator.allowedActions.includes('settings.write'));
  assert.equal(operator.allowedActions.includes('memberships.manage'), false);
  fixture.memberships.set(a, 'viewer');
  const viewer = await run(fixture.admission);
  assert.ok(viewer.allowedActions.includes('settings.read'));
  assert.equal(viewer.allowedActions.includes('settings.write'), false);
  await assert.rejects(run(fixture.admission, 'settings.write', selection(), request({ origin })), AdmissionRefused);
  fixture.memberships.delete(a);
  await assert.rejects(run(fixture.admission), AdmissionRefused);
  const demoAdmission = createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: demo, workspaceStatus: async () => 'active' });
  const anonymous = await run(demoAdmission, 'settings.read', selection(demo));
  assert.deepEqual(anonymous.allowedActions, viewer.allowedActions);
  const service = createWorkspaceAdmission({ kind: 'service', profile: Symbol(), now: () => now,
    authority: async () => ({ principalId: 'fixture-service', workspaceId: a, workspaceStatus: 'active', expiresAt, actions: ['settings.read', 'settings.write'] }) });
  assert.deepEqual((await run(service, 'settings.read')).allowedActions, ['settings.read', 'settings.write']);
});

test('fresh membership selects one of two workspaces and no active-selection cookie grants role', async () => {
  const fixture = hosted();
  const first = await run(fixture.admission);
  const second = await run(fixture.admission, 'tasks.read', selection(b), request({ cookie: 'activeOrganization=other' }));
  assert.equal(first.workspaceId, a); assert.equal(second.workspaceId, b);
  assert.equal(first.principalId, person); assert.equal(first.principalKind, 'person');
  await assert.rejects(run(fixture.admission, 'tasks.write', selection(b), request({ origin })), AdmissionRefused);
  fixture.memberships.set(b, 'operator');
  await run(fixture.admission, 'tasks.write', selection(b), request({ origin }));
  fixture.memberships.delete(b);
  await assert.rejects(run(fixture.admission, 'tasks.read', selection(b)), AdmissionRefused);
});

test('expired session, invalid current role and inactive lifecycle deny before capabilities', async () => {
  const fixture = hosted(); let capabilities = 0;
  const work = async () => { capabilities++; };
  for (const state of ['provisioning', 'suspended', null, 'unknown']) {
    fixture.states.set(a, state);
    await assert.rejects(run(fixture.admission, 'evidence.read', selection(), request(), work), AdmissionRefused);
  }
  fixture.states.set(a, 'active'); fixture.expiry(new Date(now).toISOString());
  await assert.rejects(run(fixture.admission, 'evidence.read', selection(), request(), work), AdmissionRefused);
  fixture.expiry(expiresAt); fixture.memberships.set(a, 'admin');
  await assert.rejects(run(fixture.admission, 'evidence.read', selection(), request(), work), AdmissionRefused);
  assert.equal(capabilities, 0);
});

test('unknown actions, forged profile/principal/verified keys and malformed selectors deny before authority', async () => {
  const fixture = hosted();
  for (const forged of [{ workspaceId: a }, { principalId: person }, { role: 'owner' }, { verified: true }, { profile: Symbol() }, { entryProfile: 'standalone' }, { action: 'tasks.write' }]) {
    await assert.rejects(run(fixture.admission, 'evidence.read', { ...selection(), ...forged }), AdmissionRefused);
  }
  for (const pick of [{ correlationId: '' }, { ...selection(), requestedWorkspaceId: '../foreign' }, { ...selection(), correlationId: 'x'.repeat(129) }]) {
    await assert.rejects(run(fixture.admission, 'evidence.read', pick), AdmissionRefused);
  }
  await assert.rejects(run(fixture.admission, 'future.secret.read'), AdmissionRefused);
  await assert.rejects(run(fixture.admission, 'measurement.write', selection(), request({ origin })), AdmissionRefused);
  await assert.rejects(run(fixture.admission, 'evidence.read', selection(), { verified: true }), AdmissionRefused);
  assert.equal(fixture.calls(), 0);
});

test('server entries validate plain data without coercion or getter execution', () => {
  let effects = 0;
  assert.throws(() => createWorkspaceAdmission({ kind: { toString() { effects++; return 'hosted'; } }, profile: Symbol() }), AdmissionRefused);
  assert.throws(() => createWorkspaceAdmission({ get kind() { effects++; return 'demo'; } }), AdmissionRefused);
  assert.throws(() => createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: 'https://*.example.test', membership: async () => null }), AdmissionRefused);
  assert.equal(effects, 0);
});

test('effect authorization is semantic: stored POST reads work; provider GET needs browser proof', async () => {
  const fixture = hosted();
  await run(fixture.admission, 'evidence.read', selection(b), request({}, 'POST'));
  await assert.rejects(run(fixture.admission, 'provider.read', selection(), request()), AdmissionRefused);
  await run(fixture.admission, 'provider.read', selection(), request({ origin }));
  await run(fixture.admission, 'provider.read', selection(), request({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }));
  await run(fixture.admission, 'tasks.write', selection(), request({ origin: 'null', 'sec-fetch-site': 'same-origin' }, 'POST'));
});

test('origin contradictions, missing evidence and different canonical targets deny before authority', async () => {
  const fixture = hosted(); let capabilities = 0;
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://foreign.example.test', 'sec-fetch-site': 'same-origin' },
    { origin, 'sec-fetch-site': 'cross-site' }, { origin, 'sec-fetch-site': 'same-site' },
    { origin: `${origin}, ${origin}` }, { origin: `${origin}/` },
    { origin, 'sec-fetch-mode': 'navigate' }, { origin, 'sec-fetch-dest': 'document' }]) {
    await assert.rejects(run(fixture.admission, 'tasks.write', selection(), request(headers, 'POST'), async () => { capabilities++; }), AdmissionRefused);
  }
  for (const headers of [{ origin }, { 'sec-fetch-site': 'same-origin' }, { origin: 'null', 'sec-fetch-site': 'same-origin' }]) {
    await assert.rejects(run(fixture.admission, 'provider.read', selection(), request(headers, 'GET', 'https://foreign.example.test')), AdmissionRefused);
  }
  await assert.rejects(run(fixture.admission, 'evidence.read', selection(), request({ host: 'fixture.example.test', 'x-forwarded-host': 'fixture.example.test' }, 'GET', 'https://foreign.example.test')), AdmissionRefused);
  assert.equal(capabilities, 0); assert.equal(fixture.calls(), 0);
});

test('factory-scoped context supports composite reads but copies/action upgrades/escape refuse', async () => {
  const fixture = hosted(), other = hosted(); let escaped;
  await run(fixture.admission, 'evidence.read', selection(), request(), async context => {
    escaped = context;
    assert.ok(Object.isFrozen(context));
    fixture.admission.assertContext(context, 'evidence.read');
    fixture.admission.assertContext(context, 'evidence.read'); // same-operation config dependency
    assert.throws(() => fixture.admission.assertContext(context, 'settings.write'), AdmissionRefused);
    assert.throws(() => other.admission.assertContext(context, 'evidence.read'), AdmissionRefused);
    assert.throws(() => fixture.admission.assertContext({ ...context }, 'evidence.read'), AdmissionRefused);
    assert.throws(() => fixture.admission.assertContext(JSON.parse(JSON.stringify(context)), 'evidence.read'), AdmissionRefused);
    assert.throws(() => { context.workspaceId = b; }, TypeError);
  });
  assert.throws(() => fixture.admission.assertContext(escaped, 'evidence.read'), AdmissionRefused);
  let failed;
  await assert.rejects(run(fixture.admission, 'evidence.read', selection(), request(), async context => { failed = context; throw new Error('operation failed'); }), /operation failed/u);
  assert.throws(() => fixture.admission.assertContext(failed, 'evidence.read'), AdmissionRefused);
});

test('fact lookup failures disclose no raw transport details and no profile fallback', async () => {
  const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
    membership: async () => { throw new Error('synthetic transport detail'); } });
  await assert.rejects(run(admission), error => error instanceof AdmissionRefused && !error.message.includes('transport'));
  const missing = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin, membership: async () => null });
  await assert.rejects(run(missing), AdmissionRefused);
});

test('demo always stays anonymous and pinned despite customer cookies', async () => {
  let state = 'active', reads = 0;
  const admission = createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: demo,
    workspaceStatus: async id => { assert.equal(id, demo); reads++; return state; } });
  const proof = request({ cookie: 'customer-owner-session', origin });
  const context = await run(admission, 'tasks.read', selection(demo), proof);
  assert.equal(context.principalId, 'demo-reader'); assert.equal(context.principalKind, 'demo-reader');
  for (const action of ['provider.read', 'tasks.write', 'memberships.manage', 'measurement.write', 'future.secret.read']) {
    await assert.rejects(run(admission, action, selection(demo), proof), AdmissionRefused);
  }
  await assert.rejects(run(admission, 'tasks.read', selection(a), proof), AdmissionRefused);
  assert.equal(reads, 1); state = 'suspended';
  await assert.rejects(run(admission, 'tasks.read', selection(demo), proof), AdmissionRefused);
});

test('standalone requires explicit authenticated sole-workspace authority, never a verified boolean', async () => {
  let authority = null;
  const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol(), authority: async proof => {
    return proof.headers.get('x-fixture-door') === 'owned' ? authority : null;
  } });
  await assert.rejects(run(admission), AdmissionRefused);
  authority = { principalId: 'standalone-operator', workspaceId: a, workspaceStatus: 'active' };
  await assert.rejects(run(admission), AdmissionRefused);
  const proof = request({ 'x-fixture-door': 'owned' });
  await run(admission, 'tasks.write', selection(), proof);
  await assert.rejects(run(admission, 'tasks.write', selection(b), proof), AdmissionRefused);
  authority = null; // the existing sole-workspace resolver refuses ambiguity
  await assert.rejects(run(admission, 'tasks.read', selection(), proof), AdmissionRefused);
});

test('service proof reloads an exact scoped grant, expiry and lifecycle, without implicit owner', async () => {
  let grant = { principalId: 'service-collection', workspaceId: a, workspaceStatus: 'active', expiresAt, actions: ['provider.read'] };
  const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol(), now: () => now,
    authority: async proof => proof.headers.get('x-fixture-service') === 'owned' ? grant : null });
  const proof = request({ 'x-fixture-service': 'owned' });
  await assert.rejects(run(admission, 'provider.read'), AdmissionRefused);
  assert.equal((await run(admission, 'provider.read', selection(), proof)).principalKind, 'workspace-service');
  for (const action of ['tasks.write', 'memberships.manage', 'measurement.write']) await assert.rejects(run(admission, action, selection(), proof), AdmissionRefused);
  await assert.rejects(run(admission, 'provider.read', selection(b), proof), AdmissionRefused);
  grant.actions = []; await assert.rejects(run(admission, 'provider.read', selection(), proof), AdmissionRefused);
  for (const forbidden of ['memberships.manage', 'measurement.write', 'platform.maintain', 'unknown.read']) {
    grant.actions = ['provider.read', forbidden];
    await assert.rejects(run(admission, 'provider.read', selection(), proof), AdmissionRefused);
  }
  grant.actions = ['provider.read']; grant.workspaceStatus = 'provisioning';
  await assert.rejects(run(admission, 'provider.read', selection(), proof), AdmissionRefused);
  grant.workspaceStatus = 'active'; grant.expiresAt = new Date(now).toISOString();
  await assert.rejects(run(admission, 'provider.read', selection(), proof), AdmissionRefused);
  grant = null; await assert.rejects(run(admission, 'provider.read', selection(), proof), AdmissionRefused);
});

test('clock is checked again after asynchronous authority lookup', async () => {
  let clock = now, capabilities = 0;
  const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin, now: () => clock,
    membership: async () => { clock = Number.NaN; return { principalId: person, sessionId: session, expiresAt,
      workspaceId: a, workspaceStatus: 'active', role: 'owner' }; } });
  await assert.rejects(run(admission, 'evidence.read', selection(), request(), async () => { capabilities++; }), AdmissionRefused);
  assert.equal(capabilities, 0);
});

test('mutable input entry is snapshotted, and original proof body remains available', async () => {
  const entry = { kind: 'service', profile: Symbol(), now: () => now, authority: async proof => {
    assert.equal(await proof.text(), 'owned-envelope');
    return { principalId: 'service', workspaceId: a, workspaceStatus: 'active', expiresAt, actions: ['tasks.write'] };
  } };
  const admission = createWorkspaceAdmission(entry);
  entry.kind = 'demo'; entry.profile = Symbol(); entry.authority = async () => null;
  const proof = new Request(origin, { method: 'POST', body: 'owned-envelope' });
  const context = await run(admission, 'tasks.write', selection(), proof);
  assert.equal(context.entryProfile, 'service'); assert.equal(await proof.text(), 'owned-envelope');
});


test('all hosted reads and effects bind the captured expected session before capabilities', async () => {
  let reads = 0, effects = 0;
  let currentSession = session;
  const gate = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin, now: () => now,
    membership: async () => { reads++; return { principalId: person, sessionId: currentSession, expiresAt,
      workspaceId: a, role: 'owner', workspaceStatus: 'active' }; } });
  for (const action of ['evidence.read', 'settings.write', 'provider.read']) {
    for (const expected of [undefined, '', 'not-a-session', session.toUpperCase(), `${session}, ${session}`]) {
      const headers = { origin, ...(expected === undefined ? {} : { [WORKSPACE_SESSION_HEADER]: expected }) };
      await assert.rejects(run(gate, action, selection(), new Request(origin, { headers }), async () => { effects++; }), AdmissionRefused);
    }
  }
  assert.equal(reads, 0); assert.equal(effects, 0);
  currentSession = randomUUID();
  for (const action of ['evidence.read', 'settings.write', 'provider.read'])
    await assert.rejects(run(gate, action, selection(), request({ origin }), async () => { effects++; }), AdmissionRefused);
  assert.equal(reads, 3); assert.equal(effects, 0);
  await run(gate, 'settings.write', selection(), request({ origin, [WORKSPACE_SESSION_HEADER]: currentSession }), async () => { effects++; });
  assert.equal(effects, 1);
});

test('expected session is snapshotted before an asynchronous fresh identity read', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  const successor = randomUUID();
  const gate = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin, now: () => now,
    membership: async headers => { entered(); await waiting; assert.equal(headers.get(WORKSPACE_SESSION_HEADER), session);
      return { principalId: person, sessionId: successor, expiresAt, workspaceId: a, role: 'owner', workspaceStatus: 'active' }; } });
  const original = request();
  const outcome = assert.rejects(run(gate, 'evidence.read', selection(), original, async () => assert.fail()), AdmissionRefused);
  await reading; original.headers.set(WORKSPACE_SESSION_HEADER, successor); release(); await outcome;
});
