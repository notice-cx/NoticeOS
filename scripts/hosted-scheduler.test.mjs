import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { findPostgres, PostgresUnavailable, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { startHostedScheduler } from './hosted-scheduler.mjs';
import { SCHEDULED_JOBS, jobRunName } from './scheduled-jobs.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';
import { bundleWorkerFixture, Miniflare } from './worker-entry-test-fixture.mjs';
import { IDENTITY_NAMES } from '../packages/postgres/src/identity.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { Cron } from 'croner';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const { betterAuth } = await import(require.resolve('better-auth/minimal'));
const { organization } = await import(require.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(require.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(require.resolve('kysely'));
const build = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'))('esbuild').build;
const latch = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test('hosted schedules dispatch and publish evidence separately for two customers and a simulator', { timeout: 180000 }, async t => {
  let tools;
  try { tools = findPostgres(); } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') return t.skip(error.message);
    throw error;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-schedules-'));
  let owner, admin, closeAdmin, closeIdentity, runtime;
  const schedulers = [], resources = [], pending = [], barriers = [];
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
    const saved = index => ({ schedules: { counters: { enabled: true, cron: `${index} * * * *` } } });
    for (const [i, id] of workspaces.entries()) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, `generated-${i}`]);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'example.test','example.test','Generated asset','live',1)", [id]);
      await admin.query("INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [services[i], id, ['workflows.run', 'assets.write', 'tasks.write']]);
      await admin.query("INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,'constants',$2,1,now(),'fixture')", [id, saved(i)]);
    }
    // The ordinary Worker entry reads the same journal written by this native
    // scheduler. Browser authority is real maintained identity, not a mock.
    const identityPassword = randomBytes(32).toString('base64url');
    await admin.query(`ALTER ROLE noticeos_identity LOGIN PASSWORD '${identityPassword}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const identityUrl = new URL(appUrl); identityUrl.username = 'noticeos_identity'; identityUrl.password = identityPassword;
    const identityPool = new Pool({ connectionString: identityUrl.href, max: 1 });
    closeIdentity = trackFixturePool(identityPool);
    const browserProof = process.env.NOTICEOS_TEST_HOSTED_SCHEDULER_BROWSER === '1';
    const origin = browserProof ? 'http://127.0.0.1:6748' : 'https://fixture.example.test';
    const secret = randomBytes(48).toString('base64url');
    const engine = betterAuth({
      database: kyselyAdapter(new Kysely({ dialect: new PostgresDialect({ pool: identityPool }) }).withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } },
      plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })],
    });
    const signup = await engine.handler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Generated operator', email: 'person@example.test', password: randomBytes(24).toString('base64url') }) }));
    assert.equal(signup.status, 200);
    const person = (await signup.json()).user;
    await identityPool.query('UPDATE noticeos_identity.auth_user SET email_verified=true WHERE id=$1', [person.id]);
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const session = (await engine.api.getSession({ headers: new Headers({ cookie }) })).session.id;
    for (const [index, id] of workspaces.entries()) {
      await identityPool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [id, `generated-${index}`]);
      if (index < 2) await identityPool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'viewer',now())", [randomUUID(), id, person.id]);
    }
    const tower = await bundleWorkerFixture(root, 'tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts'));
    const ingest = browserProof ? await bundleWorkerFixture(root, 'ingest', path.join(REPO_ROOT, 'workers/ingest/src/index.ts')) : null;
    const common = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
      NOTICEOS_WORKSPACE_DATABASE_URL: appUrl, NOTICEOS_IDENTITY_DATABASE_URL: identityUrl.href, NOTICEOS_IDENTITY_SESSION_SECRET: secret };
    let outside = 0;
    const denyOutside = async () => { outside++; throw new Error('No outside requests in scheduler fixture'); };
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, compatibilityDate: '2026-07-06', serviceBindings: { TOWER: 'tower', DEMO: 'demo' }, outboundService: denyOutside,
        script: 'export default {async fetch(request,env) {const a=await request.json();return env[a.target].fetch(new Request(a.url,a.init));}};' },
      { name: 'tower', ...tower, bindings: common, ...(ingest ? { serviceBindings: { INGEST: 'ingest' } } : {}), outboundService: denyOutside },
      { name: 'demo', ...tower, bindings: { ...common, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: workspaces[2] }, ...(ingest ? { serviceBindings: { INGEST: 'demo-ingest' } } : {}), outboundService: denyOutside },
      ...(ingest ? [
        { name: 'ingest', ...ingest, bindings: common, outboundService: denyOutside },
        { name: 'demo-ingest', ...ingest, bindings: { ...common, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: workspaces[2] }, outboundService: denyOutside },
      ] : []),
    ] });
    const entry = async (index, suffix = '', extra = {}) => {
      const response = await runtime.dispatchFetch('https://fixture-driver/', { method: 'POST', body: JSON.stringify({
        target: index === 2 ? 'DEMO' : 'TOWER', url: origin + '/api/workflows' + suffix,
        init: { headers: index === 2 ? {} : { cookie, origin, [WORKSPACE_SELECTION_HEADER]: workspaces[index], [WORKSPACE_SESSION_HEADER]: session }, ...extra },
      }) });
      const body = response.body === null ? null : await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    };
    // This is the real stored-history module with a real workspace store. The
    // separate Worker entry proof verifies browser admission and transport.
    const readerPath = path.join(root, 'workflow-read.mjs');
    await build({ entryPoints: [path.join(REPO_ROOT, 'apps/tower/worker/hosted-workflow-read.ts')], outfile: readerPath,
      bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
    const { handleHostedWorkflowRead } = await import(pathToFileURL(readerPath).href);
    const store = index => { const s = openWorkspaceStore(appUrl, { workspaceId: workspaces[index] }); resources.push(s); return s; };
    const read = async (index, suffix = '', now = Date.now()) => {
      const s = store(index);
      try { return await (await handleHostedWorkflowRead(new Request('https://fixture.example.test/api/workflows' + suffix), s, now)).json(); }
      finally { await s.close(); }
    };
    let failOnce = false;
    const definition = index => ({ key: 'counters', version: 'v1', parseInput(value) {
      assert.deepEqual(Object.keys(value), ['scheduledAt']); assert.ok(Number.isFinite(Date.parse(value.scheduledAt))); return value;
    }, steps: [{ key: 'record', kind: 'database', action: 'assets.write', async run({ context, occurrence, input }, tx) {
      assert.equal(context.workspaceId, workspaces[index]); assert.equal(context.principalId, services[index]);
      assert.equal(occurrence, input.scheduledAt);
      await tx.execute(`INSERT INTO noticeos.counter_readings(workspace_id,asset_id,metric,value,observed_at)
        VALUES($1::uuid,'example.test','scheduled',1,now()) ON CONFLICT(workspace_id,asset_id,metric)
        DO UPDATE SET value=noticeos.counter_readings.value+1`, [tx.workspaceId]);
      if (index === 0 && failOnce) { failOnce = false; throw new Error('generated private database failure'); }
      return { written: index + 1, token: 'generated-private-output' };
    } }] });
    const binding = (index, def = definition(index), overrides = {}) => {
      const grant = openWorkspaceServiceGrant({ connectionString: serviceUrl.href, principalId: services[index], workspaceId: workspaces[index] });
      resources.push(grant);
      return { workspaceId: workspaces[index], serviceId: services[index], store: store(index), grant, definitions: [def], ...overrides };
    };
    let now = Date.now(); const timers = [];
    const createTimer = (cron, callback, timezone) => {
      assert.match(cron, /^[012] \* \* \* \*$/u); assert.equal(timezone, 'UTC');
      const timer = { workspace: Number(cron[0]), callback, stopped: false, stop() { this.stopped = true; }, nextRun() { return new Date(now + 60000); } };
      timers.push(timer); return timer;
    };
    // Settings reads are concurrent. Timer registration order is deliberately
    // not treated as workspace identity; each fixture schedule identifies it.
    const tick = index => timers.findLast(timer => timer.workspace === index && !timer.stopped).callback();
    const start = async selected => { const scheduler = await startHostedScheduler(selected, { now: () => now, createTimer }); schedulers.push(scheduler); return scheduler; };
    const count = async index => Number((await admin.query("SELECT value FROM noticeos.counter_readings WHERE workspace_id=$1 AND metric='scheduled'", [workspaces[index]])).rows[0]?.value ?? 0);
    const job = jobRunName(SCHEDULED_JOBS.find(job => job.id === 'counters'));
    let composed;

    await t.test('same timer slot writes three distinct histories and one ordinary feed outcome per workspace', async () => {
      composed = await start(workspaces.map((_, i) => binding(i)));
      assert.equal(timers.length, 3);
      await Promise.all(timers.map(timer => timer.callback()));
      await Promise.all(timers.map(timer => timer.callback()));
      for (let i = 0; i < 3; i++) {
        assert.equal(await count(i), 1);
        const payload = await read(i);
        assert.deepEqual(payload.runtime.registeredJobs, ['counters']);
        assert.equal(payload.runtime.onlyListedJobs, true); assert.equal(payload.runtimeFresh, true);
        assert.equal(payload.workflows.length, 1); assert.equal(payload.workflows[0].runs.length, 1);
        assert.equal(payload.workflows[0].latest.state, 'succeeded');
        const selected = await read(i, '?run=' + encodeURIComponent(payload.workflows[0].latest.id));
        assert.equal(selected.selectedRun.steps[0].output.metrics[0].value, i + 1);
        assert.equal(JSON.stringify(selected).includes('generated-private-output'), false);
        const actual = await entry(i, '?run=' + encodeURIComponent(payload.workflows[0].latest.id));
        assert.equal(actual.status, 200);
        const browserPayload = await actual.json();
        assert.equal(browserPayload.selectedRun.steps[0].output.metrics[0].value, i + 1);
        assert.deepEqual(browserPayload.runtime.registeredJobs, ['counters']);
        assert.equal(browserPayload.runtimeFresh, true);
        const s = store(i);
        const statuses = await s.read(tx => tx.query('SELECT workspace_id::text FROM noticeos.hosted_scheduler_status'));
        assert.deepEqual(statuses, [{ workspace_id: workspaces[i] }]);
        await s.close();
      }
      const rows = (await admin.query('SELECT workspace_id::text,job,outcome FROM noticeos.job_runs ORDER BY workspace_id')).rows;
      assert.equal(rows.length, 3); assert.ok(rows.every(row => row.job === job && row.outcome === 'ran'));
      assert.equal(new Set(rows.map(row => row.workspace_id)).size, 3);
    });
    await t.test('ordinary Worker history refuses revoked people, stale sessions and foreign demo selectors', async () => {
      await identityPool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [workspaces[0], person.id]);
      assert.equal((await entry(0)).status, 403);
      assert.equal((await entry(1)).status, 200);
      assert.equal((await entry(2)).status, 200);
      assert.equal((await entry(2, '', { headers: { cookie, [WORKSPACE_SELECTION_HEADER]: workspaces[0], [WORKSPACE_SESSION_HEADER]: session } })).status, 403);
      assert.equal((await entry(1, '', { headers: { cookie, origin, [WORKSPACE_SELECTION_HEADER]: workspaces[1], [WORKSPACE_SESSION_HEADER]: randomUUID() } })).status, 403);
      await identityPool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'viewer',now())", [randomUUID(), workspaces[0], person.id]);
      for (const index of [0, 1, 2]) assert.equal((await entry(index, '', { method: 'POST' })).status, 403);
      assert.equal(outside, 0);
    });
    await t.test('an active owner excludes a competing timer composition and foreign stores', async () => {
      const before = timers.length;
      await assert.rejects(start([binding(0)]), { name: 'HostedScheduleRefused' });
      await assert.rejects(start([binding(0, definition(0), { store: store(1) })]), { name: 'HostedScheduleRefused' });
      assert.equal(timers.length, before);
      assert.equal((await read(0)).runtimeFresh, true);
    });
    await t.test('revoked services and suspended workspaces stop new ticks without suppressing other workspaces', async () => {
      now += 60000;
      await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=now() WHERE service_id=$1', [services[0]]);
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [workspaces[2]]);
      await Promise.all(timers.slice(0, 3).map(timer => timer.callback()));
      assert.deepEqual(await Promise.all(workspaces.map((_, i) => count(i))), [1, 2, 1]);
      await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=NULL WHERE service_id=$1', [services[0]]);
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspaces[2]]);
      await Promise.all([tick(0), tick(2)]);
      assert.deepEqual(await Promise.all(workspaces.map((_, i) => count(i))), [2, 2, 2], JSON.stringify({
        status: (await admin.query('SELECT workspace_id,session_id,running,observed_at FROM noticeos.hosted_scheduler_status')).rows,
        attempts: (await admin.query('SELECT workspace_id,occurrence,state,attempt FROM noticeos.hosted_job_occurrences')).rows,
      }));
    });
    await t.test('retry commits a rolled-back step once and records each attempt without duplicate feed outcomes', async () => {
      now += 60000; failOnce = true;
      await tick(0); assert.equal(await count(0), 2);
      await tick(0); assert.equal(await count(0), 3);
      await tick(0); assert.equal(await count(0), 3);
      const rows = (await admin.query('SELECT outcome,detail FROM noticeos.job_runs WHERE workspace_id=$1 AND job=$2 ORDER BY started_at', [workspaces[0], job])).rows;
      assert.deepEqual(rows.map(row => row.outcome), ['ran', 'ran', 'failed', 'ran']);
      assert.equal(rows[2].detail, 'hosted:retryable');
      const view = await read(0);
      assert.equal(view.workflows[0].runs.length, 4);
      const previous = view.workflows[0].runs.find(row => row.state === 'failed');
      const selected = await read(0, '?run=' + encodeURIComponent(previous.id));
      assert.equal(selected.selectedRun.steps, null, 'an earlier attempt never inherits the retry checkpoints');
    });
    await t.test('stale timer ownership refuses dispatch and missing first settings keeps past registered history visible', async () => {
      now += 60000;
      await admin.query("UPDATE noticeos.hosted_scheduler_status SET observed_at=now()-interval '1 minute' WHERE workspace_id=$1", [workspaces[0]]);
      await tick(0); assert.equal(await count(0), 3);
      await composed.refresh(); await tick(0); assert.equal(await count(0), 4);
      await composed.close(); assert.ok(timers.slice(0, 3).every(timer => timer.stopped));
      await admin.query("DELETE FROM noticeos.config_documents WHERE workspace_id=$1 AND document_key='constants'", [workspaces[0]]);
      const before = timers.length;
      const waiting = await start([binding(0)]);
      assert.equal(timers.length, before);
      const view = await read(0);
      assert.equal(view.runtime.error, 'waiting'); assert.deepEqual(view.runtime.jobs, []);
      assert.equal(view.workflows.length, 1); assert.equal(view.workflows[0].runs.length, 5);
      await waiting.close();
      await admin.query("INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,'constants',$2,1,now(),'fixture')", [workspaces[0], saved(0)]);
    });
    await t.test('retry history preserves the original attempt of each committed checkpoint', async () => {
      let fail = true;
      const base = definition(0);
      const scheduler = await start([binding(0, { ...base, version: 'checkpoint-attempts', steps: [
        { ...base.steps[0], key: 'first' },
        { key: 'second', kind: 'database', action: 'assets.write', async run() {
          if (fail) { fail = false; throw new Error('Generated second-step failure'); }
          return { written: 2 };
        } },
      ] })]);
      try {
        now += 60000;
        const before = await count(0);
        await tick(0); await tick(0);
        assert.equal(await count(0), before + 1, 'committed first step is not repeated');
        const latest = (await read(0)).workflows[0].latest.id;
        const response = await entry(0, '?run=' + encodeURIComponent(latest));
        assert.equal(response.status, 200);
        const selected = (await response.json()).selectedRun;
        assert.deepEqual(selected.steps.map(step => [step.id, step.attempt]), [['first', 1], ['second', 2]]);
        assert.ok(Date.parse(selected.steps[0].finishedAt) <= Date.parse(selected.steps[1].startedAt));
      } finally { await scheduler.close(); }
    });
    await t.test('close reports failed status publication after cancelling work and closing both resources', async () => {
      const entered = latch(); barriers.push(entered); let cleaned = false, stoppedStore = false, stoppedGrant = false, denyWrite = false;
      const item = binding(0, { ...definition(0), version: 'cancel', steps: [{ key: 'deliver', kind: 'effect', action: 'tasks.write', async run({ signal }) {
        entered.release(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); cleaned = true; throw new Error('fixture interrupted');
      } }] });
      const base = item.store, grant = item.grant;
      item.store = { ...base, write(work) { if (denyWrite) return Promise.reject(new Error('fixture status unavailable')); return base.write(work); },
        async close() { await base.close(); stoppedStore = true; } };
      item.grant = { ...grant, async close() { await grant.close(); stoppedGrant = true; } };
      now += 60000;
      const scheduler = await start([item]);
      const running = timers.at(-1).callback(); pending.push(running); await entered.promise;
      denyWrite = true;
      const closing = scheduler.close(); assert.equal(scheduler.close(), closing);
      await assert.rejects(closing, { name: 'HostedScheduleRefused' }); await running;
      assert.ok(cleaned); assert.ok(stoppedStore); assert.ok(stoppedGrant); assert.ok(timers.at(-1).stopped);
    });
    await t.test('unknown and platform lanes cannot open scheduler ownership', async () => {
      const before = Number((await admin.query('SELECT count(*)::int n FROM noticeos.hosted_job_occurrences')).rows[0].n);
      for (const key of ['unknown-lane', 'postgres-backup', 'dolt-backup', 'platform-maintenance']) {
        await assert.rejects(start([binding(1, { ...definition(1), key })]), { name: 'HostedScheduleRefused' });
      }
      assert.equal(Number((await admin.query('SELECT count(*)::int n FROM noticeos.hosted_job_occurrences')).rows[0].n), before);
    });
    await t.test('real clock tick reaches the ordinary browser history in each customer and the read-only demo', {
      skip: !browserProof, timeout: 120000,
    }, async () => {
      const { seedBrowserSettings, proveHostedWorkflowBrowser } = await import('./test-fixtures/hosted-workflow-browser.mjs');
      await seedBrowserSettings(admin, workspaces);
      // The preceding failure control intentionally could not publish stopped.
      // Expire only this disposable fixture's owner before the new composition.
      await admin.query("UPDATE noticeos.hosted_scheduler_status SET observed_at=now()-interval '1 minute'");
      const completions = new Set(), completed = latch();
      const realTimers = [];
      const before = await Promise.all(workspaces.map((_, index) => count(index)));
      const scheduler = await startHostedScheduler(workspaces.map((_, index) => {
        const def = definition(index);
        return binding(index, { ...def, key: 'freshness', steps: [{ ...def.steps[0], key: 'freshness' }] });
      }), { createTimer(cron, callback, timezone) {
        assert.equal(cron, '* * * * *'); assert.equal(timezone, 'UTC');
        const identity = realTimers.length;
        const timer = new Cron(cron, { timezone }, async () => {
          await callback(); completions.add(identity);
          if (completions.size === 3) completed.release();
        });
        realTimers.push(timer); return timer;
      } });
      schedulers.push(scheduler);
      // Await actual Cron callbacks, not elapsed sleeps or manual dispatch.
      await completed.promise;
      assert.deepEqual(await Promise.all(workspaces.map((_, index) => count(index))), before.map(value => value + 1));
      const runs = await Promise.all(workspaces.map(async (_, index) => {
        const response = await entry(index); assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.workflows[0].latest.state, 'succeeded');
        return payload.workflows[0].latest.id;
      }));
      assert.equal(new Set(runs).size, 1, 'identical lane/occurrence IDs are scoped by workspace');
      await proveHostedWorkflowBrowser({ runtime, origin, cookie, workspaces, runs });
      assert.equal(outside, 0);
      await scheduler.close();
      assert.ok(realTimers.every(timer => !timer.isRunning()));
    });
  } finally {
    for (const barrier of barriers) barrier.release();
    await Promise.allSettled(schedulers.map(scheduler => scheduler.close()));
    await Promise.allSettled(pending);
    await Promise.allSettled(resources.map(resource => resource.close()));
    await runtime?.dispose();
    await closeIdentity?.(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});
