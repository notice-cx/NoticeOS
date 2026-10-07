import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findPostgres } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import {
  finishTaskReceipt, interruptTaskReceipt, retryTaskReceipt, startTaskReceipt, TaskReceiptRefused,
} from '../packages/postgres/src/task-receipts.mjs';

// Migration 0012 and packages/postgres/src/task-receipts.mts (epic ro-cvl9):
// one receipt per (workspace, principal, operation, key), bound to its request;
// every transition a compare-and-set on the attempt; workspaces isolated.

const hash = letter => letter.repeat(64);

test('task operation receipts bind a key to one request and move by compare-and-set only', { timeout: 90000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-task-receipts-'));
  let owner, store, primaryError;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    // An existing store from before 0012 keeps its rows; 0012 only adds.
    const older = path.join(root, 'older'); mkdirSync(older);
    for (const name of readdirSync(path.join(REPO_ROOT, 'db/postgres/migrations')).filter(name => !name.startsWith('0012_'))) {
      copyFileSync(path.join(REPO_ROOT, 'db/postgres/migrations', name), path.join(older, name));
    }
    applyMigrations(owner, { dir: older });
    const a = randomUUID(), b = randomUUID();
    for (const [id, slug] of [[a, 'first'], [b, 'second']]) {
      owner.sql(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES('${id}','${slug}','${slug}','active')`);
    }
    assert.deepEqual(applyMigrations(owner).applied, ['0012_task_operation_receipts']);
    store = openStore(owner.applicationLogin().url());

    const project = randomUUID(), principal = randomUUID();
    const request = { principalId: principal, operation: 'comment', idempotencyKey: 'agent-retry-0001', projectId: project, requestHash: hash('a') };
    const first = randomUUID();
    const started = await store.inWorkspace(a, tx => startTaskReceipt(tx, request, first));
    assert.equal(started.kind, 'started');
    assert.deepEqual([started.receipt.operationId, started.receipt.state, started.receipt.attempt, started.receipt.result],
      [first, 'pending', 1, null]);

    // The same key and request returns the receipt; a new operation id is ignored.
    const again = await store.inWorkspace(a, tx => startTaskReceipt(tx, request, randomUUID()));
    assert.deepEqual([again.kind, again.receipt.operationId, again.receipt.state], ['existing', first, 'pending']);
    // Reused with other content or another project, the key conflicts.
    assert.deepEqual(await store.inWorkspace(a, tx => startTaskReceipt(tx, { ...request, requestHash: hash('b') }, randomUUID())), { kind: 'conflict' });
    assert.deepEqual(await store.inWorkspace(a, tx => startTaskReceipt(tx, { ...request, projectId: randomUUID() }, randomUUID())), { kind: 'conflict' });
    // The key is scoped: another principal, operation or workspace starts its own.
    for (const [workspace, scoped] of [[a, { ...request, principalId: randomUUID() }], [a, { ...request, operation: 'close' }], [b, request]]) {
      assert.equal((await store.inWorkspace(workspace, tx => startTaskReceipt(tx, scoped, randomUUID()))).kind, 'started');
    }

    // Only the current attempt can be interrupted, retried or finished, once.
    const identity = { principalId: principal, operation: 'comment', idempotencyKey: 'agent-retry-0001' };
    assert.equal(await store.inWorkspace(a, tx => interruptTaskReceipt(tx, identity, { operationId: first, attempt: 2 })), false);
    assert.equal(await store.inWorkspace(a, tx => interruptTaskReceipt(tx, identity, { operationId: first, attempt: 1 })), true);
    assert.equal(await store.inWorkspace(a, tx => interruptTaskReceipt(tx, identity, { operationId: first, attempt: 1 })), false);
    const interrupted = (await store.inWorkspace(a, tx => startTaskReceipt(tx, request, randomUUID()))).receipt;
    assert.equal(interrupted.state, 'interrupted'); assert.ok(interrupted.finishedAt);
    const retries = await Promise.all([1, 2].map(() =>
      store.inWorkspace(a, tx => retryTaskReceipt(tx, identity, { operationId: first, attempt: 1, state: 'interrupted' }))));
    assert.equal(retries.filter(Boolean).length, 1, 'two retriers of one interrupted attempt: one starts it');
    const second = retries.find(Boolean);
    assert.deepEqual([second.state, second.attempt, second.finishedAt], ['pending', 2, null]);
    assert.equal(await store.inWorkspace(a, tx => finishTaskReceipt(tx, identity, { operationId: first, attempt: 1 }, { id: 'old' })), false);
    assert.equal(await store.inWorkspace(a, tx => finishTaskReceipt(tx, identity, { operationId: first, attempt: 2 }, { id: 'task-1', n: 1 })), true);
    assert.equal(await store.inWorkspace(a, tx => finishTaskReceipt(tx, identity, { operationId: first, attempt: 2 }, { id: 'again' })), false);
    const done = (await store.inWorkspace(a, tx => startTaskReceipt(tx, request, randomUUID()))).receipt;
    assert.deepEqual([done.state, done.attempt, done.result], ['succeeded', 2, { id: 'task-1', n: 1 }]);
    assert.equal(await store.inWorkspace(a, tx => retryTaskReceipt(tx, identity, { operationId: first, attempt: 2, state: 'pending' })), null,
      'a succeeded receipt never starts again');

    // Attempts are bounded.
    const bounded = { ...request, idempotencyKey: 'agent-retry-0002' }, boundedId = randomUUID();
    const boundedIdentity = { ...identity, idempotencyKey: 'agent-retry-0002' };
    await store.inWorkspace(a, tx => startTaskReceipt(tx, bounded, boundedId));
    for (let attempt = 1; attempt < 5; attempt++) {
      assert.ok(await store.inWorkspace(a, tx => retryTaskReceipt(tx, boundedIdentity, { operationId: boundedId, attempt, state: 'pending' })));
    }
    assert.equal(await store.inWorkspace(a, tx => retryTaskReceipt(tx, boundedIdentity, { operationId: boundedId, attempt: 5, state: 'pending' })), null);

    // Malformed facts refuse before any statement; outcomes are bounded.
    for (const malformed of [{ ...request, idempotencyKey: 'short' }, { ...request, operation: 'respond' },
      { ...request, principalId: '' }, { ...request, requestHash: 'x' }, { ...request, projectId: 'p' }]) {
      await assert.rejects(store.inWorkspace(a, tx => startTaskReceipt(tx, malformed, randomUUID())), TaskReceiptRefused);
    }
    await assert.rejects(store.inWorkspace(a, tx => finishTaskReceipt(tx, boundedIdentity, { operationId: boundedId, attempt: 5 },
      { text: 'x'.repeat(70000) })), TaskReceiptRefused);

    // The application role sees and changes only its own workspace's receipts,
    // and never deletes one or edits a bound column.
    const counts = await Promise.all([a, b].map(id => store.inWorkspace(id, tx =>
      tx.query('SELECT count(*)::int AS n FROM noticeos.task_operation_receipts'))));
    assert.deepEqual(counts.map(([row]) => row.n), [4, 1]);
    await assert.rejects(store.inWorkspace(a, tx => tx.execute('DELETE FROM noticeos.task_operation_receipts')), /permission denied/u);
    await assert.rejects(store.inWorkspace(a, tx => tx.execute("UPDATE noticeos.task_operation_receipts SET request_hash=repeat('d',64)")), /permission denied/u);
  } catch (error) { primaryError = error; throw error; } finally {
    const failures = [];
    for (const cleanup of [() => store?.close(), () => owner?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (existsSync(path.join(root, 'pg/data/postmaster.pid'))) failures.push(new Error('Owned Postgres PID marker remains'));
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, 'Task receipt fixture retirement refused');
    rmSync(root, { recursive: true });
  }
});
