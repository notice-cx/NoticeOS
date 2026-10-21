import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations, HostedTaskReceiptsUnavailable } from './hosted-task-operations.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { fakeTaskExecutor, memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/hosted-task-operations.mts: retry-safe writes over the
// shared fakes in test-fixtures/hosted-task-fakes.mjs, and reads in one
// executor session.

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
  await assert.rejects(f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'x', filedBy: OTHER } }, KEY));
  await assert.rejects(f.operations.write(proof(), A, create, 'short'));
  await assert.rejects(f.operations.write(proof(), A, { projectId: P, operation: { kind: 'respond', taskId: 'tt-1', response: 'yes' } }, KEY));
  assert.deepEqual(f.calls, []);
  await assert.rejects(fixture({ receipts: false }).operations.write(proof(), A, create, KEY), HostedTaskReceiptsUnavailable);
  // Without a key a write behaves as before: one effect, no receipt.
  const plain = fixture();
  assert.deepEqual(await plain.operations.write(proof(), A, create), { status: 'done', value: { id: 'tt-1', project: 'example' }, replayed: false });
  assert.equal(plain.store.rows.size, 0);
});

test('a new task records who filed it and with which model, with or without a key', async () => {
  const f = fixture();
  await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'Found work', model: 'Opus 5.5' } }, KEY);
  await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'Unkeyed, no model' } });
  const filed = id => [f.tasks.get(id).metadata.noticeos_filed_by, f.tasks.get(id).metadata.noticeos_filed_model];
  assert.deepEqual([filed('tt-1'), filed('tt-2')], [[PERSON, 'Opus 5.5'], [PERSON, undefined]]);
});

test('a card records the admitted actor and the time of the write, with or without a key, whatever the request said', async () => {
  const f = fixture();
  const card = { valuePerMonth: 400, likelihood: 0.4, reviewMinutes: 20, daysToSignal: 28, measurability: 'cohort',
    kill: { state: 'RPM below 12', date: '2026-12-31' } };
  const claimed = { ...card, by: 'someone else', at: '2020-01-01T00:00:00.000Z' };
  const request = { projectId: P, operation: { kind: 'create', title: 'Worth it', card: claimed, changeClass: 'copy' } };
  await f.operations.write(proof(), A, request, KEY);
  assert.deepEqual(f.tasks.get('tt-1').metadata.noticeos_card, { ...card, by: PERSON, at: '2026-10-07T12:00:00.000Z' });
  assert.equal(f.tasks.get('tt-1').metadata.noticeos_change_class, 'copy');
  // A retry with the same key and card replays: the stamp is not part of what the key names.
  f.advance(60_000);
  assert.equal((await f.operations.write(proof(), A, request, KEY)).replayed, true);
  assert.deepEqual(f.effects, [['create', 'tt-1']]);
  f.advance(60_000);
  await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'update', taskId: 'tt-1', card } });
  assert.deepEqual(f.tasks.get('tt-1').metadata.noticeos_card, { ...card, by: PERSON, at: '2026-10-07T12:02:00.000Z' });
  await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'update', taskId: 'tt-1', card: null } }, 'agent-retry-0002');
  assert.equal('noticeos_card' in f.tasks.get('tt-1').metadata, false);
});

test('a close records who closed it and with which model; the close stands if that record fails', async () => {
  const f = fixture();
  await f.operations.write(proof(), A, create, KEY);
  await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'update', taskId: 'tt-1', claim: true, model: 'Opus 5.5' } });
  assert.equal(f.tasks.get('tt-1').metadata.noticeos_claimed_model, 'Opus 5.5');
  const closed = await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'close', taskId: 'tt-1', reason: 'Done · abc1234', model: 'Opus 5.5' } }, 'agent-close-0001');
  assert.equal(closed.status, 'done');
  const { metadata, closed_at } = f.tasks.get('tt-1');
  assert.deepEqual([metadata.noticeos_closed_by, metadata.noticeos_closed_model, metadata.noticeos_closed_at], [PERSON, 'Opus 5.5', closed_at]);
  // A replayed close repeats nothing, the record included.
  assert.equal((await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'close', taskId: 'tt-1', reason: 'Done · abc1234', model: 'Opus 5.5' } }, 'agent-close-0001')).replayed, true);
  assert.deepEqual(f.attributions, [['tt-1', PERSON]]);

  await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'create', title: 'Second' } });
  f.fail('attribute');
  const unrecorded = await f.operations.write(proof(), A, { projectId: P, operation: { kind: 'close', taskId: 'tt-2', reason: 'Done' } });
  assert.equal(unrecorded.status, 'done');
  assert.equal(f.tasks.get('tt-2').status, 'closed');
  assert.equal(f.tasks.get('tt-2').metadata.noticeos_closed_by, undefined);
});

test('a close as done keeps the card as it stood, with the commit its reason names; another close keeps none, and the first ship stands', async () => {
  const f = fixture();
  const card = { valuePerMonth: 400, likelihood: 0.4, reviewMinutes: 20, daysToSignal: 28, measurability: 'cohort' };
  const write = (operation, key) => f.operations.write(proof(), A, { projectId: P, operation }, key);
  await write({ kind: 'create', title: 'Shorten the titles', card });
  const stored = f.tasks.get('tt-1').metadata.noticeos_card;
  f.advance(60_000);
  assert.equal((await write({ kind: 'close', taskId: 'tt-1', reason: 'Shipped · a1b2c3d · example.com/recipes' }, 'agent-close-0001')).status, 'done');
  const { metadata, closed_at } = f.tasks.get('tt-1');
  assert.deepEqual(metadata.noticeos_card_shipped, { card: stored, closedAt: closed_at, commit: 'a1b2c3d' });
  assert.equal(metadata.noticeos_resolution, 'done');

  // Reopened, its card changed by hand, and done again: the prediction it first shipped with stands.
  await write({ kind: 'update', taskId: 'tt-1', status: 'open' });
  f.tasks.get('tt-1').metadata.noticeos_card = { ...stored, valuePerMonth: 900 };
  f.advance(60_000);
  await write({ kind: 'close', taskId: 'tt-1', reason: 'Shipped again · e5f6a7b' }, 'agent-close-0002');
  assert.deepEqual(f.tasks.get('tt-1').metadata.noticeos_card_shipped, { card: stored, closedAt: closed_at, commit: 'a1b2c3d' });
  assert.notEqual(f.tasks.get('tt-1').metadata.noticeos_closed_at, closed_at, 'the closer is the later close\'s');

  // Nothing shipped: no card is kept.
  await write({ kind: 'create', title: 'Not worth it after all', card });
  await write({ kind: 'close', taskId: 'tt-2', reason: 'The pages are going away · a1b2c3d', resolution: 'wont-do' }, 'agent-close-0003');
  assert.equal(f.tasks.get('tt-2').metadata.noticeos_resolution, 'wont-do');
  assert.equal('noticeos_card_shipped' in f.tasks.get('tt-2').metadata, false);
  // Nor does a task without a card ship one.
  await write({ kind: 'create', title: 'Tidy up' });
  await write({ kind: 'close', taskId: 'tt-3', reason: 'Done · a1b2c3d' }, 'agent-close-0004');
  assert.equal('noticeos_card_shipped' in f.tasks.get('tt-3').metadata, false);
});

test('a closed-only read may ask for the Agents page history; the board keeps its week', async () => {
  const f = fixture();
  const history = await f.operations.board(proof(), A, P, ['closed'], 56);
  assert.equal(history.closedSince, '2026-08-12');
  assert.equal(history.epics, null);
  const read = f.calls.filter(call => call.operation.kind !== 'closed-board').map(call => call.operation.kind);
  assert.deepEqual(read, [], 'a closed-only read skips the ready list and the epics');
  assert.equal((await f.operations.board(proof(), A, P, ['open', 'closed'])).closedSince, '2026-09-30');
  await assert.rejects(async () => f.operations.board(proof(), A, P, ['closed'], 57));
  await assert.rejects(async () => f.operations.board(proof(), A, P, ['closed'], 0));
});

test('agent statistics read only active work and closed history and serialize aggregates', async () => {
  const f = fixture();
  const payload = await f.operations.agentStats(proof(), A);
  assert.equal(payload.projects, 1);
  assert.deepEqual(payload.broken, []);
  assert.deepEqual(f.calls.map(call => call.operation.kind), ['active-board', 'closed-board']);
  assert.deepEqual(f.calls[0].operation.statuses, ['in_progress', 'blocked']);
  assert.equal(f.calls[1].operation.since, '2026-08-12');
  assert.equal('tasks' in payload, false);
  assert.equal('events' in payload.stats, false);
  await assert.rejects(f.operations.agentStats(proof(), A, B));
});

test('MCP task lists retain readiness and rows without unused board enrichment', async () => {
  const f = fixture();
  const list = await f.operations.listTasks(proof(), A, P, ['open', 'in_progress', 'blocked', 'deferred', 'closed']);
  assert.deepEqual(f.calls.map(call => call.operation.kind), ['ready', 'active-board', 'closed-board']);
  assert.equal('actors' in list, false);
  assert.equal('epics' in list, false);
  assert.equal(Array.isArray(list.tasks), true);
  f.calls.length = 0;
  await f.operations.listTasks(proof(), A, P, ['closed']);
  assert.deepEqual(f.calls.map(call => call.operation.kind), ['closed-board']);
});

test('a board, task or history read runs its commands in one executor session where the executor offers one', async () => {
  const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
    membership: async (_headers, workspaceId) => ({ principalId: PERSON, sessionId: S,
      expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceId, role: 'operator', workspaceStatus: 'active' }) });
  const answers = {
    ready: [{ id: 'tt-1' }],
    'active-board': [{ id: 'tt-1', title: 'Open', status: 'open', priority: 2 }],
    'closed-board': [{ id: 'tt-2', title: 'Closed', status: 'closed', priority: 2, closed_at: new Date(Date.now() - 60000).toISOString() }],
    show: [{ id: 'tt-1', title: 'Open', status: 'open', priority: 2 }],
    comments: [], history: [],
  };
  const sessions = [];
  const executor = {
    execute: async () => assert.fail('A read goes through the session'),
    reads: async (_proof, workspaceId, projectId, work) => {
      const kinds = []; sessions.push({ workspaceId, projectId, kinds });
      return work(async operation => {
        kinds.push(operation.kind);
        if (operation.kind === 'epics') throw new Error('unavailable');
        return answers[operation.kind];
      });
    },
  };
  const operations = createHostedTaskOperations({ admission, executor,
    directory: { catalog: async () => Object.freeze([{ projectId: P, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]) } });
  const board = await operations.board(proof(), A, P, ['open', 'closed']);
  assert.deepEqual(board.tasks.map(row => [row.id, row.ready]), [['tt-1', true], ['tt-2', false]]);
  assert.equal(board.epics, null, 'A failed epic read inside the session stays unknown');
  assert.equal((await operations.task(proof(), A, P, 'tt-1')).task.id, 'tt-1');
  assert.deepEqual(await operations.history(proof(), A, P, 'tt-1', 5), []);
  assert.deepEqual(sessions, [
    { workspaceId: A, projectId: P, kinds: ['ready', 'active-board', 'closed-board', 'epics'] },
    { workspaceId: A, projectId: P, kinds: ['ready', 'show', 'comments'] },
    { workspaceId: A, projectId: P, kinds: ['history'] },
  ]);
  assert.throws(() => createHostedTaskOperations({ admission, executor: { ...executor, reads: 'not a function' },
    directory: { catalog: async () => [] } }));
});
