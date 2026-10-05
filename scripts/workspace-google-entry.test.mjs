import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { googleOAuthArguments, withGoogleWorkspaceEntry } from './workspace-entry.mjs';
import { GOOGLE_INTEGRATION_START, GOOGLE_INTEGRATION_CALLBACK } from './workspace-operations.mjs';

const origin = 'https://fixture.example.test', workspace = randomUUID(), principal = randomUUID(), sessionId = randomUUID();
const state = randomBytes(32).toString('base64url');
const env = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
  NOTICEOS_WORKSPACE_DATABASE_URL: 'postgresql://noticeos_app@localhost/fixture',
  NOTICEOS_IDENTITY_DATABASE_URL: 'postgresql://noticeos_identity@localhost/fixture',
  NOTICEOS_IDENTITY_SESSION_SECRET: randomBytes(48).toString('base64url') };
const start = () => new Request(origin + GOOGLE_INTEGRATION_START, { method: 'POST', headers: { [WORKSPACE_SESSION_HEADER]: sessionId, origin, 'x-noticeos-workspace-id': workspace } });
const callback = () => new Request(`${origin}${GOOGLE_INTEGRATION_CALLBACK}?state=${state}&code=generated-code`);
function fixture() {
  let role = 'owner', committed = false;
  const calls = { open: 0, close: 0, store: [] };
  const facts = () => ({ workspaceId: workspace, principalId: principal, sessionId, role,
    expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceStatus: 'active' });
  const adapters = {
    openCustody(options) {
      calls.open++; assert.equal(options.connectionString, env.NOTICEOS_IDENTITY_DATABASE_URL);
      return {
        async issueGoogle(request, id, authorize) { assert.equal(request.url, start().url); assert.equal(id, workspace); authorize(facts()); committed = true; return state; },
        async claimGoogleCallback(request, authorize) { assert.equal(request.url, callback().url); authorize(facts()); committed = true; },
        async close() { calls.close++; },
      };
    },
    async withStore(selection, _ctx, work) {
      assert.equal(committed, true); assert.equal(selection.workspace.workspaceId, workspace);
      calls.store.push(workspace); return work({ workspaceId: workspace });
    },
  };
  return { adapters, calls, role: value => { role = value; } };
}
test('fixed receiver arguments compare all fields and never forward options or authority', async () => {
  assert.deepEqual(await googleOAuthArguments({ origin }, start(), origin, 'start'), { origin });
  const input = { error: null, redirectUri: origin + GOOGLE_INTEGRATION_CALLBACK, state, code: 'generated-code' };
  assert.deepEqual(googleOAuthArguments(input, callback(), origin, 'callback'), input);
  for (const override of [{ nowMs: 0 }, { actor: principal }, { workspaceId: workspace }, { fetchImpl() {} }, { verified: true }]) {
    assert.throws(() => googleOAuthArguments({ origin, ...override }, start(), origin, 'start'));
    assert.throws(() => googleOAuthArguments({ ...input, ...override }, callback(), origin, 'callback'));
  }
  assert.throws(() => googleOAuthArguments({ ...input, code: 'other' }, callback(), origin, 'callback'));
  assert.throws(() => googleOAuthArguments({ ...input, redirectUri: 'https://foreign.example.test' }, callback(), origin, 'callback'));
});
test('store access follows committed authorization and escapes cannot reuse it', async () => {
  const f = fixture();
  const escaped = await withGoogleWorkspaceEntry(env, start(), 'start', async (call, issued) => {
    assert.equal(issued, state); await call.withStore({}, async () => undefined); return call;
  }, f.adapters);
  await assert.rejects(async () => escaped.withStore({}, async () => undefined));
  await withGoogleWorkspaceEntry(env, callback(), 'callback', call => call.withStore({}, async () => undefined), f.adapters);
  assert.deepEqual(f.calls.store, [workspace, workspace]); assert.equal(f.calls.close, 2);
  f.role('viewer');
  await assert.rejects(withGoogleWorkspaceEntry(env, callback(), 'callback', async () => assert.fail(), f.adapters));
  assert.equal(f.calls.close, 3); assert.deepEqual(f.calls.store, [workspace, workspace]);
});
test('unimplemented profiles and malformed proof deny before constructing custody', async () => {
  const f = fixture();
  for (const selected of [{}, { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, { ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo' }])
    await assert.rejects(withGoogleWorkspaceEntry(selected, start(), 'start', async () => assert.fail(), f.adapters));
  for (const request of [new Request(origin + GOOGLE_INTEGRATION_START), new Request(start().url, { method: 'POST', headers: { origin: 'https://foreign.example.test', 'x-noticeos-workspace-id': workspace } })])
    await assert.rejects(withGoogleWorkspaceEntry(env, request, 'start', async () => assert.fail(), f.adapters));
  assert.equal(f.calls.open, 0);
});


test('start session binding refuses before custody opening or committed store effects', async () => {
  const f = fixture();
  const missing = start(); missing.headers.delete(WORKSPACE_SESSION_HEADER);
  await assert.rejects(withGoogleWorkspaceEntry(env, missing, 'start', use => use.withStore({}, async () => assert.fail()), f.adapters));
  assert.equal(f.calls.open, 0);
  const stale = start(); stale.headers.set(WORKSPACE_SESSION_HEADER, randomUUID());
  await assert.rejects(withGoogleWorkspaceEntry(env, stale, 'start', use => use.withStore({}, async () => assert.fail()), f.adapters));
  assert.equal(f.calls.open, 1); assert.equal(f.calls.close, 1); assert.deepEqual(f.calls.store, []);
});
