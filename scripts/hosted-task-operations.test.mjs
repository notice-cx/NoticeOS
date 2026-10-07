import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations, HostedTaskReceiptsUnavailable } from './hosted-task-operations.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { fakeTaskExecutor, memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/hosted-task-operations.mts (epic ro-cvl9): retry-safe writes over the
// shared fakes in test-fixtures/hosted-task-fakes.mjs.

const [A, B, P, S, PERSON, OTHER] = ['11111111', '22222222', '33333333', '44444444', '55555555', '66666666']
  .map(prefix => `${prefix}-1111-4111-8111-111111111111`);
const origin = 'https://tower.example.test';
const KEY = 'agent-retry-0001';

function proof(workspace = A) {
  return new Request(origin + '/api/tasks/mcp', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin',
    [WORKSPACE_SELECTION_HEADER]: workspace, [WORKSPACE_SESSION_HEADER]: S } });
}
function fixture({ receipts = true } = {}) {
  let time = Date.parse('2026-10-07T12:00:00.000Z'), principal = PERSON;
  const clock = () => time;
  const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
    membership: async (_headers, workspaceId) => ({ principalId: principal, sessionId: S,
      expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceId, role: 'operator', workspaceStatus: 'active' }) });
  const fake = fakeTaskExecutor({ principal: () => principal, clock });
  const store = receipts ? memoryReceipts(clock) : undefined;
  const operations = createHostedTaskOperations({ admission, executor: fake.executor, now: clock,
    directory: { catalog: async () => Object.freeze([{ projectId: P, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]) },
    ...(store ? { receipts: store } : {}) });
  return { ...fake, operations, store, advance: ms => { time += ms; }, as: id => { principal = id; } };
}
const create = { projectId: P, operation: { kind: 'create', title: 'Investigate the drop' } };
const comment = { projectId: P, operation: { kind: 'comment', taskId: 'tt-1', text: 'Found the cause' } };

test('a retried write returns the recorded outcome without repeating the effect', async () => {
  const f = fixture();
  const first = await f.operations.write(proof(), A, create, KEY);
  assert.deepEqual(first, { status: 'done', value: { id: 'tt-1', project: 'example' }, replayed: false });
  assert.deepEqual(await f.operations.write(proof(), A, create, KEY), { status: 'done', value: { id: 'tt-1', project: 'example' }, replayed: true });
  assert.deepEqual(f.effects, [['create', 'tt-1']]);
  assert.equal(f.tasks.get('tt-1').metadata.noticeos_operation_id, [...f.store.rows.values()][0].operationId,
    'the created task carries the server operation identity');
  // Reused with other content, the key conflicts and nothing runs.
  const calls = f.calls.length;
  assert.deepEqual(await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'Other' } }, KEY), { status: 'conflict' });
  assert.equal(f.calls.length, calls);
  // The key belongs to the admitted principal, workspace and operation.
  f.as(OTHER);
  assert.equal((await f.operations.write(proof(), A, create, KEY)).replayed, false);
  f.as(PERSON);
  assert.equal((await f.operations.write(proof(B), B, create, KEY)).replayed, false);
  assert.deepEqual(f.effects.map(([kind]) => kind), ['create', 'create', 'create']);
});

test('a lost reply after a create or comment is found by its evidence, not repeated', async () => {
  const f = fixture();
  f.fail('after');
  await assert.rejects(f.operations.write(proof(), A, create, KEY));
  assert.equal([...f.store.rows.values()][0].state, 'interrupted');
  assert.deepEqual(await f.operations.write(proof(), A, create, KEY), { status: 'done', value: { id: 'tt-1', project: 'example' }, replayed: true });
  f.fail('after');
  await assert.rejects(f.operations.write(proof(), A, comment, KEY));
  const replay = await f.operations.write(proof(), A, comment, KEY);
  assert.deepEqual([replay.status, replay.replayed, replay.value.id], ['done', true, 'c-1']);
  assert.deepEqual(f.effects, [['create', 'tt-1'], ['comment', 'c-1']]);
});

test('an attempt that failed before its effect runs once more, and only once', async () => {
  const f = fixture();
  f.fail('before');
  await assert.rejects(f.operations.write(proof(), A, comment, KEY));
  const retries = await Promise.all([1, 2].map(() => f.operations.write(proof(), A, comment, KEY)));
  assert.deepEqual(retries.map(outcome => outcome.status).sort(), ['done', 'pending']);
  assert.deepEqual(f.effects, [['comment', 'c-1']]);
  assert.equal([...f.store.rows.values()][0].attempt, 2);
});

test('an attempt still running answers pending; an abandoned one is reconciled after the window', async () => {
  const f = fixture();
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const running = f.operations.write(proof(), A, comment, KEY);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await f.operations.write(proof(), A, comment, KEY), { status: 'pending' });
  release(); f.hold(null);
  assert.equal((await running).replayed, false);
  assert.equal((await f.operations.write(proof(), A, comment, KEY)).replayed, true);

  // A process that died mid-attempt leaves its receipt pending: still pending
  // inside the window, then checked against evidence and run again if absent.
  const g = fixture();
  const update = { projectId: P, operation: { kind: 'update', taskId: 'tt-1', claim: true } };
  await g.store.start(A, { principalId: PERSON, operation: 'update', idempotencyKey: KEY, projectId: P,
    requestHash: await requestHashOf(g, update) }, '77777777-1111-4111-8111-111111111111');
  assert.deepEqual(await g.operations.write(proof(), A, update, KEY), { status: 'pending' });
  g.advance(5 * 60_000);
  const outcome = await g.operations.write(proof(), A, update, KEY);
  assert.deepEqual([outcome.status, outcome.replayed], ['done', false]);
  assert.deepEqual(g.effects, [['update', 'tt-1']]);
});

// The hash is the operations module's own; read it back from a first write.
async function requestHashOf(f, request) {
  const probe = fixture();
  await probe.operations.write(proof(), A, request, 'hash-probe-0001');
  return [...probe.store.rows.values()][0].requestHash;
}

test('keys and operation identities are the server’s, never a caller’s', async () => {
  const f = fixture();
  await assert.rejects(f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'x',
    operationId: '77777777-1111-4111-8111-111111111111' } }, KEY));
  await assert.rejects(f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'x',
    metadata: { noticeos_operation_id: '77777777-1111-4111-8111-111111111111' } } }, KEY));
  await assert.rejects(f.operations.write(proof(), A, create, 'short'));
  await assert.rejects(f.operations.write(proof(), A, { projectId: P, operation: { kind: 'respond', taskId: 'tt-1', response: 'yes' } }, KEY));
  assert.deepEqual(f.calls, []);
  await assert.rejects(fixture({ receipts: false }).operations.write(proof(), A, create, KEY), HostedTaskReceiptsUnavailable);
  // Without a key a write behaves as before: one effect, no receipt.
  const plain = fixture();
  assert.deepEqual(await plain.operations.write(proof(), A, create), { status: 'done', value: { id: 'tt-1', project: 'example' }, replayed: false });
  assert.equal(plain.store.rows.size, 0);
});
