import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture, Miniflare } from './worker-entry-test-fixture.mjs';
import { IDENTITY_NAMES, openIdentity } from '../packages/postgres/src/identity.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { recordMutation } from '../packages/postgres/src/mutation-audit.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const { betterAuth } = await import(require.resolve('better-auth/minimal'));
const { organization } = await import(require.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(require.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(require.resolve('kysely'));

test('asset and finding audit is atomic, immutable and current-person scoped in native and ordinary Worker', { timeout: 90000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-mutation-'));
  let owner, admin, enginePool, runtime, reader, nativeStore, primaryError;
  const clients = [];
  try {
    const bundle = await bundleWorkerFixture(root, 'mutation-audit', path.join(REPO_ROOT, 'scripts/test-fixtures/mutation-audit-worker.mjs'));
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    const oldDirectory = path.join(root, 'old-migrations'); mkdirSync(oldDirectory);
    for (const name of readdirSync(path.join(REPO_ROOT, 'db/postgres/migrations')).filter(name => /^000[1-9]_|^0010_/u.test(name))) {
      copyFileSync(path.join(REPO_ROOT, 'db/postgres/migrations', name), path.join(oldDirectory, name));
    }
    applyMigrations(owner, { dir: oldDirectory });
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    const a = randomUUID(), b = randomUUID(), origin = 'https://audit.example.test';
    for (const [id, label] of [[a, 'first'], [b, 'second']]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, label]);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status) VALUES($1,'example.test',$2,'live'),($1,'target.test','Target','live')", [id, label]);
      await admin.query("INSERT INTO noticeos.annotations(workspace_id,asset_id,at,kind,note) VALUES($1,'example.test',now(),'deploy','historical unknown')", [id]);
    }
    assert.deepEqual(applyMigrations(owner).applied, ['0011_workspace_mutation_audit']);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM noticeos.workspace_mutation_audit')).rows[0].n, 0);
    const appUrl = owner.applicationLogin().url();
    const runtimeRole = async role => {
      const secret = randomBytes(24).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${secret}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(appUrl); url.username = role; url.password = secret;
      const pool = new Pool({ connectionString: url.href, max: 2 }); clients.push(pool);
      return { pool, url: url.href };
    };
    const identity = await runtimeRole('noticeos_identity'), maint = await runtimeRole('noticeos_maint');
    const secret = randomBytes(48).toString('base64url');
    enginePool = new Pool({ connectionString: identity.url, max: 2 });
    // Password signup exists only in this generated identity fixture. Production
    // login stays invite-bound email code; the cookie is maintained-library signed.
    const engine = betterAuth({
      database: kyselyAdapter(new Kysely({ dialect: new PostgresDialect({ pool: enginePool }) }).withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } },
      plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })],
    });
    const people = [];
    for (const [workspace, email] of [[a, 'first@example.test'], [b, 'second@example.test']]) {
      const signup = await engine.handler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Generated actor', email, password: randomBytes(24).toString('base64url') }) }));
      assert.equal(signup.status, 200);
      const person = (await signup.json()).user;
      const cookie = signup.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      const session = (await engine.api.getSession({ headers: new Headers({ cookie }) })).session.id;
      await enginePool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [workspace, `identity-${workspace}`]);
      await enginePool.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'operator',now())", [randomUUID(), workspace, person.id]);
      people.push({ workspace, person: person.id, cookie, session });
    }
    nativeStore = openStore(appUrl);
    reader = await openIdentity({ connectionString: identity.url, sessionSecret: secret, trustedOrigin: origin });
    const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: (headers, workspace) => reader.admissionMembership(headers, workspace) });
    const proof = person => new Request(origin + '/audit', { method: 'POST', headers: {
      origin, cookie: person.cookie, [WORKSPACE_SELECTION_HEADER]: person.workspace, [WORKSPACE_SESSION_HEADER]: person.session,
    } });
    const actorOf = facts => Object.freeze({ workspaceId: facts.workspaceId, principalId: facts.principalId, sessionId: facts.sessionId });
    const nativeActor = Object.freeze({ workspaceId: a, principalId: people[0].person, sessionId: people[0].session });
    const auditRows = async workspace => nativeStore.inWorkspace(workspace, tx => tx.query(`SELECT actor_kind,actor_person_id,actor_session_id,event,asset_id,subject
      FROM noticeos.workspace_mutation_audit ORDER BY mutation_id`), { readOnly: true });

    await t.test('native current signed principals and unknown standalone evidence have exact atomic scope', async () => {
      for (const person of people) await admission.withAdmission('assets.write', { requestedWorkspaceId: person.workspace, correlationId: 'native-audit' }, proof(person),
        facts => nativeStore.inWorkspace(facts.workspaceId, async tx => {
          await tx.execute("UPDATE noticeos.assets SET sense_only=false WHERE asset_id='example.test'");
          await recordMutation(tx, actorOf(facts), { event: 'asset.column', assetId: 'example.test', subject: { column: 'sense_only' } });
        }));
      for (const person of people) {
        const [row] = await auditRows(person.workspace);
        assert.equal(row.actor_person_id, person.person); assert.equal(row.actor_session_id, person.session);
        assert.equal(row.actor_kind, 'person'); assert.equal(row.asset_id, 'example.test');
      }
      await nativeStore.inWorkspace(a, async tx => {
        await tx.execute("INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status) VALUES($1,'native-unknown.test','Unknown actor','live')", [a]);
        await recordMutation(tx, null, { event: 'asset.create', assetId: 'native-unknown.test', subject: {} });
      });
      const last = (await auditRows(a)).at(-1); assert.equal(last.actor_kind, 'unknown');
      assert.equal(last.actor_person_id, null); assert.equal(last.actor_session_id, null);
    });
    await t.test('actual app/identity/maintenance grants, forced RLS and immutable history refuse changes', async () => {
      const privileges = (await admin.query(`SELECT has_table_privilege('noticeos_app','noticeos.workspace_mutation_audit','INSERT') AS app_insert,
        has_table_privilege('noticeos_identity','noticeos.workspace_mutation_audit','INSERT') AS identity_insert,
        has_table_privilege('noticeos_maint','noticeos.workspace_mutation_audit','INSERT') AS maint_insert,
        has_table_privilege('noticeos_app','noticeos.workspace_mutation_audit','UPDATE,DELETE,TRUNCATE') AS app_change`)).rows[0];
      assert.deepEqual(privileges, { app_insert: true, identity_insert: false, maint_insert: false, app_change: false });
      await assert.rejects(identity.pool.query("INSERT INTO noticeos.workspace_mutation_audit(workspace_id,actor_kind,event,asset_id,subject) VALUES($1,'unknown','asset.create','example.test','{}')", [a]), { code: '42501' });
      await assert.rejects(maint.pool.query("INSERT INTO noticeos.workspace_mutation_audit(workspace_id,actor_kind,event,asset_id,subject) VALUES($1,'unknown','asset.create','example.test','{}')", [a]), { code: '42501' });
      await assert.rejects(nativeStore.inWorkspace(a, tx => tx.execute('UPDATE noticeos.workspace_mutation_audit SET event=event')), /permission denied/);
      await assert.rejects(nativeStore.inWorkspace(a, tx => tx.execute('DELETE FROM noticeos.workspace_mutation_audit')), /permission denied/);
      await assert.rejects(nativeStore.inWorkspace(a, tx => tx.execute('TRUNCATE noticeos.workspace_mutation_audit')), /permission denied/);
      assert.equal((await nativeStore.inWorkspace(a, tx => tx.query('SELECT count(*)::int AS n FROM noticeos.workspace_mutation_audit WHERE workspace_id=$1', [b])))[0].n, 0);
      await assert.rejects(nativeStore.inWorkspace(a, tx => tx.execute("INSERT INTO noticeos.workspace_mutation_audit(workspace_id,actor_kind,event,asset_id,subject) VALUES($1,'unknown','asset.create','example.test','{}')", [b])), /row-level security/);
      await assert.rejects(admin.query('UPDATE noticeos.workspace_mutation_audit SET event=event'), /records are immutable/);
      await assert.rejects(admin.query('DELETE FROM noticeos.workspace_mutation_audit'), /records are immutable/);
    });
    await t.test('invalid or failed audit rolls back its effect; failed effects mint no audit', async () => {
      const before = await auditRows(a);
      await assert.rejects(nativeStore.inWorkspace(a, async tx => {
        await tx.execute("UPDATE noticeos.assets SET display_name='Must roll back' WHERE asset_id='example.test'");
        await recordMutation(tx, { ...nativeActor, workspaceId: b }, { event: 'asset.column', assetId: 'example.test', subject: { column: 'display_name' } });
      }), /facts are invalid/);
      await assert.rejects(nativeStore.inWorkspace(a, async tx => {
        await recordMutation(tx, nativeActor, { event: 'asset.column', assetId: 'example.test', subject: { column: 'status' } });
        await tx.execute("UPDATE noticeos.assets SET status='invalid' WHERE asset_id='example.test'");
      }), /check constraint/);
      assert.deepEqual(await auditRows(a), before);
      assert.equal((await nativeStore.inWorkspace(a, tx => tx.query("SELECT display_name FROM noticeos.assets WHERE asset_id='example.test'")))[0].display_name, 'first');
    });
    let outside = 0, beforeEffect;
    runtime = new Miniflare({ ...bundle, bindings: { APP_URL: appUrl, IDENTITY_URL: identity.url, SECRET: secret, ORIGIN: origin },
      serviceBindings: { BEFORE_EFFECT: async () => { if (beforeEffect) await beforeEffect(); return new Response(null, { status: 204 }); } },
      outboundService: async () => { outside++; throw new Error('Outside HTTP forbidden'); } });
    const send = async (person, operation, input, changes = {}) => {
      const request = proof(person); const headers = new Headers(request.headers); headers.set('content-type', 'application/json');
      for (const [key, value] of Object.entries(changes)) headers.set(key, value);
      const response = await runtime.dispatchFetch(origin + '/audit', { method: 'POST', headers, body: JSON.stringify({ operation, input }) });
      return { status: response.status, value: await response.json() };
    };
    await t.test('an actual audit INSERT denial rolls back the released writer effect', async () => {
      const before = await auditRows(a);
      await admin.query('REVOKE INSERT ON noticeos.workspace_mutation_audit FROM noticeos_app');
      try {
        assert.equal((await send(people[0], 'column', {
          asset: 'example.test', column: 'display_name', value: 'Must roll back after audit denial',
        })).status, 403);
      } finally {
        await admin.query('GRANT INSERT ON noticeos.workspace_mutation_audit TO noticeos_app');
      }
      assert.deepEqual(await auditRows(a), before);
      assert.equal((await nativeStore.inWorkspace(a, tx => tx.query("SELECT display_name FROM noticeos.assets WHERE asset_id='example.test'")))[0].display_name, 'first');
    });
    await t.test('ordinary Worker writes every family to its selected owner and no free-form value enters audit', async () => {
      for (const person of people) {
        assert.equal((await send(person, 'create', { id: 'new.test', displayName: 'Generated site' })).status, 200);
        assert.equal((await send(person, 'column', { asset: 'example.test', column: 'display_name', value: 'Generated private display', actor: randomUUID() })).status, 200);
        assert.equal((await send(person, 'move', { asset: 'example.test', to: 'target.test' })).status, 200);
        assert.equal((await send(person, 'annotation', { asset: 'example.test', kind: 'deploy', at: '2026-01-01T00:00:00Z', note: 'Generated private note', ref: 'generated-reference' })).status, 200);
        assert.equal((await send(person, 'decision', { asset: 'example.test', decision: { kind: 'finding', key: 'same-key', status: 'marked', note: 'Generated private note' } })).status, 200);
        assert.equal((await send(person, 'clear', { asset: 'example.test', kind: 'finding', key: 'same-key' })).status, 200);
        await admin.query("INSERT INTO noticeos.flags(workspace_id,asset_id,fired_at,severity,kind,metric,message,rule_id,rule_inputs) VALUES($1,'example.test',now(),'warn','anomaly','pageviews','Generated flag','poisson-drop','{}')", [person.workspace]);
        assert.equal((await send(person, 'flag', { id: 1, action: 'acknowledge' })).status, 200);
        const rows = await auditRows(person.workspace);
        for (const row of rows.filter(row => row.actor_kind === 'person')) {
          assert.equal(row.actor_person_id, person.person); assert.equal(row.actor_session_id, person.session);
          assert.ok(!row.subject.includes('Generated private') && !row.subject.includes('generated-reference'));
        }
        for (const event of ['asset.create', 'asset.column', 'asset.move', 'annotation.create', 'decision.set', 'decision.clear', 'flag.acknowledge']) {
          assert.ok(rows.some(row => row.event === event), event);
        }
      }
    });
    await t.test('concurrent identical decisions and annotations emit once; actual no-ops emit nothing', async () => {
      const person = people[0], before = await auditRows(a);
      const decision = { asset: 'example.test', decision: { kind: 'finding', key: 'race', status: 'marked' } };
      const annotation = { asset: 'example.test', kind: 'external', at: '2026-01-02T00:00:00Z', ref: 'race' };
      for (const [operation, input] of [['decision', decision], ['annotation', annotation]]) {
        const outcomes = await Promise.all([send(person, operation, input), send(person, operation, input)]);
        assert.ok(outcomes.every(outcome => outcome.status === 200));
      }
      const after = await auditRows(a); assert.equal(after.length, before.length + 2);
      assert.equal((await send(person, 'create', { id: 'new.test', displayName: 'Duplicate' })).value.ok, false);
      await send(person, 'move', { asset: 'example.test', to: 'example.test' });
      await send(person, 'clear', { asset: 'example.test', kind: 'finding', key: 'absent' });
      await send(person, 'flag', { id: 1, action: 'acknowledge' });
      assert.deepEqual(await auditRows(a), after);
      const clears = await Promise.all([send(person, 'clear', { asset: 'example.test', kind: 'finding', key: 'race' }),
        send(person, 'clear', { asset: 'example.test', kind: 'finding', key: 'race' })]);
      assert.ok(clears.every(outcome => outcome.status === 200));
      assert.equal((await auditRows(a)).length, after.length + 1);
    });
    await t.test('existing long asset, metric and rule values remain actionable without copying them', async () => {
      const assetId = 'generated-' + 'a'.repeat(180);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status) VALUES($1,$2,'Existing long asset','live')", [a, assetId]);
      await admin.query("INSERT INTO noticeos.flags(workspace_id,asset_id,fired_at,severity,kind,metric,message,rule_id,rule_inputs) VALUES($1,$2,now(),'warn','anomaly',$3,'Generated flag',$4,'{}')", [a, assetId, 'metric-'.repeat(1000), 'rule-'.repeat(1000)]);
      const before = await auditRows(a);
      const response = await send(people[0], 'flag', { id: 2, action: 'resolve' });
      assert.equal(response.status, 200);
      const after = await auditRows(a);
      assert.equal(after.length, before.length + 1);
      assert.equal(after.at(-1).asset_id, assetId);
      assert.deepEqual(JSON.parse(after.at(-1).subject), { flagNumber: 2, changedCount: 1 });
      assert.equal((await nativeStore.inWorkspace(a, tx => tx.query('SELECT resolved_at IS NOT NULL AS resolved FROM noticeos.flags WHERE flag_number=2')))[0].resolved, true);
    });
    await t.test('foreign/current-role/late-revocation refusal prevents both audit and effect', async () => {
      const person = people[0], before = await auditRows(a);
      const input = { asset: 'example.test', column: 'display_name', value: 'Must not land' };
      assert.equal((await send(person, 'column', input, { origin: 'https://foreign.example.test' })).status, 403);
      assert.equal((await send(person, 'column', input, { [WORKSPACE_SELECTION_HEADER]: b })).status, 403);
      assert.equal((await send(person, 'column', input, { [WORKSPACE_SESSION_HEADER]: randomUUID() })).status, 403);
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE user_id=$1", [person.person]);
      assert.equal((await send(person, 'column', input)).status, 403);
      await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE user_id=$1", [person.person]);
      beforeEffect = () => enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE user_id=$1', [person.person]);
      assert.equal((await send(person, 'column', input)).status, 403); beforeEffect = undefined;
      assert.deepEqual(await auditRows(a), before);
      assert.equal((await nativeStore.inWorkspace(a, tx => tx.query("SELECT display_name FROM noticeos.assets WHERE asset_id='example.test'")))[0].display_name, 'Generated private display');
      assert.equal(outside, 0);
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const failures = [];
    for (const cleanup of [() => runtime?.dispose(), () => reader?.close(), () => nativeStore?.close(),
      ...clients.map(pool => () => pool.end()), () => enginePool?.end(), () => admin?.end(), () => owner?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (existsSync(path.join(root, 'pg/data/postmaster.pid'))) failures.push(new Error('Owned Postgres PID marker remains'));
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, 'Mutation audit fixture retirement refused');
    rmSync(root, { recursive: true });
  }
});
