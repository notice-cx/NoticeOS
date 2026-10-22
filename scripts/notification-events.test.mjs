import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startNotificationEvents } from '../packages/postgres/src/notification-events.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';

const until = async (predicate, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < end, 'condition reached before timeout');
    await delay(20);
  }
};

test('event consumer batches committed wake-ups, follows durable retries and closes owned work', { timeout: 25000 }, async t => {
  let cluster, store, listener;
  const calls = [];
  let started = 0;
  try {
    try { cluster = await startTestCluster(); }
    catch (error) {
      const reason = unavailableReason(error);
      if (reason === null || process.env.NOTICEOS_REQUIRE_POSTGRES === '1') throw error;
      t.skip(reason); return;
    }
    const database = await cluster.createDatabase('noticeos_notification_events_dev');
    const connectionString = cluster.url(database);
    store = openWorkspaceStore(connectionString);
    const workspace = await store.workspaceId();
    await store.write(tx => tx.execute(`INSERT INTO noticeos.assets
      (workspace_id,asset_id,display_name,status) VALUES ($1::uuid,'event.example','Event fixture','live')`, [workspace]));
    listener = await startNotificationEvents({ connectionString,
      drain: async (kind, signal) => {
        assert.equal(signal.aborted, false);
        started++;
        const rows = await store.read(tx => tx.query(`SELECT event_id::text FROM noticeos.notification_outbox WHERE state='pending'`));
        calls.push({ kind, count: rows.length, at: Date.now() });
        if (kind === 'event' && rows.length) {
          await store.write(tx => tx.execute(`UPDATE noticeos.notification_outbox SET next_attempt_at=clock_timestamp()+interval '1.5 seconds' WHERE state='pending'`));
        } else if (rows.length) {
          await store.write(tx => tx.execute(`UPDATE noticeos.notification_outbox SET state='cancelled',finished_at=clock_timestamp() WHERE state='pending'`));
        }
        // A failed delivery persists its next deadline and reports no success.
        return kind !== 'event' && rows.length > 0;
      },
    });
    await until(() => calls.length === 1);
    assert.deepEqual(calls.map(call => [call.kind, call.count]), [['recovery', 0]]);
    await store.write(async tx => {
      for (const rule of ['one', 'two']) await tx.execute(`INSERT INTO noticeos.flags
        (workspace_id,asset_id,fired_at,severity,kind,message,rule_id)
        VALUES($1::uuid,'event.example',clock_timestamp(),'error','anomaly','Synthetic event',$2)`, [workspace, rule]);
    });
    await until(() => calls.length >= 3);
    assert.deepEqual(calls.slice(1).map(call => [call.kind, call.count]), [['event', 2], ['recovery', 2]]);
    assert.ok(calls[2].at - calls[1].at >= 1400, 'retry deadline is honored');
    await until(async () => (await store.read(tx => tx.query(`SELECT 1 FROM noticeos.notification_outbox WHERE state = 'pending'`))).length === 0);

    const beforeReconnect = calls.length;
    await cluster.asOwner(database, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name = 'noticeos-notification-events' AND datname = current_database()`);
    await store.write(tx => tx.execute(`INSERT INTO noticeos.flags
      (workspace_id,asset_id,fired_at,severity,kind,message,rule_id)
      VALUES($1::uuid,'event.example',clock_timestamp(),'error','anomaly','Queued during disconnect','reconnect')`, [workspace]));
    await until(() => calls.length > beforeReconnect);
    assert.deepEqual(calls.at(-1) && [calls.at(-1).kind, calls.at(-1).count], ['recovery', 1],
      'reconnection recovers durable work whose wake-up was missed');
    await listener.close(); listener = null;
    const before = started;
    await store.write(tx => tx.query("SELECT pg_notify('noticeos_notifications','')"));
    await delay(1100);
    assert.equal(started, before, 'closed listener consumes no more events');

    let aborted = false;
    listener = await startNotificationEvents({ connectionString, drain: async (_kind, signal) => {
      started++;
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return false;
    } });
    await until(() => started > before);
    await listener.close(); listener = null;
    assert.equal(aborted, true, 'closing cancels and awaits in-flight work');
  } finally { await listener?.close(); await store?.close(); cluster?.close(); }
});
