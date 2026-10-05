import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { recordMutation } from '../packages/postgres/src/mutation-audit.mjs';

const workspaceId = randomUUID();
const actor = Object.freeze({ workspaceId, principalId: randomUUID(), sessionId: randomUUID() });
function fixture() {
  const calls = [];
  return { calls, tx: { workspaceId, async execute(sql, values) { calls.push({ sql, values }); return 1; } } };
}
test('audit snapshots person and whitelisted event data before I/O', async () => {
  const { calls, tx } = fixture();
  const selected = { ...actor }, subject = { column: 'display_name' };
  const writing = recordMutation(tx, selected, { event: 'asset.column', assetId: 'example.test', subject });
  selected.principalId = randomUUID(); subject.column = 'status';
  await writing;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [workspaceId, 'person', actor.principalId, actor.sessionId,
    'asset.column', 'example.test', '{"column":"display_name"}']);
});
test('unknown standalone actor stays null and has no claimed person fallback', async () => {
  const { calls, tx } = fixture();
  await recordMutation(tx, null, { event: 'asset.create', assetId: 'example.test', subject: {} });
  assert.deepEqual(calls[0].values.slice(0, 4), [workspaceId, 'unknown', null, null]);
});
test('flag evidence adds no identifier limit to existing valid asset rows', async () => {
  const { calls, tx } = fixture();
  const assetId = 'generated-' + 'a'.repeat(180);
  await recordMutation(tx, actor, { event: 'flag.resolve', assetId, subject: { flagNumber: 2, changedCount: 1 } });
  assert.equal(calls[0].values[5], assetId);
  assert.equal(calls[0].values[6], '{"flagNumber":2,"changedCount":1}');
});
test('malformed actor and secret-bearing or forged metadata refuse before SQL', async () => {
  const { calls, tx } = fixture();
  const valid = { event: 'asset.column', assetId: 'example.test', subject: { column: 'status' } };
  for (const wrong of [{ ...actor, workspaceId: randomUUID() }, { ...actor, sessionId: null },
    { ...actor, actor: 'claimed' }, { ...actor, principalId: 'caller-controlled' }]) {
    await assert.rejects(recordMutation(tx, wrong, valid), /facts are invalid/);
  }
  let reads = 0;
  const accessor = { workspaceId, principalId: actor.principalId, get sessionId() { reads++; return actor.sessionId; } };
  await assert.rejects(recordMutation(tx, accessor, valid), /facts are invalid/);
  const malformed = [
    { ...valid, subject: { column: 'display_name', value: 'generated private note' } },
    { ...valid, subject: { column: 'status', note: 'generated private note' } },
    { ...valid, subject: JSON.parse('{"column":"status","__proto__":{}}') },
    { ...valid, event: 'credentials.write' },
    { event: 'decision.set', assetId: 'example.test', subject: { kind: 'finding', key: 'k', status: 'marked', note: 'private' } },
    { event: 'annotation.create', assetId: 'example.test', subject: { annotationNumber: '1', kind: 'deploy', ref: 'private' } },
    { event: 'flag.resolve', assetId: 'example.test', subject: { flagNumber: 1, changedCount: 0 } },
    { event: 'flag.resolve', assetId: 'example.test', subject: { flagNumber: 1, changedCount: 1, metric: 'private' } },
  ];
  for (const wrong of malformed) await assert.rejects(recordMutation(tx, actor, wrong), /facts are invalid/);
  assert.equal(reads, 0); assert.equal(calls.length, 0);
});
