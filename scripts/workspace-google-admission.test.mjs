import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWorkspaceAdmission, AdmissionRefused } from './workspace-admission.mjs';
import { GOOGLE_INTEGRATION_START, GOOGLE_INTEGRATION_CALLBACK } from './workspace-operations.mjs';

const origin = 'https://fixture.example.test', workspaceId = randomUUID(), sessionId = randomUUID();
const now = Date.parse('2026-10-01T12:00:00Z');
const state = randomBytes(32).toString('base64url');
const facts = () => ({ principalId: randomUUID(), sessionId, workspaceId, role: 'owner',
  workspaceStatus: 'active', expiresAt: new Date(now + 60000).toISOString() });
const start = (headers = {}, body) => new Request(`${origin}${GOOGLE_INTEGRATION_START}`, { method: 'POST',
  headers: { [WORKSPACE_SESSION_HEADER]: sessionId, origin, 'x-noticeos-workspace-id': workspaceId, ...headers }, ...(body === undefined ? {} : { body }) });
const callback = (suffix = '&code=generated-code', headers = {}) => new Request(`${origin}${GOOGLE_INTEGRATION_CALLBACK}?state=${state}${suffix}`,
  { headers: { cookie: 'generated-cookie-proof', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers } });
function fixture(adapter, clock = () => now) {
  return createWorkspaceAdmission({ kind: 'hosted', profile: Symbol('fixture'), trustedOrigin: origin, now: clock,
    membership: async () => assert.fail('fixed protocol uses transaction facts, not a second cached observation'), googleOAuth: adapter });
}

test('start releases the fixed live context only after committed issuance', async () => {
  const held = facts(); let committed = false, escaped;
  const gate = fixture({ issue: async (request, workspace, authorize) => {
    assert.equal(workspace, workspaceId); assert.equal(request.method, 'POST'); authorize(held); committed = true; return state;
  }, claim: async () => assert.fail() });
  await gate.withGoogleStart('start', start(), async (context, issued) => {
    assert.equal(committed, true); assert.equal(issued, state); escaped = context;
    assert.equal(context.sessionId, held.sessionId); assert.equal(context.action, 'integrations.write');
    assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.allowedActions)); gate.assertContext(context, 'integrations.write');
    assert.throws(() => gate.assertContext({ ...context }, 'integrations.write'), AdmissionRefused);
    assert.throws(() => gate.assertContext(context, 'settings.write'), AdmissionRefused);
  });
  assert.throws(() => gate.assertContext(escaped, 'integrations.write'), AdmissionRefused);
});

test('exact Google callback retains original navigation/cookie proof, then releases post-commit context', async () => {
  const held = facts(); let committed = false;
  const gate = fixture({ issue: async () => assert.fail(), claim: async (request, authorize) => {
    assert.equal(request.headers.get('cookie'), 'generated-cookie-proof'); assert.equal(request.headers.get('sec-fetch-site'), 'cross-site');
    assert.equal(request.url, callback().url); authorize(held); committed = true;
  } });
  await gate.withGoogleCallback('callback', callback(), async context => {
    assert.equal(committed, true); assert.equal(context.workspaceId, held.workspaceId); assert.equal(context.principalId, held.principalId);
    gate.assertContext(context, 'integrations.write');
  });
});

test('unconfigured, standalone, service and demo profiles cannot use protocol adapters', async () => {
  const profiles = [fixture(undefined), createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId, workspaceStatus: async () => assert.fail() }),
    createWorkspaceAdmission({ kind: 'standalone', profile: Symbol(), authority: async () => assert.fail() }),
    createWorkspaceAdmission({ kind: 'service', profile: Symbol(), authority: async () => assert.fail() })];
  for (const gate of profiles) {
    await assert.rejects(gate.withGoogleStart('start', start(), async () => assert.fail()), AdmissionRefused);
    await assert.rejects(gate.withGoogleCallback('callback', callback(), async () => assert.fail()), AdmissionRefused);
  }
  let getters = 0;
  assert.throws(() => fixture({ issue: async () => state, get claim() { getters++; return async () => {}; } }), AdmissionRefused);
  assert.equal(getters, 0);
});

test('malformed protocol, workspace overrides and missing browser evidence refuse before adapters', async () => {
  let calls = 0;
  const gate = fixture({ issue: async () => { calls++; return state; }, claim: async () => { calls++; } });
  for (const request of [start({ origin: 'https://foreign.example.test' }), start({ 'sec-fetch-site': 'cross-site' }),
    start({ 'x-noticeos-workspace-id': `${workspaceId}, ${workspaceId}` }), start({}, '{"profile":"standalone"}'),
    new Request(`${origin}${GOOGLE_INTEGRATION_START}`, { method: 'POST', headers: { 'x-noticeos-workspace-id': workspaceId } })]) {
    await assert.rejects(gate.withGoogleStart('start', request, async () => assert.fail()), AdmissionRefused);
  }
  for (const request of [callback('&code=one&code=two'), callback('&code=one&actor=owner'), callback('&error=access_denied&code=one'),
    callback('&code=one', { 'x-noticeos-workspace-id': workspaceId }), callback('&code='),
    new Request(`https://foreign.example.test${GOOGLE_INTEGRATION_CALLBACK}?state=${state}&code=one`),
    new Request(`${origin}/api/config?state=${state}&code=one`)]) {
    await assert.rejects(gate.withGoogleCallback('callback', request, async () => assert.fail()), AdmissionRefused);
  }
  await assert.rejects(gate.withGoogleStart('start', start(), undefined), AdmissionRefused);
  assert.equal(calls, 0);
});

test('missing, repeated or rejected authorization cannot release a context even if adapter swallows denial', async () => {
  let effects = 0;
  const modes = [async () => {}, async (_request, authorize) => { authorize(facts()); try { authorize(facts()); } catch {} },
    async (_request, authorize) => { try { authorize({ ...facts(), role: 'viewer' }); } catch {} },
    async (_request, authorize) => { try { authorize({ ...facts(), actor: 'claimed-owner' }); } catch {} }];
  for (const claim of modes) {
    const gate = fixture({ issue: async () => state, claim });
    await assert.rejects(gate.withGoogleCallback('callback', callback(), async () => { effects++; }), AdmissionRefused);
  }
  assert.equal(effects, 0);
});

test('expiry and clock are checked again after the committed transaction resolves', async () => {
  for (const late of [Number.NaN, now + 60000]) {
    let clock = now, effects = 0;
    const gate = fixture({ issue: async () => state, claim: async (_request, authorize) => { authorize(facts()); clock = late; } }, () => clock);
    await assert.rejects(gate.withGoogleCallback('callback', callback(), async () => { effects++; }), AdmissionRefused);
    assert.equal(effects, 0);
  }
});

test('the authorized snapshot is independent of mutable adapter facts and cross-factory contexts refuse', async () => {
  const held = facts(), expected = held.principalId;
  const adapter = { issue: async () => state, claim: async (_request, authorize) => { authorize(held); held.principalId = randomUUID(); } };
  const gate = fixture(adapter), foreign = fixture(adapter);
  await gate.withGoogleCallback('callback', callback(), async context => {
    assert.equal(context.principalId, expected);
    assert.throws(() => foreign.assertContext(context, 'integrations.write'), AdmissionRefused);
  });
});


test('Google start requires the expected session before opening custody and compares it before issuance commits', async () => {
  let opened = 0, committed = 0, effects = 0;
  const held = { ...facts(), sessionId: randomUUID() };
  const gate = fixture({ issue: async (_proof, _workspace, authorize) => { opened++; authorize(held); committed++; return state; }, claim: async () => assert.fail() });
  for (const expected of [undefined, '', 'invalid', `${sessionId}, ${sessionId}`]) {
    const headers = { origin, 'x-noticeos-workspace-id': workspaceId, ...(expected === undefined ? {} : { [WORKSPACE_SESSION_HEADER]: expected }) };
    await assert.rejects(gate.withGoogleStart('start', new Request(start().url, { method: 'POST', headers }), async () => { effects++; }), AdmissionRefused);
  }
  assert.equal(opened, 0);
  await assert.rejects(gate.withGoogleStart('start', start(), async () => { effects++; }), AdmissionRefused);
  assert.equal(opened, 1); assert.equal(committed, 0); assert.equal(effects, 0);
  await gate.withGoogleStart('start', start({ [WORKSPACE_SESSION_HEADER]: held.sessionId }), async () => { effects++; });
  assert.equal(committed, 1); assert.equal(effects, 1);
});
