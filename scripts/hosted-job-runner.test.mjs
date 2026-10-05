import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { findPostgres, PostgresUnavailable, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createHostedJobRunner } from './hosted-job-runner.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const latch = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const definition = (steps, over = {}) => ({ key: 'synthetic', version: 'v1', parseInput: value => value, steps, ...over });
const database = (key, run) => ({ key, kind: 'database', action: 'assets.write', run });
const effect = (key, run) => ({ key, kind: 'effect', action: 'tasks.write', run });

test('close awaits every resource even when one closer throws', async () => {
  const entered = latch(), release = latch(); let settled = false, closed = false;
  const runner = createHostedJobRunner({ workspaceId: randomUUID(), serviceId: randomUUID(), definitions: [],
    store: { close() { throw new Error('private close failure'); } },
    grant: { async close() { entered.release(); await release.promise; closed = true; } },
  });
  const closing = runner.close(); void closing.then(() => { settled = true; }, () => { settled = true; });
  try { await entered.promise; assert.equal(settled, false); }
  finally { release.release(); }
  await assert.rejects(closing, { name: 'HostedJobRefused' }); assert.ok(closed);
});

test('hosted occurrences preserve workspace authority, atomic steps and uncertain effects', { timeout: 90000 }, async t => {
  let tools;
  try { tools = findPostgres(); } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') return t.skip(error.message);
    throw error;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-jobs-'));
  let owner, admin, closeAdmin; const runners = [], stores = [], pending = [], barriers = [];
  try {
    owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
    applyMigrations(owner);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    closeAdmin = trackFixturePool(admin);
    const appUrl = owner.applicationLogin().url();
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_service_grant LOGIN');
    await admin.query(`ALTER ROLE noticeos_service_grant PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_service_grant 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const serviceUrl = new URL(appUrl); serviceUrl.username = 'noticeos_service_grant'; serviceUrl.password = password;
    const workspaces = [randomUUID(), randomUUID(), randomUUID()], services = workspaces.map(() => randomUUID());
    for (const [i, id] of workspaces.entries()) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, `generated-${i}`]);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'example.test','example.test','Generated asset','live',1)", [id]);
      await admin.query("INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [services[i], id, ['workflows.run', 'assets.write', 'tasks.write']]);
    }
    const store = index => { const s = openWorkspaceStore(appUrl, { workspaceId: workspaces[index] }); stores.push(s); return s; };
    const make = (index, def, over = {}) => {
      const r = createHostedJobRunner({ workspaceId: workspaces[index], serviceId: services[index],
        grant: openWorkspaceServiceGrant({ connectionString: serviceUrl.href, principalId: services[index], workspaceId: workspaces[index] }),
        store: store(index), definitions: [def], ...over }); runners.push(r); return r;
    };
    const count = async (index, metric) => Number((await admin.query('SELECT value FROM noticeos.counter_readings WHERE workspace_id=$1 AND metric=$2', [workspaces[index], metric])).rows[0]?.value ?? 0);
    const bump = async (tx, metric) => tx.execute(`INSERT INTO noticeos.counter_readings(workspace_id,asset_id,metric,value,observed_at)
      VALUES($1::uuid,'example.test',$2,1,now()) ON CONFLICT(workspace_id,asset_id,metric)
      DO UPDATE SET value=noticeos.counter_readings.value+1`, [tx.workspaceId, metric]);
    const controlled = () => { const b = latch(); barriers.push(b); return b; };
    const own = promise => { pending.push(promise); void promise.catch(() => undefined); return promise; };

    await t.test('two customers and a simulator use identical occurrence names without sharing outputs or writes', async () => {
      const rs = workspaces.map((_, i) => make(i, definition([database('record', async ({ context, input }, tx) => {
        assert.equal(context.workspaceId, workspaces[i]); assert.equal(context.principalId, services[i]);
        assert.equal(input.n, i + 1); await bump(tx, 'isolation'); return { written: i + 1, access_token: 'generated-private-secret' };
      })])));
      const out = await Promise.all(rs.map((r, i) => r.run('synthetic', 'same-occurrence', { n: i + 1, token: 'private-input-proof' })));
      assert.ok(out.every(r => r.state === 'succeeded' && r.attempt === 1));
      for (const [i, result] of out.entries()) {
        assert.equal(result.steps.record.output.metrics[0].value, i + 1); assert.equal(await count(i, 'isolation'), 1);
        const rows = await store(i).read(tx => tx.query('SELECT workspace_id::text,steps::text FROM noticeos.hosted_job_occurrences'));
        assert.equal(rows.length, 1); assert.equal(rows[0].workspace_id, workspaces[i]);
      }
      const persisted = JSON.stringify((await admin.query('SELECT row_to_json(j)::text FROM noticeos.hosted_job_occurrences j')).rows);
      assert.ok(!persisted.includes('private-input-proof')); assert.ok(!persisted.includes('generated-private-secret'));
    });
    await t.test('concurrent instances cannot repeat one outside action', async () => {
      const entered = controlled(), release = controlled(); let effects = 0;
      const def = definition([effect('deliver', async () => { effects++; entered.release(); await release.promise; return { sent: 1 }; })]);
      const a = make(0, def), b = make(0, def);
      const first = own(a.run('synthetic', 'concurrent', null)); await entered.promise;
      const second = await b.run('synthetic', 'concurrent', null); assert.equal(second.state, 'busy'); assert.equal(effects, 1);
      release.release(); assert.equal((await first).state, 'succeeded');
      assert.equal((await b.run('synthetic', 'concurrent', null)).state, 'succeeded'); assert.equal(effects, 1);
    });
    await t.test('input, registry version, service and physical store mismatches refuse old work', async () => {
      const def = definition([database('record', async () => ({ written: 1 }))]);
      const original = make(0, def); await original.run('synthetic', 'immutable', { x: 1, y: 2 });
      assert.equal((await original.run('synthetic', 'immutable', { y: 2, x: 1 })).state, 'succeeded');
      await assert.rejects(original.run('synthetic', 'immutable', { x: 2 }), { name: 'HostedJobRefused' });
      await assert.rejects(make(0, { ...def, version: 'v2' }).run('synthetic', 'immutable', { x: 1, y: 2 }), { name: 'HostedJobRefused' });
      await assert.rejects(make(0, def, { store: store(1) }).run('synthetic', 'wrong-store', null));
      await assert.rejects(make(0, def, { serviceId: services[1] }).run('synthetic', 'wrong-service', null));
      assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos.hosted_job_occurrences WHERE occurrence IN ('wrong-store','wrong-service')")).rows[0].n, 0);
    });
    await t.test('database failure rolls back its effect; retry keeps prior committed checkpoints', async () => {
      let failed = false, firstCalls = 0;
      const r = make(0, definition([
        database('first', async (_, tx) => { firstCalls++; await bump(tx, 'first'); return { written: 1 }; }),
        database('second', async (_, tx) => { await bump(tx, 'second'); if (!failed) { failed = true; throw new Error('private failure'); } return { written: 1 }; }),
      ]));
      assert.equal((await r.run('synthetic', 'retry-db', null)).state, 'retryable');
      assert.equal(await count(0, 'first'), 1); assert.equal(await count(0, 'second'), 0);
      const finished = await r.run('synthetic', 'retry-db', null);
      assert.equal(finished.state, 'succeeded'); assert.equal(finished.attempt, 2); assert.equal(firstCalls, 1);
      assert.equal(await count(0, 'first'), 1); assert.equal(await count(0, 'second'), 1);
      const attempts = (await admin.query("SELECT state FROM noticeos.hosted_job_attempts WHERE occurrence='retry-db' ORDER BY attempt")).rows;
      assert.deepEqual(attempts.map(r => r.state), ['retryable', 'succeeded']);
    });
    await t.test('outside failure is uncertain and cannot be blindly retried', async () => {
      let calls = 0; const r = make(0, definition([effect('send', async () => { calls++; throw new Error('secret provider body'); })]));
      assert.equal((await r.run('synthetic', 'uncertain', null)).state, 'uncertain');
      assert.equal((await r.run('synthetic', 'uncertain', null)).state, 'uncertain'); assert.equal(calls, 1);
    });
    await t.test('a lost effect-start commit acknowledgement reports uncertainty without performing the action', async () => {
      const base = store(0); let lost = false, calls = 0;
      const uncertainStore = { ...base, async write(work) {
        const result = await base.write(work);
        if (!lost && (await base.read(tx => tx.query("SELECT effect_step FROM noticeos.hosted_job_occurrences WHERE occurrence='lost-ack'")))[0]?.effect_step) {
          lost = true; throw new Error('synthetic COMMIT acknowledgement lost');
        }
        return result;
      } };
      const r = make(0, definition([effect('send', async () => { calls++; return { sent: 1 }; })]), { store: uncertainStore });
      assert.equal((await r.run('synthetic', 'lost-ack', null)).state, 'uncertain'); assert.equal(calls, 0);
      assert.equal((await r.run('synthetic', 'lost-ack', null)).state, 'uncertain'); assert.equal(calls, 0);
    });
    await t.test('expired outside execution is fenced and never adopted by another worker', async () => {
      const entered = controlled(), release = controlled(); let calls = 0;
      const def = definition([effect('send', async () => { calls++; entered.release(); await release.promise; return { sent: 1 }; })]);
      const a = make(0, def), b = make(0, def); const first = own(a.run('synthetic', 'expired-effect', null)); await entered.promise;
      await admin.query("UPDATE noticeos.hosted_job_occurrences SET lease_expires_at=now()-interval '1 second' WHERE occurrence='expired-effect'");
      assert.equal((await b.run('synthetic', 'expired-effect', null)).state, 'uncertain');
      release.release(); await assert.rejects(first, { name: 'HostedJobRefused' }); assert.equal(calls, 1);
    });
    await t.test('revocation between steps prevents the next effect and resumes only after a fresh grant', async () => {
      let first = 0, second = 0;
      const r = make(0, definition([
        database('first', async () => { first++; await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=now() WHERE service_id=$1', [services[0]]); return { written: 1 }; }),
        effect('second', async () => { second++; return { sent: 1 }; }),
      ]));
      assert.equal((await r.run('synthetic', 'revoked-mid-run', null)).state, 'blocked'); assert.equal(first, 1); assert.equal(second, 0);
      await assert.rejects(r.run('synthetic', 'revoked-mid-run', null));
      await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=NULL WHERE service_id=$1', [services[0]]);
      assert.equal((await r.run('synthetic', 'revoked-mid-run', null)).state, 'succeeded'); assert.equal(first, 1); assert.equal(second, 1);
    });
    await t.test('suspension and protected grants deny before job registration', async () => {
      let calls = 0; const r = make(1, definition([effect('send', async () => { calls++; return true; })]));
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [workspaces[1]]);
      await assert.rejects(r.run('synthetic', 'suspended', null));
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspaces[1]]);
      await admin.query("UPDATE noticeos_platform.workspace_service_grants SET actions=ARRAY['workflows.run','platform.maintain'] WHERE service_id=$1", [services[1]]);
      await assert.rejects(r.run('synthetic', 'protected', null)); assert.equal(calls, 0);
      await admin.query("UPDATE noticeos_platform.workspace_service_grants SET actions=ARRAY['workflows.run','assets.write','tasks.write'] WHERE service_id=$1", [services[1]]);
    });
    await t.test('bad and oversized input never enters durable state', async () => {
      const r = make(0, definition([database('record', async () => true)]));
      const cycle = {}; cycle.self = cycle;
      for (const value of [undefined, NaN, new Date(), cycle, 'x'.repeat(16_385), Object.defineProperty({}, 'x', { get() { throw new Error('getter'); } })]) {
        await assert.rejects(r.run('synthetic', 'bad-input', value));
      }
      assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos.hosted_job_occurrences WHERE occurrence='bad-input'")).rows[0].n, 0);
    });
    await t.test('failed database retries stop at the fixed attempt bound', async () => {
      let calls = 0; const r = make(0, definition([database('fail', async () => { calls++; throw new Error('private'); })]));
      for (let i = 1; i <= 5; i++) { const out = await r.run('synthetic', 'attempt-bound', null); assert.equal(out.state, 'retryable'); assert.equal(out.attempt, i); }
      assert.equal((await r.run('synthetic', 'attempt-bound', null)).state, 'exhausted'); assert.equal(calls, 5);
    });
    await t.test('close cancels an owned effect, awaits cleanup, and forbids future work', async () => {
      const entered = controlled(); let cleaned = false;
      const r = make(0, definition([effect('cancellable', async ({ signal }) => {
        entered.release(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); cleaned = true; throw new Error('cancelled');
      })]));
      const running = own(r.run('synthetic', 'cancelled', null)); await entered.promise;
      const closed = r.close(); assert.equal(r.close(), closed); await closed;
      assert.ok(cleaned); assert.equal((await running).state, 'uncertain'); await assert.rejects(r.run('synthetic', 'after-close', null));
    });
  } finally {
    for (const barrier of barriers) barrier.release();
    // Some runs deliberately reject in the assertions above. Drain them while
    // closing the runners; a cleanup failure itself must still fail the test.
    await Promise.all([Promise.allSettled(pending), Promise.all(runners.map(r => r.close()))]);
    await Promise.all(stores.map(s => s.close()));
    await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});
