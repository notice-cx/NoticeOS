import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';

const { Client } = createRequire(new URL('../packages/postgres/package.json', import.meta.url))('pg');
const AT = '2026-10-21T19:00:00.000Z';

test('notification intent is atomic, episode-scoped and wakes consumers only after commit', async t => {
  let cluster, store, listener;
  try {
    try { cluster = await startTestCluster(); }
    catch (error) {
      const reason = unavailableReason(error);
      if (reason === null || process.env.NOTICEOS_REQUIRE_POSTGRES === '1') throw error;
      t.skip(reason); return;
    }
    const database = await cluster.createDatabase('noticeos_notification_outbox_dev');
    const url = cluster.url(database);
    store = openWorkspaceStore(url);
    const workspace = await store.workspaceId();
    await store.write(tx => tx.execute(`INSERT INTO noticeos.assets
      (workspace_id, asset_id, display_name, status) VALUES ($1::uuid, 'outbox.example', 'Outbox', 'live')`, [workspace]));
    const rows = () => store.read(tx => tx.query(`SELECT subject, subject_ref, occurrence, connection_id::text,
      occurred_at FROM noticeos.notification_outbox ORDER BY subject, occurred_at`));
    const insertFlag = (tx, severity, rule) => tx.query(`INSERT INTO noticeos.flags
      (workspace_id, asset_id, fired_at, severity, kind, metric, message, rule_id)
      VALUES ($1::uuid, 'outbox.example', $2::timestamptz, $3, 'anomaly', 'pulse', 'Synthetic condition', $4)
      RETURNING flag_id, flag_number`, [workspace, AT, severity, rule]);

    await t.test('rollback removes both the source and its intent; commit emits a data-free wake-up', async () => {
      listener = new Client({ connectionString: url });
      await listener.connect();
      await listener.query('LISTEN noticeos_notifications');
      const notifications = [];
      listener.on('notification', message => notifications.push(message));
      const failed = new Error('synthetic source rollback');
      await assert.rejects(store.write(async tx => { await insertFlag(tx, 'error', 'rollback'); throw failed; }), error => error === failed);
      assert.deepEqual(await rows(), []);
      const notified = once(listener, 'notification', { signal: AbortSignal.timeout(2000) });
      const [flag] = await store.write(tx => insertFlag(tx, 'error', 'committed'));
      await notified;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].channel, 'noticeos_notifications');
      assert.equal(notifications[0].payload, '');
      assert.deepEqual((await rows()).map(row => [row.subject, row.subject_ref]), [['alert', String(flag.flag_number)]]);
      await listener.end(); listener = null;
    });

    await t.test('an error reading of a warning enqueues the alert once', async () => {
      const [flag] = await store.write(tx => insertFlag(tx, 'warn', 'escalated'));
      const before = (await rows()).length;
      const reading = at => store.write(tx => tx.execute(`INSERT INTO noticeos.flag_evidence
        (workspace_id, flag_id, observed_at, severity, message) VALUES ($1::uuid, $2, $3::timestamptz, 'error', 'Escalated')`,
      [workspace, flag.flag_id, at]));
      await reading('2026-10-21T19:01:00.000Z');
      await reading('2026-10-21T19:02:00.000Z');
      const after = await rows();
      assert.equal(after.length, before + 1);
      assert.equal(after.find(row => row.subject_ref === String(flag.flag_number)).occurred_at, '2026-10-21T19:01:00.000000Z');
    });

    await t.test('a connection emits one event per failure episode and excludes Discord', async () => {
      await store.write(tx => tx.execute(`INSERT INTO noticeos.integration_connections
        (workspace_id, provider, scope, created_at, updated_at) VALUES
        ($1::uuid, 'google', 'shared', $2::timestamptz, $2::timestamptz),
        ($1::uuid, 'discord', 'shared', $2::timestamptz, $2::timestamptz)`, [workspace, AT]));
      const failure = at => store.write(tx => tx.execute(`UPDATE noticeos.integration_connections
        SET last_used_at = $1::timestamptz, last_error = 'Synthetic provider failure'`, [at]));
      await failure('2026-10-21T19:03:00.000Z');
      await failure('2026-10-21T19:04:00.000Z');
      assert.deepEqual((await rows()).filter(row => row.subject === 'data-source').map(row => row.subject_ref), ['google']);
      await store.write(tx => tx.execute(`UPDATE noticeos.integration_connections
        SET last_error = NULL, last_ok_at = '2026-10-21T19:05:00Z' WHERE provider = 'google'`));
      await failure('2026-10-21T19:06:00.000Z');
      const episodes = (await rows()).filter(row => row.subject === 'data-source');
      assert.deepEqual(episodes.map(row => row.subject_ref), ['google', 'google']);
      assert.notEqual(episodes[0].occurrence, episodes[1].occurrence);
      assert.equal(episodes[0].connection_id, episodes[1].connection_id);

      // A newer success wins over stale error text and a late failed outcome.
      await store.write(tx => tx.execute(`UPDATE noticeos.integration_connections
        SET last_ok_at = '2026-10-21T19:10:00Z' WHERE provider = 'google'`));
      await store.write(tx => tx.execute(`UPDATE noticeos.integration_connections
        SET last_used_at = '2026-10-21T19:09:00Z', last_error = 'Older failed outcome' WHERE provider = 'google'`));
      assert.equal((await rows()).filter(row => row.subject === 'data-source').length, 2);
      // The next genuinely newer failure starts a new episode, even when the
      // stored error sentence itself is unchanged.
      await store.write(tx => tx.execute(`UPDATE noticeos.integration_connections
        SET last_used_at = '2026-10-21T19:11:00Z' WHERE provider = 'google'`));
      assert.equal((await rows()).filter(row => row.subject === 'data-source').length, 3);
    });

    await t.test('sparse due reads use the pending index beside terminal history', async proof => {
      const began = performance.now();
      await store.write(tx => tx.execute(`INSERT INTO noticeos.notification_outbox
        (workspace_id, subject, subject_ref, occurrence, occurred_at, next_attempt_at, state, finished_at)
        SELECT $1::uuid, 'alert', 'history-' || i, '', $2::timestamptz, $2::timestamptz, 'sent', $2::timestamptz
          FROM generate_series(1, 5000) i`, [workspace, AT]));
      await store.write(tx => tx.execute(`INSERT INTO noticeos.notification_outbox
        (workspace_id, subject, subject_ref, occurrence, occurred_at, next_attempt_at)
        SELECT $1::uuid, 'alert', 'due-' || i, '', $2::timestamptz,
               $2::timestamptz + CASE WHEN i <= 3 THEN interval '0 seconds' ELSE interval '1 day' END
          FROM generate_series(1, 6) i`, [workspace, AT]));
      const seedMs = performance.now() - began;
      await cluster.asOwner(database, 'ANALYZE noticeos.notification_outbox');
      const [explained] = await store.write(tx => tx.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT event_id FROM noticeos.notification_outbox WHERE state = 'pending'
          AND next_attempt_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
        ORDER BY next_attempt_at, event_id FOR UPDATE SKIP LOCKED LIMIT 10`, [AT]));
      const plan = JSON.parse(explained['QUERY PLAN'])[0];
      const descendants = node => [node, ...(node.Plans ?? []).flatMap(descendants)];
      const indexed = descendants(plan.Plan).find(node => node['Index Name'] === 'notification_outbox_due');
      assert.ok(indexed, 'the application due read uses the pending-only index');
      assert.match(indexed['Index Cond'], /workspace_id/);
      assert.match(indexed['Index Cond'], /next_attempt_at/);
      const [sizes] = await cluster.asOwner(database, `SELECT pg_relation_size('noticeos.notification_outbox_due')::text AS index_bytes,
        pg_total_relation_size('noticeos.notification_outbox')::text AS total_bytes`);
      proof.diagnostic(JSON.stringify({ terminalRows: 5000, addedPendingRows: 6, seedMs: Number(seedMs.toFixed(2)),
        indexBytes: Number(sizes.index_bytes), tableAndIndexesBytes: Number(sizes.total_bytes),
        dueRowsRead: indexed['Actual Rows'], executionMs: plan['Execution Time'] }));
    });
  } finally {
    await listener?.end();
    await store?.close();
    cluster?.close();
  }
});
